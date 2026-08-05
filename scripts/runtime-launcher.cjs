"use strict";

const { createHmac, randomBytes } = require("node:crypto");
const http = require("node:http");
const { isIP } = require("node:net");
const path = require("node:path");

const DIRECT_PEER_HEADER = "x-aiqsa-runtime-peer";
const DIRECT_PEER_MAC_DOMAIN = "aiqsa:runtime-peer-stamp:v1\0";
const DIRECT_PEER_VERSION = "v1";
const RUNTIME_PEER_SECRET_SYMBOL = Symbol.for("aiqsa.runtime-peer-secret.v1");
const runtimePeerSecret = randomBytes(32).toString("base64url");

Object.defineProperty(globalThis, RUNTIME_PEER_SECRET_SYMBOL, {
  configurable: false,
  enumerable: false,
  value: runtimePeerSecret,
  writable: false
});

class RuntimePeerBridgeError extends Error {
  constructor(code) {
    super(code);
    this.code = code;
    this.name = "RuntimePeerBridgeError";
  }
}

function mappedIpv4(canonicalIpv6) {
  const match = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(canonicalIpv6);

  if (!match) return null;

  const high = Number.parseInt(match[1], 16);
  const low = Number.parseInt(match[2], 16);

  return `${high >>> 8}.${high & 0xff}.${low >>> 8}.${low & 0xff}`;
}

function canonicalIp(value) {
  if (typeof value !== "string" || value !== value.trim() || value.includes("%")) {
    return null;
  }

  const family = isIP(value);

  if (family === 4) {
    return value;
  }

  if (family === 6) {
    try {
      const canonical = new URL(`http://[${value}]/`).hostname.slice(1, -1).toLowerCase();

      return mappedIpv4(canonical) ?? canonical;
    } catch {
      return null;
    }
  }

  return null;
}

function createPeerStamp(peerAddress, peerSecret) {
  const canonical = canonicalIp(peerAddress);

  if (!canonical || typeof peerSecret !== "string" || !peerSecret) {
    return null;
  }

  const encodedPeer = Buffer.from(canonical, "utf8").toString("base64url");
  const mac = createHmac("sha256", peerSecret)
    .update(DIRECT_PEER_MAC_DOMAIN, "utf8")
    .update(encodedPeer, "ascii")
    .digest("base64url");

  return `${DIRECT_PEER_VERSION}.${encodedPeer}.${mac}`;
}

function createCurrentPeerStamp(peerAddress) {
  return createPeerStamp(peerAddress, runtimePeerSecret);
}

function overwritePeerHeader(request, stamp) {
  delete request.headers[DIRECT_PEER_HEADER];

  for (let index = request.rawHeaders.length - 2; index >= 0; index -= 2) {
    if (request.rawHeaders[index].toLowerCase() === DIRECT_PEER_HEADER) {
      request.rawHeaders.splice(index, 2);
    }
  }

  if (stamp) {
    request.headers[DIRECT_PEER_HEADER] = stamp;
    request.rawHeaders.push(DIRECT_PEER_HEADER, stamp);
  }
}

function stampRequest(request) {
  const stamp = createCurrentPeerStamp(request.socket?.remoteAddress);
  overwritePeerHeader(request, stamp);
}

function isLoopbackHostname(hostname) {
  const normalized = hostname.replace(/^\[|\]$/g, "").toLowerCase();

  if (normalized === "localhost" || normalized.endsWith(".localhost")) {
    return true;
  }

  const canonical = canonicalIp(normalized);

  return canonical === "::1" || canonical?.startsWith("127.") === true;
}

function enabled(value) {
  return new Set(["1", "true", "yes", "on"]).has(value?.trim().toLowerCase() ?? "");
}

function warnForDirectHttp(env) {
  const bindAddress = env.AIQSA_BIND_ADDRESS?.trim() || "127.0.0.1";

  if (enabled(env.AIQSA_TRUST_PROXY_HEADERS) || isLoopbackHostname(bindAddress)) {
    return;
  }

  try {
    if (new URL(env.AIQSA_APP_BASE_URL?.trim() || "http://localhost:3000").protocol === "http:") {
      console.warn("AIQSA runtime warning: direct_http_transport");
    }
  } catch {
    // Readiness reports the value-free app_base_url issue.
  }
}

function launch(target = "runtime/server.js") {
  const originalCreateServer = http.createServer;
  let interceptionCount = 0;

  http.createServer = function createRuntimePeerServer(...args) {
    interceptionCount += 1;

    if (interceptionCount !== 1) {
      throw new RuntimePeerBridgeError("runtime_peer_bridge_multiple_servers");
    }

    const listenerIndex = args.length - 1;
    const listener = args[listenerIndex];

    if (typeof listener !== "function") {
      throw new RuntimePeerBridgeError("runtime_peer_bridge_listener_missing");
    }

    args[listenerIndex] = function runtimePeerRequestListener(request, response) {
      stampRequest(request);
      return Reflect.apply(listener, this, [request, response]);
    };

    return Reflect.apply(originalCreateServer, this, args);
  };

  let targetExports;

  try {
    targetExports = require(path.resolve(process.cwd(), target));
  } finally {
    http.createServer = originalCreateServer;
  }

  if (interceptionCount !== 1) {
    throw new RuntimePeerBridgeError("runtime_peer_bridge_not_installed");
  }

  warnForDirectHttp(process.env);

  return targetExports;
}

if (require.main === module) {
  try {
    launch(process.argv[2]);
  } catch (error) {
    if (error instanceof RuntimePeerBridgeError) {
      console.error(`AIQSA runtime failed: ${error.code}`);
      process.exitCode = 1;
    } else {
      throw error;
    }
  }
}

module.exports = {
  DIRECT_PEER_HEADER,
  RuntimePeerBridgeError,
  canonicalIp,
  createCurrentPeerStamp,
  createPeerStamp,
  launch,
  overwritePeerHeader,
  stampRequest,
  warnForDirectHttp
};
