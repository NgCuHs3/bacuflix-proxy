/**
 * Bacuflix Reverse Proxy Test Suite
 * Validates all 11 required scenarios from proxy-server.md plus security & CORS.
 */

const assert = require("assert");
const http = require("http");
const { handleRequest } = require("../src/proxy");
const { isSsrfSafe, isHostAllowed, sanitizePath } = require("../src/security");
const { rewriteM3u8 } = require("../src/hls-rewriter");

process.env.NODE_ENV = "test";
process.env.ALLOW_TEST_LOCALHOST = "1";

let mockUpstreamServer;
let mockUpstreamPort;
let proxyServer;
let proxyPort;

// Helper to make HTTP requests
function request(options, bodyData) {
  return new Promise((resolve, reject) => {
    const req = http.request(options, res => {
      const chunks = [];
      res.on("data", chunk => chunks.push(chunk));
      res.on("end", () => {
        const buffer = Buffer.concat(chunks);
        resolve({
          statusCode: res.statusCode,
          headers: res.headers,
          body: buffer.toString("utf8"),
          buffer: buffer
        });
      });
    });
    req.on("error", reject);
    if (bodyData) {
      req.write(bodyData);
    }
    req.end();
  });
}

async function runTests() {
  console.log("Starting Bacuflix Proxy Test Suite...\n");

  // 1. Setup Mock Upstream Server
  await new Promise((resolve, reject) => {
    mockUpstreamServer = http.createServer((req, res) => {
      const parsed = new URL(req.url, `http://localhost:${mockUpstreamPort}`);

      // Route: JSON API
      if (parsed.pathname === "/v1/api/home") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ status: "success", page: parsed.searchParams.get("page") || "1" }));
        return;
      }

      // Route: POST endpoint
      if (parsed.pathname === "/api/login" && req.method === "POST") {
        let body = "";
        req.on("data", c => (body += c));
        req.on("end", () => {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ receivedBody: JSON.parse(body), authHeader: req.headers["authorization"] }));
        });
        return;
      }

      // Route: Auth check
      if (parsed.pathname === "/api/protected") {
        if (req.headers["authorization"] === "Bearer secret-token-123") {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ authorized: true }));
        } else {
          res.writeHead(401, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "Unauthorized" }));
        }
        return;
      }

      // Route: 404 / 500 error triggers
      if (parsed.pathname === "/not-found") {
        res.writeHead(404, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Item not found" }));
        return;
      }
      if (parsed.pathname === "/server-error") {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Internal Server Failure" }));
        return;
      }

      // Route: Image binary
      if (parsed.pathname === "/image.png") {
        const dummyPng = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x01, 0x02]);
        res.writeHead(200, { "Content-Type": "image/png", "Content-Length": dummyPng.length });
        res.end(dummyPng);
        return;
      }

      // Route: Subtitle SRT
      if (parsed.pathname === "/sub.srt") {
        const srt = "1\n00:00:01,000 --> 00:00:03,000\nXin chào Bacuflix!\n";
        res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" });
        res.end(srt);
        return;
      }

      // Route: HLS Playlist (.m3u8)
      if (parsed.pathname === "/stream/master.m3u8") {
        const playlist = [
          "#EXTM3U",
          "#EXT-X-VERSION:3",
          "#EXT-X-TARGETDURATION:10",
          '#EXT-X-KEY:METHOD=AES-128,URI="key.php?id=99"',
          "#EXTINF:10.0,",
          "segment0.ts",
          "#EXTINF:10.0,",
          "https://cdn.example.com/segment1.ts",
          "#EXT-X-ENDLIST"
        ].join("\n");
        res.writeHead(200, { "Content-Type": "application/vnd.apple.mpegurl" });
        res.end(playlist);
        return;
      }

      // Route: HLS Segment (.ts)
      if (parsed.pathname === "/stream/segment0.ts") {
        const dummyTs = Buffer.alloc(188 * 5, 0x47); // standard MPEG-TS sync byte packets
        res.writeHead(200, { "Content-Type": "video/mp2t", "Content-Length": dummyTs.length });
        res.end(dummyTs);
        return;
      }

      // Route: Range requests (MP4 / large binary)
      if (parsed.pathname === "/video.mp4") {
        const totalSize = 10000;
        const fakeData = Buffer.alloc(totalSize, 0xaa);
        const range = req.headers["range"];

        if (range) {
          const parts = range.replace(/bytes=/, "").split("-");
          const start = parseInt(parts[0], 10);
          const end = parts[1] ? parseInt(parts[1], 10) : totalSize - 1;
          const chunkSize = end - start + 1;

          res.writeHead(206, {
            "Content-Range": `bytes ${start}-${end}/${totalSize}`,
            "Accept-Ranges": "bytes",
            "Content-Length": chunkSize,
            "Content-Type": "video/mp4"
          });
          res.end(fakeData.slice(start, end + 1));
        } else {
          res.writeHead(200, {
            "Content-Length": totalSize,
            "Content-Type": "video/mp4",
            "Accept-Ranges": "bytes"
          });
          res.end(fakeData);
        }
        return;
      }

      // Route: Large streaming response
      if (parsed.pathname === "/stream-large") {
        res.writeHead(200, { "Content-Type": "application/octet-stream" });
        for (let i = 0; i < 5; i++) {
          res.write(Buffer.alloc(1024, i));
        }
        res.end();
        return;
      }

      res.writeHead(404);
      res.end("Not Found");
    });

    mockUpstreamServer.listen(0, "127.0.0.1", () => {
      mockUpstreamPort = mockUpstreamServer.address().port;
      resolve();
    });
  });

  // Set UPSTREAM_BASE_URL to mockUpstreamServer
  process.env.UPSTREAM_BASE_URL = `http://127.0.0.1:${mockUpstreamPort}`;
  process.env.ALLOWED_STREAM_HOSTS = `127.0.0.1,localhost,phimapi.com,phimimg.com,cdn.example.com`;

  // 2. Setup Proxy Server
  await new Promise((resolve, reject) => {
    proxyServer = http.createServer(handleRequest);
    proxyServer.listen(0, "127.0.0.1", () => {
      proxyPort = proxyServer.address().port;
      resolve();
    });
  });

  console.log(`Mock Upstream Server listening on port ${mockUpstreamPort}`);
  console.log(`Proxy Server listening on port ${proxyPort}\n`);

  try {
    // ----------------------------------------------------
    // Test 1: GET request forwarding
    // ----------------------------------------------------
    const res1 = await request({
      hostname: "127.0.0.1",
      port: proxyPort,
      path: "/v1/api/home",
      method: "GET"
    });
    assert.equal(res1.statusCode, 200, "Test 1 Failed: Status should be 200");
    const json1 = JSON.parse(res1.body);
    assert.equal(json1.status, "success", "Test 1 Failed: Response status");
    assert.equal(res1.headers["access-control-allow-origin"], "*", "Test 1 Failed: CORS header");
    console.log("✓ Test 1: GET request forwarding passed.");

    // ----------------------------------------------------
    // Test 2: POST request forwarding with body
    // ----------------------------------------------------
    const postPayload = JSON.stringify({ username: "testuser", pin: "1234" });
    const res2 = await request(
      {
        hostname: "127.0.0.1",
        port: proxyPort,
        path: "/api/login",
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(postPayload),
          Authorization: "Bearer token-abc"
        }
      },
      postPayload
    );
    assert.equal(res2.statusCode, 200, "Test 2 Failed: Status should be 200");
    const json2 = JSON.parse(res2.body);
    assert.equal(json2.receivedBody.username, "testuser", "Test 2 Failed: Body forwarding");
    assert.equal(json2.authHeader, "Bearer token-abc", "Test 2 Failed: Auth header on POST");
    console.log("✓ Test 2: POST request forwarding with body passed.");

    // ----------------------------------------------------
    // Test 3: Query parameter preservation
    // ----------------------------------------------------
    const res3 = await request({
      hostname: "127.0.0.1",
      port: proxyPort,
      path: "/v1/api/home?page=42&filter=vietnam",
      method: "GET"
    });
    assert.equal(res3.statusCode, 200);
    const json3 = JSON.parse(res3.body);
    assert.equal(json3.page, "42", "Test 3 Failed: Query param page preserved");
    console.log("✓ Test 3: Query parameter preservation passed.");

    // ----------------------------------------------------
    // Test 4: Authorization header forwarding
    // ----------------------------------------------------
    const res4Success = await request({
      hostname: "127.0.0.1",
      port: proxyPort,
      path: "/api/protected",
      method: "GET",
      headers: { Authorization: "Bearer secret-token-123" }
    });
    assert.equal(res4Success.statusCode, 200);
    assert.equal(JSON.parse(res4Success.body).authorized, true);

    const res4Fail = await request({
      hostname: "127.0.0.1",
      port: proxyPort,
      path: "/api/protected",
      method: "GET",
      headers: { Authorization: "Bearer wrong-token" }
    });
    assert.equal(res4Fail.statusCode, 401);
    console.log("✓ Test 4: Authorization header forwarding passed.");

    // ----------------------------------------------------
    // Test 5: HTTP error handling
    // ----------------------------------------------------
    const res5_404 = await request({
      hostname: "127.0.0.1",
      port: proxyPort,
      path: "/not-found",
      method: "GET"
    });
    assert.equal(res5_404.statusCode, 404);

    const res5_500 = await request({
      hostname: "127.0.0.1",
      port: proxyPort,
      path: "/server-error",
      method: "GET"
    });
    assert.equal(res5_500.statusCode, 500);
    console.log("✓ Test 5: HTTP error handling passed.");

    // ----------------------------------------------------
    // Test 6: JSON response integrity
    // ----------------------------------------------------
    const testJsonUrl = `http://127.0.0.1:${mockUpstreamPort}/v1/api/home?page=99`;
    const res6 = await request({
      hostname: "127.0.0.1",
      port: proxyPort,
      path: `/api/proxy?url=${encodeURIComponent(testJsonUrl)}`,
      method: "GET"
    });
    assert.equal(res6.statusCode, 200);
    const json6 = JSON.parse(res6.body);
    assert.equal(json6.page, "99");
    console.log("✓ Test 6: JSON response integrity passed.");

    // ----------------------------------------------------
    // Test 7: Image and subtitle delivery
    // ----------------------------------------------------
    // Image
    const res7Img = await request({
      hostname: "127.0.0.1",
      port: proxyPort,
      path: "/image.png",
      method: "GET"
    });
    assert.equal(res7Img.statusCode, 200);
    assert.equal(res7Img.headers["content-type"], "image/png");
    assert.equal(res7Img.buffer[0], 0x89);
    assert.equal(res7Img.buffer[1], 0x50);

    // Subtitle
    const res7Sub = await request({
      hostname: "127.0.0.1",
      port: proxyPort,
      path: "/sub.srt",
      method: "GET"
    });
    assert.equal(res7Sub.statusCode, 200);
    assert.ok(res7Sub.body.includes("Xin chào Bacuflix!"));
    console.log("✓ Test 7: Image and subtitle delivery passed.");

    // ----------------------------------------------------
    // Test 8: HLS playlist retrieval & URL rewriting
    // ----------------------------------------------------
    const hlsUrl = `http://127.0.0.1:${mockUpstreamPort}/stream/master.m3u8`;
    const res8 = await request({
      hostname: "127.0.0.1",
      port: proxyPort,
      path: `/api/proxy?url=${encodeURIComponent(hlsUrl)}`,
      method: "GET",
      headers: {
        Host: `127.0.0.1:${proxyPort}`
      }
    });
    assert.equal(res8.statusCode, 200);
    assert.ok(
      res8.headers["content-type"].includes("application/vnd.apple.mpegurl"),
      "Should have HLS content-type"
    );
    const lines = res8.body.split("\n");
    // Check relative segment rewrite
    const segLine = lines.find(l => l.includes("segment0.ts"));
    assert.ok(segLine, "Must contain segment0.ts");
    assert.ok(
      segLine.startsWith(`http://127.0.0.1:${proxyPort}/api/proxy?url=`),
      "Relative segment must be rewritten with proxy prefix"
    );

    // Check absolute segment rewrite
    const absLine = lines.find(l => l.includes("segment1.ts"));
    assert.ok(absLine, "Must contain segment1.ts");
    assert.ok(
      absLine.startsWith(`http://127.0.0.1:${proxyPort}/api/proxy?url=`),
      "Absolute segment must be rewritten with proxy prefix"
    );

    // Check KEY URI rewrite
    const keyLine = lines.find(l => l.includes("#EXT-X-KEY"));
    assert.ok(keyLine && keyLine.includes('URI="http://127.0.0.1:'), "KEY URI must be rewritten through proxy");
    console.log("✓ Test 8: HLS playlist retrieval & URL rewriting passed.");

    // ----------------------------------------------------
    // Test 9: HLS segment retrieval (.ts streaming)
    // ----------------------------------------------------
    const res9 = await request({
      hostname: "127.0.0.1",
      port: proxyPort,
      path: "/stream/segment0.ts",
      method: "GET"
    });
    assert.equal(res9.statusCode, 200);
    assert.equal(res9.headers["content-type"], "video/mp2t");
    assert.equal(res9.buffer.length, 188 * 5);
    assert.equal(res9.buffer[0], 0x47, "MPEG-TS sync byte check");
    console.log("✓ Test 9: HLS segment retrieval (.ts streaming) passed.");

    // ----------------------------------------------------
    // Test 10: HTTP Range requests (206 Partial Content)
    // ----------------------------------------------------
    const res10 = await request({
      hostname: "127.0.0.1",
      port: proxyPort,
      path: "/video.mp4",
      method: "GET",
      headers: { Range: "bytes=100-299" }
    });
    assert.equal(res10.statusCode, 206, "Range response must be 206 Partial Content");
    assert.equal(res10.headers["content-range"], "bytes 100-299/10000");
    assert.equal(res10.headers["content-length"], "200");
    assert.equal(res10.buffer.length, 200);
    console.log("✓ Test 10: HTTP Range requests (206 Partial Content) passed.");

    // ----------------------------------------------------
    // Test 11: Large response streaming
    // ----------------------------------------------------
    const res11 = await request({
      hostname: "127.0.0.1",
      port: proxyPort,
      path: "/stream-large",
      method: "GET"
    });
    assert.equal(res11.statusCode, 200);
    assert.equal(res11.buffer.length, 5120);
    console.log("✓ Test 11: Large response streaming passed.");

    // ----------------------------------------------------
    // Test 12: Security & SSRF Protection
    // ----------------------------------------------------
    // Test blocking private IPs when ALLOW_TEST_LOCALHOST is disabled
    process.env.ALLOW_TEST_LOCALHOST = "0";
    const ssrfPrivate1 = isSsrfSafe("http://127.0.0.1:8080/evil");
    assert.equal(ssrfPrivate1.safe, false, "Should block 127.0.0.1");
    const ssrfPrivate2 = isSsrfSafe("http://10.0.0.1/admin");
    assert.equal(ssrfPrivate2.safe, false, "Should block 10.0.0.1");
    const ssrfPrivate3 = isSsrfSafe("http://192.168.1.1/secret");
    assert.equal(ssrfPrivate3.safe, false, "Should block 192.168.1.1");
    const ssrfPrivate4 = isSsrfSafe("http://169.254.169.254/latest/meta-data");
    assert.equal(ssrfPrivate4.safe, false, "Should block cloud metadata 169.254.169.254");
    const ssrfProtocol = isSsrfSafe("file:///etc/passwd");
    assert.equal(ssrfProtocol.safe, false, "Should block file:// protocol");
    const ssrfCredentials = isSsrfSafe("http://admin:pass@example.com/");
    assert.equal(ssrfCredentials.safe, false, "Should block credentials in URL");

    // Test Host Whitelisting
    const allowed = ["phimapi.com", "phimimg.com", "phim1280.tv"];
    assert.equal(isHostAllowed("phimapi.com", allowed, "phimapi.com"), true);
    assert.equal(isHostAllowed("s2.phim1280.tv", allowed, "phimapi.com"), true, "Subdomain of allowed host must be allowed");
    assert.equal(isHostAllowed("evil-hacker.com", allowed, "phimapi.com"), false, "Untrusted host must be blocked");

    // Test Path Traversal Sanitization
    assert.equal(sanitizePath("/../../etc/passwd"), "/etc/passwd");
    assert.equal(sanitizePath("////v1//api//home"), "/v1/api/home");

    // Test Health Check
    const resHealth = await request({
      hostname: "127.0.0.1",
      port: proxyPort,
      path: "/health",
      method: "GET"
    });
    assert.equal(resHealth.statusCode, 200);
    const healthJson = JSON.parse(resHealth.body);
    assert.equal(healthJson.status, "ok");
    assert.equal(healthJson.service, "bacuflix-proxy");

    console.log("✓ Test 12: Security (SSRF, Host Whitelist, Path Sanitization, Health Check) passed.");

    console.log("\n=======================================================");
    console.log("ALL 12 TEST SUITES COMPLETED AND PASSED SUCCESSFULLY!");
    console.log("=======================================================\n");
  } finally {
    if (proxyServer) proxyServer.close();
    if (mockUpstreamServer) mockUpstreamServer.close();
  }
}

runTests().catch(err => {
  console.error("Test Suite Failed:", err);
  if (proxyServer) proxyServer.close();
  if (mockUpstreamServer) mockUpstreamServer.close();
  process.exit(1);
});
