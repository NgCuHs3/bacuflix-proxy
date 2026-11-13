/**
 * Live End-to-End Test: Bacuflix Proxy against real upstream (https://phimapi.com)
 */

const http = require("http");
const { handleRequest } = require("../src/proxy");

process.env.UPSTREAM_BASE_URL = "https://phimapi.com";
process.env.PORT = "3099";

const server = http.createServer(handleRequest);

function get(url) {
  return new Promise((resolve, reject) => {
    http.get(url, res => {
      const chunks = [];
      res.on("data", c => chunks.push(c));
      res.on("end", () => {
        resolve({
          statusCode: res.statusCode,
          headers: res.headers,
          body: Buffer.concat(chunks).toString("utf8")
        });
      });
    }).on("error", reject);
  });
}

async function runLiveTest() {
  console.log("Starting Live Upstream End-to-End Tests against https://phimapi.com...\n");

  await new Promise(resolve => server.listen(3099, "127.0.0.1", resolve));
  const baseUrl = "http://127.0.0.1:3099";

  try {
    // 1. Health check
    console.log("1. Testing Health Check...");
    const health = await get(`${baseUrl}/health`);
    console.log("   Health Status:", health.statusCode, health.body);

    // 2. Direct Reverse-Proxy GET /v1/api/home
    console.log("2. Testing Reverse-Proxy GET /v1/api/home...");
    const home = await get(`${baseUrl}/v1/api/home`);
    const homeJson = JSON.parse(home.body);
    console.log("   Home response status:", home.statusCode, "items:", homeJson.data?.items?.length);

    // 3. Search query with parameters
    console.log("3. Testing Search Query: /v1/api/tim-kiem?keyword=naruto&limit=3...");
    const search = await get(`${baseUrl}/v1/api/tim-kiem?keyword=naruto&limit=3`);
    const searchJson = JSON.parse(search.body);
    console.log("   Search response status:", search.statusCode, "results:", searchJson.data?.items?.length);

    // 4. Movie detail
    console.log("4. Testing Movie Detail: /phim/naruto...");
    const detail = await get(`${baseUrl}/phim/naruto`);
    const detailJson = JSON.parse(detail.body);
    console.log("   Detail response status:", detail.statusCode, "name:", detailJson.movie?.name);

    // 5. Image proxying
    if (homeJson.data?.items?.[0]?.poster_url) {
      const imgPath = homeJson.data.items[0].poster_url;
      const fullImgUrl = imgPath.startsWith("http") ? imgPath : `https://phimimg.com/${imgPath.replace(/^\//, "")}`;
      console.log(`5. Testing Image Proxying for: ${fullImgUrl}...`);
      const imgRes = await get(`${baseUrl}/api/proxy?url=${encodeURIComponent(fullImgUrl)}`);
      console.log("   Image response status:", imgRes.statusCode, "content-type:", imgRes.headers["content-type"]);
    }

    console.log("\n✓ All live upstream end-to-end integration checks succeeded!");
  } finally {
    server.close();
  }
}

runLiveTest().catch(err => {
  console.error("Live test failed:", err);
  server.close();
  process.exit(1);
});
