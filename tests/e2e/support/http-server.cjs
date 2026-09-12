const http = require("node:http");
const next = require("next");

if (process.env.AIQSA_STATEFUL_TEST_TARGET !== "DISPOSABLE" ||
  process.env.AIQSA_TEST_MODE !== "1" || process.env.NODE_ENV === "production") {
  throw new Error("http_test_server_requires_disposable_target");
}

// Use the production peer-stamping launcher with a disposable Next dev server.
const app = next({ dev: true, hostname: "app", port: 3000 });
const server = http.createServer(app.getRequestHandler());
app.prepare().then(() => server.listen(3000, "0.0.0.0")).catch(() => {
  console.error("http_test_server_prepare_failed");
  process.exitCode = 1;
});

module.exports = server;
