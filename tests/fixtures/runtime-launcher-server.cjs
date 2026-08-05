"use strict";

const http = require("node:http");

module.exports = http.createServer((request, response) => {
  response.setHeader("content-type", "text/plain");

  if (request.url === "/echo") {
    const chunks = [];

    request.on("data", (chunk) => chunks.push(chunk));
    request.on("end", () => response.end(Buffer.concat(chunks)));
    return;
  }

  if (request.url === "/stream") {
    response.write("first\n");
    setImmediate(() => response.end("second\n"));
    return;
  }

  response.end(request.headers["x-aiqsa-runtime-peer"] || "missing");
});
