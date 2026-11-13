/**
 * Configuration module for Bacuflix Reverse Proxy
 */

const DEFAULT_UPSTREAM = "https://phimapi.com";
const DEFAULT_ALLOWED_HOSTS = [
  "phimapi.com",
  "phimimg.com",
  "phim1280.tv",
  "kkphimplayer6.com",
  "kvp726.com",
  "apiaz.xyz",
  "abfedgecanme.com",
  "streamc.xyz",
  "streamvsmov.com",
  "vsmov.com",
  "phim.nguonc.com",
  "opstream.com",
  "opstream1.com",
  "opstream2.com",
  "opstream3.com",
  "bytefury.top",
  "123embed.net",
  "subtitle.123embed.net",
  "raw.githubusercontent.com"
];

function parseAllowedHosts(raw) {
  if (!raw || typeof raw !== "string") {
    return DEFAULT_ALLOWED_HOSTS.slice();
  }
  const parts = raw.split(",").map(s => s.trim().toLowerCase()).filter(Boolean);
  return parts.length > 0 ? parts : DEFAULT_ALLOWED_HOSTS.slice();
}

function getConfig() {
  const env = process.env || {};
  const upstreamBaseUrl = (env.UPSTREAM_BASE_URL || DEFAULT_UPSTREAM).trim().replace(/\/+$/, "");
  const allowedHosts = parseAllowedHosts(env.ALLOWED_STREAM_HOSTS);
  
  // Ensure the hostname of UPSTREAM_BASE_URL is always included in allowedHosts
  try {
    const upstreamHost = new URL(upstreamBaseUrl).hostname.toLowerCase();
    if (!allowedHosts.includes(upstreamHost) && !allowedHosts.includes("*")) {
      allowedHosts.push(upstreamHost);
    }
  } catch (_) {}

  return {
    port: parseInt(env.PORT || "3000", 10),
    upstreamBaseUrl: upstreamBaseUrl,
    allowedHosts: allowedHosts,
    corsOrigin: env.CORS_ORIGIN || "*",
    timeoutMs: parseInt(env.REQUEST_TIMEOUT_MS || "15000", 10)
  };
}

module.exports = {
  DEFAULT_UPSTREAM,
  DEFAULT_ALLOWED_HOSTS,
  getConfig
};
