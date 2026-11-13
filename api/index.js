/**
 * Vercel Serverless Function Entry Point
 */

const { handleRequest } = require("../src/proxy");

module.exports = function handler(req, res) {
  return handleRequest(req, res);
};
