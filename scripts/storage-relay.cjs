"use strict";

// The bundled SeaweedFS engine has no network interface except loopback; its
// S3 API is exposed only through a Unix socket on a private shared volume.
// This relay is the storage service's only listener on the Compose network,
// so master, volume, filer, gRPC and catalog listeners stay unreachable.

const net = require("node:net");
// The shared dependency-free writer gives relay lines the application's
// timestamp, level, role and content-free field allowlist.
const { logEvent, setProcessRole } = require("../lib/server/observability/runtime.cjs");

setProcessRole("storage_relay");

const socketPath = process.env.AIQSA_STORAGE_SOCKET ?? "";
const port = Number(process.env.AIQSA_STORAGE_RELAY_PORT ?? "9000");
const maxConnections = Number(process.env.AIQSA_STORAGE_RELAY_MAX_CONNECTIONS ?? "512");
// The engine's local socket does not close idle keep-alive connections, so a
// client pool that never closes its sockets held relay slots for hours until
// new connections were dropped at the limit (production 2026-10-22). Clients
// close their own idle sockets well before this.
const idleTimeoutMs = Number(process.env.AIQSA_STORAGE_RELAY_IDLE_TIMEOUT_MS ?? "300000");

function lifecycle(fields) {
  logEvent("runtime_lifecycle", { subsystem: "object_storage", ...fields });
}

if (!socketPath.startsWith("/") || !Number.isSafeInteger(port) || port < 1 || port > 65_535 ||
  !Number.isSafeInteger(maxConnections) || maxConnections < 1 || maxConnections > 65_536 ||
  !Number.isSafeInteger(idleTimeoutMs) || idleTimeoutMs < 100 || idleTimeoutMs > 86_400_000) {
  lifecycle({ stage: "startup", outcome: "failed", action: "stop", code: "storage_relay_configuration_invalid" });
  process.exit(64);
}

// One warning per approach to the limit, re-armed only after the count has
// clearly fallen, so the journal shows the trend before connections drop.
const highWater = Math.ceil(maxConnections * 0.8);
const lowWater = Math.floor(maxConnections * 0.6);
let openConnections = 0;
let nearLimit = false;

const server = net.createServer({ allowHalfOpen: true, noDelay: true }, (client) => {
  openConnections += 1;
  if (!nearLimit && openConnections >= highWater) {
    nearLimit = true;
    lifecycle({ stage: "health", outcome: "degraded", action: "none", code: "storage_relay_connections_high", count: openConnections });
  }
  const upstream = net.connect({ allowHalfOpen: true, path: socketPath });
  let closed = false;
  const close = () => {
    client.destroy();
    upstream.destroy();
    if (closed) return;
    closed = true;
    openConnections -= 1;
    if (nearLimit && openConnections <= lowWater) nearLimit = false;
  };
  // Every relayed byte is read from or written to the client socket, so its
  // inactivity timer covers both directions, and Node defers it while a write
  // is still draining: a transfer that keeps moving is never cut.
  client.setTimeout(idleTimeoutMs, close);
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
let listening = false;
server.on("error", (error) => {
  // A registered system error code (EADDRINUSE ...) or the relay's own code.
  lifecycle({ stage: listening ? "process" : "startup", outcome: "failed", action: "stop",
    code: typeof error?.code === "string" ? error.code : "storage_relay_failed" });
  process.exit(1);
});
server.listen({ host: "0.0.0.0", port }, () => {
  listening = true;
  lifecycle({ stage: "startup", outcome: "completed" });
});

function stop() {
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 5_000).unref();
}
process.on("SIGTERM", stop);
process.on("SIGINT", stop);
