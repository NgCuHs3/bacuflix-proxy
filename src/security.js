/**
 * Security utilities: SSRF prevention, host whitelisting, header sanitization, and path traversal protection.
 */

const path = require("path");

const HOP_BY_HOP_HEADERS = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "trailers",
  "transfer-encoding",
  "upgrade",
  "host"
]);

function isPrivateIp(ip) {
  // IPv4 checks
  const ipv4Match = ip.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (ipv4Match) {
    const octets = ipv4Match.slice(1).map(Number);
    if (octets.some(o => o < 0 || o > 255)) return true;
    const [a, b] = octets;
    if (a === 0) return true; // 0.0.0.0/8
    if (a === 10) return true; // 10.0.0.0/8
    if (a === 127) return true; // 127.0.0.0/8 (loopback)
    if (a === 169 && b === 254) return true; // 169.254.0.0/16 (link-local, cloud metadata)
    if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12
    if (a === 192 && b === 168) return true; // 192.168.0.0/16
    if (a === 100 && b >= 64 && b <= 127) return true; // 100.64.0.0/10 (CGNAT)
    return false;
  }

  // IPv6 checks
  const cleanIpv6 = ip.replace(/^\[|\]$/g, "").toLowerCase();
  if (cleanIpv6 === "::1" || cleanIpv6 === "::") return true;
  if (cleanIpv6.startsWith("fe80:")) return true; // link-local
  if (cleanIpv6.startsWith("fc00:") || cleanIpv6.startsWith("fd")) return true; // ULA
  if (cleanIpv6.startsWith("::ffff:")) {
    const mapped = cleanIpv6.slice(7);
    return isPrivateIp(mapped);
  }

  return false;
}

function isSsrfSafe(targetUrl) {
  try {
    const parsed = new URL(targetUrl);
    // Only permit HTTP and HTTPS
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return { safe: false, reason: "Unsupported protocol: " + parsed.protocol };
    }

    // Do not permit embedded credentials
    if (parsed.username || parsed.password) {
      return { safe: false, reason: "Credentials not allowed in target URL" };
    }

    const host = parsed.hostname.toLowerCase();
    if (!host) {
      return { safe: false, reason: "Empty hostname" };
    }

    // Block localhost, cloud metadata, and internal domains
    if (process.env.ALLOW_TEST_LOCALHOST === "1" && (host === "localhost" || host === "127.0.0.1")) {
      return { safe: true, parsed: parsed };
    }

    if (
      host === "localhost" ||
      host.endsWith(".local") ||
      host.endsWith(".internal") ||
      host.endsWith(".localhost") ||
      host === "metadata.google.internal" ||
      host === "instance-data"
    ) {
      return { safe: false, reason: "Access to private or local hostnames is forbidden" };
    }

    if (isPrivateIp(host)) {
      return { safe: false, reason: "Access to private IP addresses is forbidden" };
    }

    return { safe: true, parsed: parsed };
  } catch (err) {
    return { safe: false, reason: "Invalid target URL: " + err.message };
  }
}

function isHostAllowed(hostname, allowedHosts, upstreamHostname) {
  if (!hostname) return false;
  const host = hostname.toLowerCase();

  // If wildcard '*' is in allowedHosts, permit all non-private hosts
  if (allowedHosts.includes("*")) {
    return true;
  }

  if (upstreamHostname && host === upstreamHostname.toLowerCase()) {
    return true;
  }

  for (const allowed of allowedHosts) {
    const cleanAllowed = allowed.toLowerCase().trim();
    if (!cleanAllowed) continue;
    if (host === cleanAllowed || host.endsWith("." + cleanAllowed)) {
      return true;
    }
  }

  return false;
}

function sanitizePath(rawPath) {
  if (!rawPath || typeof rawPath !== "string") return "/";
  // Strip null bytes and control chars
  const clean = rawPath.replace(/[\x00-\x1f\x7f]/g, "");
  // Normalize path using posix normalize
  const normalized = path.posix.normalize(clean);
  // Prevent escape outside root
  if (normalized.startsWith("../") || normalized === "..") {
    return "/";
  }
  return normalized.startsWith("/") ? normalized : "/" + normalized;
}

function filterHopByHopHeaders(incomingHeaders) {
  const filtered = {};
  for (const key of Object.keys(incomingHeaders || {})) {
    const lowerKey = key.toLowerCase();
    if (!HOP_BY_HOP_HEADERS.has(lowerKey)) {
      filtered[key] = incomingHeaders[key];
    }
  }
  return filtered;
}

function getCorsHeaders(corsOrigin) {
  return {
    "Access-Control-Allow-Origin": corsOrigin || "*",
    "Access-Control-Allow-Methods": "GET, POST, PUT, PATCH, DELETE, HEAD, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization, Range, X-Requested-With, Accept, Origin",
    "Access-Control-Expose-Headers": "Content-Range, Content-Length, Accept-Ranges, Content-Type, ETag, Cache-Control",
    "Access-Control-Max-Age": "86400"
  };
}

module.exports = {
  isPrivateIp,
  isSsrfSafe,
  isHostAllowed,
  sanitizePath,
  filterHopByHopHeaders,
  getCorsHeaders
};
