/**
 * p5.comfyui-helper
 * (c) Gottfried Haider 2024
 * LGPL
 * https://github.com/gohai/p5.comfyui-helper
 */

"use strict";

class ComfyUiP5Helper {
  /**
   * @param base_url  the URL of a local ComfyUI instance, or of a CORS proxy
   *                  in front of Comfy Cloud (see proxy/ in this repository)
   * @param api_key   a Comfy Cloud API key from https://platform.comfy.org --
   *                  passing one switches the client to the cloud API
   */
  constructor(base_url, api_key) {
    this.base_url = base_url.replace(/\/$/, ""); // strip any trailing slash
    this.api_key = api_key;
    // an api_key is only ever needed for cloud, so its presence is what
    // switches the endpoint shapes below; this also lets base_url point at a
    // CORS proxy instead of cloud.comfy.org directly (browsers calling
    // cloud.comfy.org's API directly are blocked by CORS, see proxy/)
    this.is_cloud = !!this.api_key;
    if (/^https?:\/\/cloud\.comfy\.org(:|\/|$)/i.test(this.base_url) && !this.api_key) {
      throw new Error(
        "An API key is required when using cloud.comfy.org as the base_url. Get one at https://platform.comfy.org"
      );
    }
    // cloud exposes the same functionality under an /api prefix
    this.api_prefix = this.is_cloud ? "/api" : "";

    // prompt_id -> { callback, status_callback, resolve, reject, outputs, object_urls }
    this.running_prompts = {};
    // filename -> true while an upload is in flight
    this.running_uploads = {};
    // filename -> Error, for uploads that failed
    this.upload_errors = {};
    // filename we made up -> filename the server stored it under
    this.uploaded_filenames = {};
    // blob: URLs of finished runs, revoked when the next run starts
    this.completed_object_urls = [];

    this.closed = false;
    this.reconnect_attempts = 0;
    this.setup_websocket();
  }

  /**
   * Closes the WebSocket and stops reconnecting. Any workflow still running
   * is rejected. Call this before discarding a helper, otherwise its socket
   * keeps reconnecting in the background for the lifetime of the page.
   */
  close() {
    this.closed = true;
    clearTimeout(this.reconnect_timer);
    for (const prompt_id of Object.keys(this.running_prompts)) {
      this.fail_prompt(prompt_id, new Error("Connection closed"));
    }
    this.revoke_completed_object_urls();
    try {
      this.ws.close();
    } catch (e) {
      // already closed
    }
  }

  generate_id() {
    if (typeof crypto !== "undefined" && crypto.randomUUID) {
      return crypto.randomUUID();
    }
    return Math.random().toString(36).substring(2);
  }

  build_url(path) {
    return this.base_url + this.api_prefix + path;
  }

  build_headers(extra) {
    const headers = extra ? { ...extra } : {};
    if (this.is_cloud) {
      headers["X-API-Key"] = this.api_key;
    }
    return headers;
  }

  /**
   * fetch() against the Comfy API, with authentication and error handling.
   */
  async request(path, options = {}) {
    const { headers, ...rest } = options;
    const res = await fetch(this.build_url(path), {
      ...rest,
      headers: this.build_headers(headers),
      redirect: "follow",
    });
    if (!res.ok) {
      throw new Error(await this.error_message(res));
    }
    return res;
  }

  /**
   * Turns an error response into something readable, without assuming the
   * body is JSON (a proxy or gateway in between might return HTML).
   */
  async error_message(res) {
    let data;
    try {
      data = await res.json();
    } catch (e) {
      return "Status " + res.status;
    }
    if (data?.error) {
      // local ComfyUI's validation errors
      return (
        data.error.type + ": " + data.error.message + " (" + data.error.details + ")"
      );
    } else if (data?.message) {
      // cloud errors, e.g. insufficient credits or an inactive subscription
      return "Status " + res.status + ": " + data.message;
    }
    return "Status " + res.status;
  }

  setup_websocket() {
    // note the WebSocket lives at /ws, without the /api prefix the REST
    // endpoints use -- that is what Comfy Cloud documents
    let ws_url = this.base_url + "/ws";
    if (this.is_cloud) {
      // cloud authenticates the socket via a token query param (browsers
      // can't set headers on a WebSocket handshake); clientId is currently
      // ignored by cloud (all of a user's connections receive the same
      // messages), but is passed along for forward compatibility
      this.ws_client_id = this.generate_id();
      ws_url += "?clientId=" + this.ws_client_id + "&token=" + encodeURIComponent(this.api_key);
    }
    this.ws = new WebSocket(ws_url);
    this.ws.addEventListener("open", this.websocket_on_open.bind(this));
    this.ws.addEventListener("message", this.websocket_on_message.bind(this));
    this.ws.addEventListener("error", this.websocket_on_error.bind(this));
    this.ws.addEventListener("close", this.websocket_on_close.bind(this));
    this.sid = null; // invalidate for reconnection
  }

  websocket_on_open(event) {
    this.reconnect_attempts = 0;
    // local ComfyUI sends a session id via the initial "status" message,
    // which we wait for below; cloud doesn't hand out one (it ties messages
    // to the API key's user instead), so use our own client id once the
    // socket is up
    if (this.is_cloud) {
      this.sid = this.ws_client_id;
    }
  }

  async websocket_on_message(event) {
    // ignore anything from a socket we've already replaced
    if (event.target !== this.ws) {
      return;
    }

    if (typeof event.data == "string") {
      const data = JSON.parse(event.data);
      const prompt_id = data.data?.prompt_id;

      if (data.type == "status") {
        // ComfyUI sends the client id (once) after establishing the connection
        if (data.data.sid && !this.sid) {
          this.sid = data.data.sid;
        }
      } else if (data.type == "executing" || data.type == "progress") {
        // these tell us which node is currently producing output, which is
        // how images arriving over the socket get attributed below
        const entry = this.running_prompts[prompt_id];
        if (entry) {
          this.current_prompt = prompt_id;
          if (data.data.node != null) {
            this.current_node = data.data.node;
          }
          // status callbacks only get the periodic progress messages, which
          // are the ones carrying value/max
          if (data.type == "progress" && entry.status_callback) {
            entry.status_callback(data.data);
          }
        }
      } else if (data.type == "execution_success") {
        const entry = this.running_prompts[prompt_id];
        if (entry) {
          try {
            await this.get_outputs_from_history(prompt_id, entry);
          } catch (e) {
            // don't let this escape: we'd never settle the pending run
            this.fail_prompt(prompt_id, e);
            return;
          }
          this.finish_prompt(prompt_id);
        }
      } else if (data.type == "execution_interrupted") {
        if (this.running_prompts[prompt_id]) {
          console.warn("Execution was interrupted");
          this.fail_prompt(prompt_id, new Error("Execution was interrupted"));
        }
      } else if (data.type == "execution_error") {
        if (this.running_prompts[prompt_id]) {
          console.warn(data);
          const message =
            data.data.exception_message || data.data.exception_type || "Error during execution";
          this.fail_prompt(prompt_id, new Error(message));
        }
      } else {
        //console.log(data);
      }
    }

    if (event.data instanceof Blob) {
      // binary frames carry images (e.g. previews, or the final image when
      // using comfyui-tooling-nodes) but no prompt id of their own, so they
      // belong to whichever prompt last told us it was executing
      const entry = this.running_prompts[this.current_prompt];
      if (entry) {
        const blob_url = await this.parse_binary_output(event.data);
        if (blob_url) {
          entry.outputs.push({
            node: parseInt(this.current_node),
            src: blob_url,
          });
          entry.object_urls.push(blob_url);
        }
      }
    }
  }

  async parse_binary_output(blob) {
    // binary frames are prefixed with a big-endian uint32 type, followed by a
    // type-specific header (see comfy_org docs "WebSocket for Real-Time Progress")
    const type = new DataView(await blob.slice(0, 4).arrayBuffer()).getUint32(0, false);
    if (type === 1) {
      // PREVIEW_IMAGE: 4 bytes type + 4 bytes image format + image data
      return URL.createObjectURL(blob.slice(8));
    } else if (type === 4) {
      // PREVIEW_IMAGE_WITH_METADATA: 4 bytes type + 4 bytes metadata length + metadata JSON + image data
      const metadata_len = new DataView(await blob.slice(4, 8).arrayBuffer()).getUint32(0, false);
      return URL.createObjectURL(blob.slice(8 + metadata_len));
    }
    // ignore TEXT (3) and any other/future binary frame types
    return null;
  }

  websocket_on_error(event) {
    console.warn(event);
    // close the socket this error came from, not whichever one is current --
    // a late error from a replaced socket would otherwise tear down a
    // perfectly healthy connection
    try {
      event.target.close();
    } catch (e) {
      // already closed
    }
  }

  websocket_on_close(event) {
    if (this.closed || event.target !== this.ws) {
      return;
    }
    // back off instead of hammering an endpoint that isn't coming back
    const delay = Math.min(1000 * Math.pow(2, this.reconnect_attempts), 30000);
    this.reconnect_attempts++;
    this.reconnect_timer = setTimeout(() => {
      console.log("Reconnecting to " + this.base_url);
      this.setup_websocket();
    }, delay);
  }

  finish_prompt(prompt_id) {
    const entry = this.running_prompts[prompt_id];
    if (!entry) {
      return;
    }
    delete this.running_prompts[prompt_id];
    this.completed_object_urls.push(...entry.object_urls);
    if (entry.callback) {
      entry.callback(entry.outputs);
    }
    if (entry.resolve) {
      entry.resolve(entry.outputs);
    } else {
      // run() hasn't attached its promise yet -- park the results for it
      this.finished_outputs = this.finished_outputs || {};
      this.finished_outputs[prompt_id] = entry.outputs;
    }
  }

  fail_prompt(prompt_id, error) {
    const entry = this.running_prompts[prompt_id];
    if (!entry) {
      return;
    }
    delete this.running_prompts[prompt_id];
    this.completed_object_urls.push(...entry.object_urls);
    if (entry.callback) {
      // the documented callback signature is (results, error)
      entry.callback([], error.message);
      // resolving (rather than rejecting) keeps callback users from also
      // having to handle a promise rejection they never asked for
      if (entry.resolve) {
        entry.resolve([]);
      }
    } else if (entry.reject) {
      entry.reject(error);
    }
  }

  revoke_completed_object_urls() {
    for (const url of this.completed_object_urls) {
      URL.revokeObjectURL(url);
    }
    this.completed_object_urls = [];
  }

  async get_outputs_from_history(prompt_id, entry) {
    let outputs;

    if (this.is_cloud) {
      // /jobs is the supported endpoint, /history_v2 is deprecated but still
      // the one older deployments have -- try the former, fall back to the latter
      try {
        outputs = this.extract_outputs(
          await (await this.request("/jobs/" + prompt_id)).json(),
          prompt_id
        );
      } catch (e) {
        outputs = null;
      }
      if (!outputs) {
        outputs = this.extract_outputs(
          await (await this.request("/history_v2/" + prompt_id)).json(),
          prompt_id
        );
      }
    } else {
      outputs = this.extract_outputs(
        await (await this.request("/history/" + prompt_id)).json(),
        prompt_id
      );
    }

    if (!outputs) {
      return;
    }

    // flatten resulting images and only use the ones of type 'output':
    let image_outputs = Object.entries(outputs)
      .filter(([key, value]) => value?.images?.length > 0)
      .reduce((acc, [key, value]) => {
        acc[key] = value.images.filter((d) => d.type === "output");
        return acc;
      }, {});

    for (const [node_number, images] of Object.entries(image_outputs)) {
      for (const image of images) {
        const src = await this.get_view_url(image);
        entry.outputs.push({
          node: parseInt(node_number),
          src,
        });
        if (src.startsWith("blob:")) {
          entry.object_urls.push(src);
        }
      }
    }
  }

  /**
   * /history is keyed by prompt id, /jobs returns the job directly.
   */
  extract_outputs(payload, prompt_id) {
    return payload?.[prompt_id]?.outputs ?? payload?.outputs ?? null;
  }

  async get_view_url(image) {
    // URLSearchParams already percent-encodes -- encoding again would turn
    // the % of each escape into %25 and break non-ASCII filenames
    const path = "/view?" + new URLSearchParams(image).toString();

    if (!this.is_cloud) {
      return this.build_url(path);
    }

    // cloud's /view requires an X-API-Key header, which an <img> element has
    // no way to send, so fetch the bytes ourselves and hand back a local
    // blob: URL instead. These are revoked once the next run starts, so
    // don't hold on to a src across runs.
    const res = await this.request(path);
    return URL.createObjectURL(await res.blob());
  }

  async run(workflow, callback, status_callback) {
    try {
      await this.wait_until_ready();

      // reclaim the blob: URLs handed out for the previous run
      this.revoke_completed_object_urls();

      workflow = this.prepare_workflow(workflow);

      const prompt_id = await this.prompt(workflow, status_callback);
      return await new Promise((resolve, reject) => {
        // prompt() registered the entry already, so that messages arriving
        // between the response and here still find somewhere to go
        const entry = this.running_prompts[prompt_id];
        if (!entry) {
          // finished before we got here (only possible for a workflow that
          // was entirely cached) -- its results were parked for us
          resolve(this.take_finished_outputs(prompt_id));
          return;
        }
        entry.callback = callback;
        entry.resolve = resolve;
        entry.reject = reject;
      });
    } catch (err) {
      // failures before the workflow is submitted (no connection, a failed
      // upload, a rejected prompt) reach the callback too, so that callback
      // users don't silently get nothing
      if (callback) {
        callback([], err.message);
        return [];
      }
      throw err;
    }
  }

  take_finished_outputs(prompt_id) {
    const outputs = this.finished_outputs?.[prompt_id] ?? [];
    if (this.finished_outputs) {
      delete this.finished_outputs[prompt_id];
    }
    return outputs;
  }

  /**
   * Waits for the WebSocket to be up and for any uploads to have finished,
   * rather than hanging forever if the connection never comes up.
   */
  async wait_until_ready(timeout = 30000) {
    const delay = (ms) => new Promise((res) => setTimeout(res, ms));
    const started = Date.now();
    while (!this.sid || Object.values(this.running_uploads).length > 0) {
      if (this.closed) {
        throw new Error("Connection closed");
      }
      if (Date.now() - started > timeout) {
        throw new Error(
          "Timed out waiting for " + this.base_url + " (is the URL correct, and ComfyUI reachable?)"
        );
      }
      await delay(100);
    }
  }

  /**
   * Rewrites the filenames we made up in image() to the ones the server
   * stored the uploads under, and surfaces uploads that failed outright.
   * (Comfy Cloud stores uploads under a content-hashed name, so the name we
   * sent is not the name the workflow needs to reference.)
   */
  prepare_workflow(workflow) {
    if (
      Object.keys(this.uploaded_filenames).length === 0 &&
      Object.keys(this.upload_errors).length === 0
    ) {
      return workflow; // nothing to rewrite, don't copy the whole workflow
    }

    const walk = (value) => {
      if (typeof value === "string") {
        if (this.upload_errors[value]) {
          throw this.upload_errors[value];
        }
        return this.uploaded_filenames[value] ?? value;
      } else if (Array.isArray(value)) {
        return value.map(walk);
      } else if (value && typeof value === "object") {
        return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, walk(v)]));
      }
      return value;
    };

    return walk(workflow);
  }

  async prompt(workflow, status_callback) {
    const res = await this.request("/prompt", {
      method: "POST",
      body: JSON.stringify({ prompt: workflow, client_id: this.sid }),
      headers: { "Content-Type": "application/json" },
    });
    const data = await res.json();

    // register before returning, so that messages for this prompt arriving
    // while run() is still resuming aren't dropped
    this.running_prompts[data.prompt_id] = {
      status_callback,
      outputs: [],
      object_urls: [],
    };

    return data.prompt_id;
  }

  upload_canvas(canvas, filename, format = "image/png", quality) {
    return new Promise((resolve, reject) => {
      canvas.toBlob(
        async (blob) => {
          try {
            if (!blob) {
              throw new Error("Could not read the image (is the canvas empty or tainted?)");
            }
            const formData = new FormData();
            formData.append("image", blob, filename);
            formData.append("type", "input");

            const res = await this.request("/upload/image", {
              method: "POST",
              body: formData,
            });
            const json = await res.json();
            resolve(json.name);
          } catch (err) {
            console.warn("Upload failed:", err);
            reject(err);
          }
        },
        format,
        quality
      );
    });
  }

  /**
   * Uploads a p5 image or drawing surface, and returns the filename to use
   * for it in the workflow, e.g.
   *
   *   workflow[10].inputs.image = comfy.image(srcImg);
   *
   * Defaults to PNG so that transparency survives (workflows that use the
   * alpha channel as a mask need this); pass "image/jpeg" for smaller uploads.
   */
  image(img, format = "image/png", quality) {
    if (!img.loadPixels) {
      throw new Error(
        "image() is currently only implemented for p5 Graphics/Renderer/Image objects"
      );
    }

    // generate a random filename, so uploads never collide server-side:
    const extension = format === "image/jpeg" ? ".jpg" : ".png";
    const filename = "p5.comfyui-helper-" + this.generate_id() + extension;

    // start upload:
    this.running_uploads[filename] = true;
    this.upload_canvas(img.canvas, filename, format, quality)
      .then((server_filename) => {
        if (server_filename && server_filename !== filename) {
          this.remember_uploaded_filename(filename, server_filename);
        }
      })
      .catch((err) => {
        // held until run() needs this file, so the error surfaces there
        // rather than as an unhandled rejection
        this.upload_errors[filename] = err;
      })
      .finally(() => {
        delete this.running_uploads[filename];
      });

    return filename;
  }

  remember_uploaded_filename(filename, server_filename) {
    this.uploaded_filenames[filename] = server_filename;
    // a sketch that uploads every frame would grow this forever, so drop the
    // oldest entries -- they belong to filenames no workflow still refers to
    const names = Object.keys(this.uploaded_filenames);
    if (names.length > 256) {
      delete this.uploaded_filenames[names[0]];
    }
  }
}
