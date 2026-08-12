# Comfy Cloud CORS proxy

`cloud.comfy.org`'s API doesn't send `Access-Control-Allow-Origin` headers, so a browser-based p5.js sketch can't call it directly — every request gets blocked by CORS, no matter what page the sketch runs on (this includes the p5.js Web Editor). `worker.js` is a small [Cloudflare Worker](https://workers.cloudflare.com/) that sits in between: it forwards requests to `cloud.comfy.org` unchanged and adds the CORS headers browsers require.

It does **not** hold any credentials of its own — it's a dumb pipe. Every request still needs the caller's own Comfy Cloud API key (sent as `X-API-Key`, exactly like calling `cloud.comfy.org` directly), so each person using it is authenticated as themselves and billed against their own account's credits. That makes it a good fit for a workshop: deploy it once, share the URL, and everyone plugs in their own key.

## Deploy it (pick one)

You only need to do this once; everyone in the workshop uses the same deployed URL.

### Option A: Cloudflare dashboard (no install required)

1. Sign up for a free [Cloudflare account](https://dash.cloudflare.com/sign-up) (no credit card needed).
2. Go to **Workers & Pages → Create → Create Worker**, give it a name (e.g. `comfy-cloud-proxy`), and click **Deploy** to create the default worker.
3. Click **Edit code**, delete everything in the editor, and paste in the contents of [`worker.js`](worker.js).
4. Click **Deploy**.
5. Your proxy URL is shown at the top, something like `https://comfy-cloud-proxy.<your-subdomain>.workers.dev`.

### Option B: Wrangler CLI

```
cd proxy
npx wrangler login
npx wrangler deploy
```

This prints your proxy's URL on success.

## Using it

In each participant's sketch, point `ComfyUiP5Helper` at the proxy URL instead of `https://cloud.comfy.org`, with their own API key as usual:

```js
comfy = new ComfyUiP5Helper("https://comfy-cloud-proxy.<your-subdomain>.workers.dev", "their-own-api-key");
```

Everything else works exactly as documented in the main [README](../README.md#connecting-to-comfy-cloud).

## After the workshop

The proxy has no allowlist — anyone with the URL can use it to relay requests to `cloud.comfy.org` (still authenticated with their own key, so this isn't a way to spend anyone else's credits, but it's public infrastructure sitting under your Cloudflare account). Delete the Worker from the Cloudflare dashboard (or `npx wrangler delete`) once you're done with it.
