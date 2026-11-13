/**
 * Core Reverse Proxy Engine
 * Handles routing, security validation, header propagation, Range requests,
 * transparent streaming, and HLS playlist rewriting.
 */

const http = require("http");
const https = require("https");
const { getConfig } = require("./config");
const {
  isSsrfSafe,
  isHostAllowed,
  sanitizePath,
  filterHopByHopHeaders,
  getCorsHeaders
} = require("./security");
const { rewriteM3u8 } = require("./hls-rewriter");

function sendJson(res, statusCode, data, corsOrigin) {
  const body = JSON.stringify(data);
  const headers = Object.assign(
    {
      "Content-Type": "application/json; charset=utf-8",
      "Content-Length": Buffer.byteLength(body)
    },
    getCorsHeaders(corsOrigin)
  );
  res.writeHead(statusCode, headers);
  res.end(body);
}

function isHlsPlaylist(contentType, pathname) {
  const type = (contentType || "").toLowerCase();
  if (
    type.includes("application/vnd.apple.mpegurl") ||
    type.includes("application/x-mpegurl") ||
    type.includes("text/vnd.apple.mpegurl")
  ) {
    return true;
  }
  if (pathname && pathname.toLowerCase().endsWith(".m3u8")) {
    return true;
  }
  return false;
}

function determineProxyBaseUrl(req) {
  const proto = req.headers["x-forwarded-proto"] || "http";
  const host = req.headers["x-forwarded-host"] || req.headers.host;
  if (host) {
    return `${proto}://${host}`;
  }
  return "";
}

function handleRequest(req, res) {
  const config = getConfig();
  const corsHeaders = getCorsHeaders(config.corsOrigin);

  // Handle CORS preflight OPTIONS
  if (req.method === "OPTIONS") {
    res.writeHead(204, corsHeaders);
    res.end();
    return;
  }

  // Parse incoming URL
  let parsedUrl;
  try {
    parsedUrl = new URL(req.url, "http://localhost");
  } catch (err) {
    sendJson(res, 400, { error: "Invalid request URL", details: err.message }, config.corsOrigin);
    return;
  }

  const pathname = sanitizePath(parsedUrl.pathname);
  const queryUrlParam = parsedUrl.searchParams.get("url");

  // Health check & Service status routes
  if (
    !queryUrlParam &&
    (pathname === "/" || pathname === "/health" || pathname === "/api/health")
  ) {
    sendJson(
      res,
      200,
      {
        status: "ok",
        service: "bacuflix-proxy",
        upstream: config.upstreamBaseUrl,
        allowedHosts: config.allowedHosts,
        version: "1.0.0"
      },
      config.corsOrigin
    );
    return;
  }

  // Determine Target Upstream URL
  let targetUrlString = "";
  if (queryUrlParam) {
    // Proxy via ?url= parameter
    targetUrlString = queryUrlParam.trim();
  } else {
    // Direct path reverse-proxy to UPSTREAM_BASE_URL
    const upstreamBase = config.upstreamBaseUrl.replace(/\/+$/, "");
    targetUrlString = upstreamBase + pathname + parsedUrl.search;
  }

  // Validate SSRF safety
  const ssrfCheck = isSsrfSafe(targetUrlString);
  if (!ssrfCheck.safe) {
    sendJson(
      res,
      400,
      {
        error: "SSRF validation rejected target URL",
        reason: ssrfCheck.reason,
        target: targetUrlString
      },
      config.corsOrigin
    );
    return;
  }

  const targetUrl = ssrfCheck.parsed;
  let upstreamHost = "";
  try {
    upstreamHost = new URL(config.upstreamBaseUrl).hostname;
  } catch (_) {}

  // Validate Host restriction
  if (!isHostAllowed(targetUrl.hostname, config.allowedHosts, upstreamHost)) {
    sendJson(
      res,
      403,
      {
        error: "Host not permitted by proxy policy",
        host: targetUrl.hostname,
        target: targetUrlString
      },
      config.corsOrigin
    );
    return;
  }

  // Prepare outgoing headers
  const outgoingHeaders = filterHopByHopHeaders(req.headers);
  outgoingHeaders.host = targetUrl.host;

  // Set standard browser User-Agent
  outgoingHeaders["user-agent"] = req.headers["user-agent"] ||
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

  // Forward client IP if available
  const clientIp = (req.headers["x-forwarded-for"] || req.headers["x-real-ip"] || "").split(",")[0].trim();
  if (clientIp) {
    outgoingHeaders["x-forwarded-for"] = clientIp;
    outgoingHeaders["x-real-ip"] = clientIp;
  }

  // Set upstream required Referer and Origin for video streaming CDNs
  const hostLower = targetUrl.hostname.toLowerCase();
  if (
    hostLower.includes("phim1280") ||
    hostLower.includes("kkphim") ||
    hostLower.includes("kvp726") ||
    hostLower.includes("phimapi") ||
    hostLower.includes("apiaz")
  ) {
    outgoingHeaders["referer"] = "https://player.phimapi.com/";
    outgoingHeaders["origin"] = "https://player.phimapi.com";
  } else if (hostLower.includes("nguonc") || hostLower.includes("streamc")) {
    outgoingHeaders["referer"] = "https://phim.nguonc.com/";
    outgoingHeaders["origin"] = "https://phim.nguonc.com";
  } else if (hostLower.includes("vsmov") || hostLower.includes("streamvsmov")) {
    outgoingHeaders["referer"] = "https://vsmov.com/";
    outgoingHeaders["origin"] = "https://vsmov.com";
  }

  const transport = targetUrl.protocol === "https:" ? https : http;
  const requestOptions = {
    protocol: targetUrl.protocol,
    hostname: targetUrl.hostname,
    port: targetUrl.port || (targetUrl.protocol === "https:" ? 443 : 80),
    path: targetUrl.pathname + targetUrl.search,
    method: req.method,
    headers: outgoingHeaders,
    timeout: config.timeoutMs
  };

  const upstreamReq = transport.request(requestOptions, upstreamRes => {
    const upstreamStatus = upstreamRes.statusCode || 200;
    const responseHeaders = filterHopByHopHeaders(upstreamRes.headers);

    // Merge CORS headers
    Object.assign(responseHeaders, corsHeaders);

    const isHls = isHlsPlaylist(upstreamRes.headers["content-type"], targetUrl.pathname);

    if (isHls && upstreamStatus >= 200 && upstreamStatus < 300) {
      // HLS playlists: buffer text and rewrite segment/variant URLs
      const chunks = [];
      upstreamRes.on("data", chunk => chunks.push(chunk));
      upstreamRes.on("end", () => {
        const rawContent = Buffer.concat(chunks).toString("utf8");
        const proxyBaseUrl = determineProxyBaseUrl(req);
        const rewritten = rewriteM3u8(rawContent, targetUrl.href, proxyBaseUrl);

        responseHeaders["content-type"] = "application/vnd.apple.mpegurl; charset=utf-8";
        responseHeaders["content-length"] = Buffer.byteLength(rewritten);
        delete responseHeaders["content-encoding"];

        res.writeHead(upstreamStatus, responseHeaders);
        res.end(rewritten);
      });
      upstreamRes.on("error", err => {
        if (!res.headersSent) {
          sendJson(res, 502, { error: "Failed to read HLS playlist from upstream", details: err.message }, config.corsOrigin);
        }
      });
    } else {
      // Direct stream: TS segments, MP4 video, Range 206, images, JSON, subtitles, etc.
      res.writeHead(upstreamStatus, responseHeaders);
      upstreamRes.pipe(res);
    }
  });

  upstreamReq.on("timeout", () => {
    upstreamReq.destroy(new Error("Upstream request timed out"));
  });

  upstreamReq.on("error", err => {
    if (res.headersSent) {
      return;
    }
    const isTimeout = err.message && err.message.includes("timed out");
    const statusCode = isTimeout ? 504 : 502;
    sendJson(
      res,
      statusCode,
      {
        error: isTimeout ? "Gateway Timeout" : "Bad Gateway",
        message: err.message,
        target: targetUrlString
      },
      config.corsOrigin
    );
  });

  // Forward body for POST/PUT/PATCH requests
  if (req.method === "POST" || req.method === "PUT" || req.method === "PATCH") {
    req.pipe(upstreamReq);
  } else {
    upstreamReq.end();
  }
}

module.exports = {
  handleRequest
};
