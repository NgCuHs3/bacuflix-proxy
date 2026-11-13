/**
 * HLS (.m3u8) Playlist Parser & URL Rewriter
 * Rewrites relative and absolute segment/variant/key URIs so all subsequent
 * HLS streaming requests route transparently through the proxy.
 */

function rewriteUriAttribute(line, attributeName, upstreamPlaylistUrl, proxyEndpoint) {
  const regex = new RegExp(`(${attributeName}=["'])([^"']+)(["'])`, "gi");
  return line.replace(regex, (match, prefix, uri, suffix) => {
    try {
      const absoluteUrl = new URL(uri, upstreamPlaylistUrl).href;
      const proxiedUrl = `${proxyEndpoint}?url=${encodeURIComponent(absoluteUrl)}`;
      return `${prefix}${proxiedUrl}${suffix}`;
    } catch (_) {
      return match;
    }
  });
}

function rewriteM3u8(playlistContent, upstreamPlaylistUrl, proxyBaseUrl) {
  if (typeof playlistContent !== "string") {
    return playlistContent;
  }

  const base = proxyBaseUrl ? proxyBaseUrl.replace(/\/+$/, "") : "";
  const proxyEndpoint = base + "/api/proxy";

  const lines = playlistContent.split(/\r?\n/);
  const rewrittenLines = lines.map(line => {
    const trimmed = line.trim();
    if (!trimmed) {
      return line;
    }

    // Directives with URI attributes
    if (trimmed.startsWith("#")) {
      let modified = line;
      if (trimmed.startsWith("#EXT-X-KEY") || trimmed.startsWith("#EXT-X-MAP") || 
          trimmed.startsWith("#EXT-X-MEDIA") || trimmed.startsWith("#EXT-X-PRELOAD-HINT") ||
          trimmed.startsWith("#EXT-X-RENDITION-REPORT")) {
        modified = rewriteUriAttribute(modified, "URI", upstreamPlaylistUrl, proxyEndpoint);
      }
      return modified;
    }

    // Media segment or Variant sub-playlist URI
    try {
      const absoluteUrl = new URL(trimmed, upstreamPlaylistUrl).href;
      return `${proxyEndpoint}?url=${encodeURIComponent(absoluteUrl)}`;
    } catch (_) {
      return line;
    }
  });

  return rewrittenLines.join("\n");
}

module.exports = {
  rewriteM3u8
};
