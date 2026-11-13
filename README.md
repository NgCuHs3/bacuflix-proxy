# Bacuflix Reverse Proxy Server

A high-performance, lightweight, standalone intermediate reverse proxy server designed for the Bacuflix movie streaming application and deployable to Vercel Serverless Functions.

The proxy bypasses ISP-level DNS blocks on movie API domains and media streaming CDNs, providing transparent access to movie metadata, HLS playlists, MPEG-TS/MP4 video fragments, images, and subtitles.

---

## 1. Architecture and Request Flow

```
+-------------------------------------------------------------+
|               Browser / Bacuflix Frontend                   |
|      (Web, Android Capacitor, Samsung Tizen Smart TV)       |
+------------------------------+------------------------------+
                               |
                               | HTTP / HTTPS Requests
                               v
+-------------------------------------------------------------+
|                 Bacuflix Proxy Server                       |
|           (Vercel Serverless / Node.js Runtime)             |
|                                                             |
|  * SSRF Protection & Host Whitelisting                      |
|  * Path Traversal Sanitization                              |
|  * Hop-by-Hop Header Filtering                              |
|  * CORS Negotiation                                         |
|  * HLS (.m3u8) Dynamic URL Rewriter                         |
|  * Range Request (206 Partial Content) Pass-through         |
|  * Zero-Buffering Media Stream Piping                       |
+------------------------------+------------------------------+
                               |
                               | Proxied Upstream Requests
                               v
+-------------------------------------------------------------+
|                 Original Upstream Sources                   |
|                                                             |
|  * Movie API (phimapi.com)                                  |
|  * Image CDN (phimimg.com)                                  |
|  * HLS Media CDNs (phim1280.tv, kkphimplayer6.com, etc.)    |
|  * Subtitle Providers (123embed.net, etc.)                  |
+-------------------------------------------------------------+
```

### Request Flow Modes

1. **Direct API Reverse Proxy**:
   Incoming requests such as `/v1/api/home` or `/phim/xom-nho` are transparently forwarded to `UPSTREAM_BASE_URL` (`https://phimapi.com` by default), preserving query parameters, headers, and HTTP status codes.
2. **Media & Stream Proxying (`/api/proxy?url=...`)**:
   Incoming requests specifying `url=<target_url>` are verified against the SSRF security policy and `ALLOWED_STREAM_HOSTS` whitelist.
   - For **HLS Playlists (`.m3u8`)**: The playlist is fetched, parsed, and its segment/sub-playlist/key URIs are rewritten to route subsequent requests back through the proxy.
   - For **Media Streams (`.ts`, `.mp4`)**, **Images**, and **Subtitles**: The proxy pipes the data directly without buffering, supporting `Range` requests (HTTP 206 Partial Content) and high throughput.

---

## 2. Project Structure

```
bacuflix-proxy/
├── .env.example          # Environment variables template
├── package.json          # Standalone npm project configuration
├── vercel.json           # Vercel Serverless routing configuration
├── server.js             # Standalone local Node.js server
├── README.md             # Complete documentation
├── api/
│   └── index.js          # Vercel Serverless Function entry point
├── src/
│   ├── config.js         # Configuration parser and default values
│   ├── security.js       # SSRF prevention, host whitelist, header sanitization
│   ├── hls-rewriter.js   # Dynamic HLS playlist (.m3u8) URI rewriter
│   └── proxy.js          # Core reverse proxy engine & streaming pipeline
└── test/
    └── proxy.test.js     # 12-suite automated unit & integration tests
```

---

## 3. Environment Variable Configuration

Create a `.env` file in `bacuflix-proxy/` based on `.env.example`:

| Variable | Default Value | Description |
|---|---|---|
| `PORT` | `3000` | Port for standalone local server (`node server.js`) |
| `UPSTREAM_BASE_URL` | `https://phimapi.com` | Base URL of the primary upstream movie API |
| `ALLOWED_STREAM_HOSTS` | Common movie CDNs (see below) | Comma-separated list of permitted hostnames for media proxying. Subdomains are automatically allowed. Use `*` to allow all public hosts. |
| `CORS_ORIGIN` | `*` | Allowed CORS origins for browser/Capacitor/Tizen frontends |
| `REQUEST_TIMEOUT_MS` | `15000` | Upstream request timeout in milliseconds |

Default `ALLOWED_STREAM_HOSTS`:
- `phimapi.com`
- `phimimg.com`
- `phim1280.tv`
- `kkphimplayer6.com`
- `kvp726.com`
- `apiaz.xyz`
- `streamvsmov.com`
- `vsmov.com`
- `phim.nguonc.com`
- `123embed.net`
- `subtitle.123embed.net`
- `raw.githubusercontent.com`

---

## 4. Local Development and Testing

### Prerequisites
- Node.js >= 18.0.0

### Run Tests
The test suite validates GET/POST forwarding, query preservation, auth headers, 404/500 error propagation, JSON integrity, binary image delivery, subtitle delivery, HLS playlist URL rewriting, MPEG-TS streaming, HTTP Range (206) requests, large stream piping, and SSRF security rules.

```bash
cd bacuflix-proxy
npm test
```

### Start Local Server
```bash
cd bacuflix-proxy
npm start
# or
npm run dev
```

The server starts at `http://localhost:3000/`. You can verify health via:
```bash
curl http://localhost:3000/health
```

---

## 5. Vercel Deployment Instructions

`bacuflix-proxy` is ready for independent Vercel deployment using the Vercel CLI or Git integration.

### Prerequisites
Install Vercel CLI (if not already installed):
```bash
npm install -g vercel
```

### Preview Deployment
Deploy to a preview environment:
```bash
cd bacuflix-proxy
vercel deploy
```

Follow the prompts:
1. `Set up and deploy?` -> `y`
2. `Which scope?` -> Select your Vercel account
3. `Link to existing project?` -> `n` (or `y` if already created)
4. `Project name?` -> `bacuflix-proxy`
5. `In which directory is your code located?` -> `./`

### Configure Environment Variables in Vercel
In the Vercel Dashboard (or via `vercel env add`):
- `UPSTREAM_BASE_URL`: `https://phimapi.com`
- `ALLOWED_STREAM_HOSTS`: `phimapi.com,phimimg.com,phim1280.tv,kkphimplayer6.com,kvp726.com,apiaz.xyz,streamvsmov.com,vsmov.com,phim.nguonc.com,123embed.net,subtitle.123embed.net,raw.githubusercontent.com`
- `CORS_ORIGIN`: `*`
- `REQUEST_TIMEOUT_MS`: `15000`

### Production Deployment
> **IMPORTANT**: Only deploy to production after preview verification and explicit approval.

```bash
cd bacuflix-proxy
vercel deploy --prod
```

---

## 6. Frontend Integration

The Bacuflix frontend can be configured to use the proxy server by setting the API base URL.

### Options to configure in Bacuflix Frontend:

1. **Global Configuration in `index.html`**:
   ```html
   <script>
     window.BACUFLIX_CONFIG = {
       API_BASE_URL: "https://your-bacuflix-proxy.vercel.app",
       PROXY_STREAMING: true
     };
   </script>
   ```

2. **Browser LocalStorage**:
   Users or developers can switch between the direct upstream and the proxy in the browser console:
   ```javascript
   // Switch to Vercel proxy
   localStorage.setItem("bacuflix_api_base_url", "https://your-bacuflix-proxy.vercel.app");
   localStorage.setItem("bacuflix_proxy_streaming", "true");

   // Revert to direct upstream
   localStorage.removeItem("bacuflix_api_base_url");
   localStorage.removeItem("bacuflix_proxy_streaming");
   ```

3. **URL Query Parameter**:
   Access the app with `?proxy=https://your-bacuflix-proxy.vercel.app` to test the proxy on the fly.

4. **Node / Testing Environment**:
   Set `process.env.BACUFLIX_API_BASE_URL`.

When configured:
- All KKPhim API calls (`/v1/api/home`, `/phim/{slug}`, `/v1/api/tim-kiem`, etc.) route through the proxy.
- Movie streaming links (`.m3u8`) and subtitles (`.srt`) route through `/api/proxy?url=...`.
- HLS segment URLs inside playlists are automatically rewritten by the proxy to stream through the proxy.

---

## 7. Streaming Compatibility & Technical Details

- **HLS (.m3u8)**: Rewrites segment URIs (e.g., `segment0.ts`), variant playlist URIs, and `#EXT-X-KEY` / `#EXT-X-MAP` encryption tags.
- **MPEG-TS (.ts)**: Passes binary video chunks with `video/mp2t` headers directly without in-memory buffering.
- **HTTP Range (206 Partial Content)**: Passes client `Range: bytes=start-end` to upstream and returns `Content-Range`, `Content-Length`, `Accept-Ranges: bytes` to the player, enabling video seeking and scrubbing.
- **Zero-Buffering**: Video data is piped (`upstreamRes.pipe(res)`), ensuring minimal memory consumption within Vercel's 1024MB/50MB function limits.

---

## 8. Troubleshooting

- **CORS Errors**: The proxy sets `Access-Control-Allow-Origin: *` and exposes Range headers (`Content-Range`, `Accept-Ranges`, `Content-Length`). If using custom domain restrictions, set `CORS_ORIGIN` accordingly.
- **403 Host Not Permitted**: Ensure the streaming CDN domain is in `ALLOWED_STREAM_HOSTS`. Subdomains of listed domains are automatically allowed.
- **504 Gateway Timeout**: The upstream server did not respond within `REQUEST_TIMEOUT_MS`. Check the upstream server status or increase `REQUEST_TIMEOUT_MS`.
- **400 SSRF Validation Rejected**: The target URL attempted to access a private, loopback, or invalid IP/protocol. Only public HTTP/HTTPS URLs are allowed.
