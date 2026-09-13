"use strict";

const http = require("node:http");
const https = require("node:https");
const { wrapHttpListener } = require("../lib/server/observability/http.cjs");
const { installProcessFailureHooks } = require("../lib/server/observability/process.cjs");
const { announceProcess } = require("../lib/server/observability/runtime.cjs");
const BOOTSTRAP = Symbol.for("aiqsa.observability.dev-bootstrap.v1");

function installDevBootstrap() {
  installProcessFailureHooks();
  announceProcess({ attachments: "unknown", memory: "unknown", knowledge: "unknown", mcp: "unknown", workspace: "unknown", email: "unknown" });
  if (globalThis[BOOTSTRAP]) return;
  globalThis[BOOTSTRAP] = true;
  for (const transport of [http, https]) {
    const createServer = transport.createServer;
    transport.createServer = function createObservedDevServer(...args) {
      const listenerIndex = args.length - 1;
      if (typeof args[listenerIndex] === "function") {
        args[listenerIndex] = wrapHttpListener(args[listenerIndex]);
      }
      return Reflect.apply(createServer, this, args);
    };
  }
}

installDevBootstrap();

module.exports = { installDevBootstrap };
