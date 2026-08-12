/**
 * Comfy Cloud CORS proxy
 *
 * cloud.comfy.org does not send Access-Control-Allow-Origin headers, so
 * browser-based apps (like a p5.js sketch using p5.comfyui-helper) cannot
 * call it directly. This Worker sits in between: it forwards REST and
 * WebSocket traffic to https://cloud.comfy.org unchanged, and adds the
 * CORS headers browsers require.
 *
 * It does NOT hold or inject any credentials of its own. Every request must
 * carry the caller's own X-API-Key (REST) or ?token= (WebSocket) — each
 * participant authenticates with, and is billed against, their own Comfy
 * Cloud account. This file has no configuration to fill in; deploy as-is.
 */

const UPSTREAM = "https://cloud.comfy.org";

function corsHeaders(request) {
  const headers = new Headers();
  headers.set("Access-Control-Allow-Origin", "*");
  headers.set("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  headers.set(
    "Access-Control-Allow-Headers",
    request.headers.get("Access-Control-Request-Headers") || "Content-Type, X-API-Key"
  );
  headers.set("Access-Control-Max-Age", "86400");
  return headers;
}

async function proxyHttp(request, url) {
  const target = UPSTREAM + url.pathname + url.search;

  const headers = new Headers(request.headers);
  headers.delete("host");
  headers.delete("origin");
  // don't relay the browser's ambient credentials upstream
  headers.delete("cookie");
  headers.delete("authorization");
  // request.body gets re-wrapped as a stream below, which the runtime sends
  // chunked-encoded -- forwarding the browser's original (now stale)
  // Content-Length alongside that can desync from what's actually sent,
  // which is exactly the kind of mismatch that leads to a silently
  // truncated body upstream (e.g. corrupted image uploads); let the runtime
  // recompute it from the actual outgoing body instead
  headers.delete("content-length");

  const init = {
    method: request.method,
    headers,
    // handled below, so that credentials aren't replayed to another host
    redirect: "manual",
  };
  if (!["GET", "HEAD"].includes(request.method)) {
    init.body = request.body;
    init.duplex = "half";
  }

  let upstream = await fetch(target, init);

  // /api/view answers with a 302 to a signed storage URL on another host.
  // Follow it here rather than in the browser, and drop the caller's API key
  // when the redirect leaves cloud.comfy.org -- the signed URL already grants
  // access, so forwarding the key would hand it to a third party for nothing.
  if ([301, 302, 303, 307, 308].includes(upstream.status)) {
    const location = upstream.headers.get("location");
    if (location) {
      const destination = new URL(location, target);
      const same_host = destination.origin === new URL(UPSTREAM).origin;
      upstream = await fetch(destination.toString(), same_host ? { headers } : undefined);
    }
  }

  const response = new Response(upstream.body, upstream);
  const cors = corsHeaders(request);
  cors.forEach((value, key) => response.headers.set(key, value));
  return response;
}

async function proxyWebSocket(request, url) {
  // cloudflare workers open outbound WebSockets via a plain fetch() with an
  // Upgrade header (not a wss:// URL) — the platform handles the handshake
  const target = UPSTREAM + url.pathname + url.search;
  const upstreamResponse = await fetch(target, {
    headers: { Upgrade: "websocket" },
  });
  const upstreamSocket = upstreamResponse.webSocket;
  if (!upstreamSocket) {
    // cloud.comfy.org validates ?token= at handshake time and responds with a
    // plain (non-101) error instead of upgrading if it's missing or invalid
    const detail = await upstreamResponse.text().catch(() => "");
    return new Response(`Upstream did not upgrade to WebSocket (status ${upstreamResponse.status}): ${detail}`, {
      status: 502,
    });
  }
  // allowHalfOpen: this Worker sits between two independent sockets and needs
  // to coordinate closing both sides itself, rather than each side
  // automatically auto-replying to a Close frame from its own peer
  upstreamSocket.accept({ allowHalfOpen: true });

  const [client, server] = Object.values(new WebSocketPair());
  server.accept({ allowHalfOpen: true });

  server.addEventListener("message", (event) => upstreamSocket.send(event.data));
  upstreamSocket.addEventListener("message", (event) => server.send(event.data));

  const closeBoth = (code, reason) => {
    // only 1000 and 3000-4999 may be passed to close(); the reserved codes an
    // endpoint actually sees most often (1005 no-status, 1006 abnormal, 1011
    // server error) throw InvalidAccessError, which would leave both sockets
    // open and the relay billing until the runtime reclaims it
    const safe_code = code === 1000 || (code >= 3000 && code <= 4999) ? code : undefined;
    const safe_reason = typeof reason === "string" ? reason.slice(0, 123) : undefined;
    for (const socket of [server, upstreamSocket]) {
      try {
        if (safe_code === undefined) {
          socket.close();
        } else {
          socket.close(safe_code, safe_reason);
        }
      } catch (e) {
        // already closed
      }
    }
  };
  server.addEventListener("close", (event) => closeBoth(event.code, event.reason));
  upstreamSocket.addEventListener("close", (event) => closeBoth(event.code, event.reason));
  server.addEventListener("error", () => closeBoth());
  upstreamSocket.addEventListener("error", () => closeBoth());

  return new Response(null, { status: 101, webSocket: client });
}

export default {
  async fetch(request) {
    const url = new URL(request.url);

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders(request) });
    }

    // the Upgrade header's value is case-insensitive per RFC 6455
    if ((request.headers.get("Upgrade") || "").toLowerCase() === "websocket") {
      return proxyWebSocket(request, url);
    }

    return proxyHttp(request, url);
  },
};
