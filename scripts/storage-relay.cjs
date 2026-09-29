"use strict";

// The bundled SeaweedFS engine has no network interface except loopback; its
// S3 API is exposed only through a Unix socket on a private shared volume.
// This relay is the storage service's only listener on the Compose network,
// so master, volume, filer, gRPC and catalog listeners stay unreachable.

const net = require("node:net");

const socketPath = process.env.AIQSA_STORAGE_SOCKET ?? "";
const port = Number(process.env.AIQSA_STORAGE_RELAY_PORT ?? "9000");
const maxConnections = Number(process.env.AIQSA_STORAGE_RELAY_MAX_CONNECTIONS ?? "512");

function log(event, fields = {}) {
  process.stdout.write(`${JSON.stringify({ event, ...fields })}\n`);
}

if (!socketPath.startsWith("/") || !Number.isSafeInteger(port) || port < 1 || port > 65_535 ||
  !Number.isSafeInteger(maxConnections) || maxConnections < 1 || maxConnections > 65_536) {
  log("storage_relay_configuration_invalid");
  process.exit(64);
}

const server = net.createServer({ allowHalfOpen: true, noDelay: true }, (client) => {
  const upstream = net.connect({ allowHalfOpen: true, path: socketPath });
  const close = () => {
    client.destroy();
    upstream.destroy();
  };
  client.on("error", close);
  upstream.on("error", close);
  client.on("close", close);
  upstream.on("close", close);
  // pipe() propagates each half-close, so a request body end never cuts off
  // the response still streaming in the other direction.
  client.pipe(upstream);
  upstream.pipe(client);
});
server.maxConnections = maxConnections;
server.on("error", (error) => {
  log("storage_relay_failed", { code: typeof error?.code === "string" ? error.code : "unknown" });
  process.exit(1);
});
server.listen({ host: "0.0.0.0", port }, () => log("storage_relay_listening", { port }));

function stop() {
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 5_000).unref();
}
process.on("SIGTERM", stop);
process.on("SIGINT", stop);
