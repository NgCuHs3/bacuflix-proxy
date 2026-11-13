/**
 * Local Standalone Server for Bacuflix Reverse Proxy
 * Runs with 'node server.js' or 'npm run dev'
 */

const http = require("http");
const { getConfig } = require("./src/config");
const { handleRequest } = require("./src/proxy");

const config = getConfig();
const server = http.createServer(handleRequest);

server.listen(config.port, "0.0.0.0", () => {
  console.log(`===============================================`);
  console.log(`Bacuflix Reverse Proxy Server running!`);
  console.log(`Port:              ${config.port}`);
  console.log(`Upstream Base URL: ${config.upstreamBaseUrl}`);
  console.log(`Allowed Hosts:     ${config.allowedHosts.join(", ")}`);
  console.log(`Local URL:         http://localhost:${config.port}/`);
  console.log(`Health Check:      http://localhost:${config.port}/health`);
  console.log(`===============================================`);
});
