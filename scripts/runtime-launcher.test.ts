// @vitest-environment node

import { createRequire } from "node:module";
import http, { type Server } from "node:http";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  DIRECT_PEER_HEADER,
  directPeerIdentity,
  getRuntimePeerSecret
} from "../lib/server/auth/clientIdentity";

type Launcher = {
  RuntimePeerBridgeError: new (code: string) => Error;
  canonicalIp(value: string): string | null;
  createPeerStamp(peerAddress: string, sessionSecret: string): string | null;
  launch(target: string): Server;
  warnForDirectHttp(env: Record<string, string | undefined>): void;
};

const require = createRequire(import.meta.url);
const launcher = require("./runtime-launcher.cjs") as Launcher;
const sessionSecret = "runtime-launcher-test-session-secret";

function fixture(name: string): string {
  const target = path.join(process.cwd(), "tests", "fixtures", name);
  delete require.cache[target];
  return target;
}

async function listen(server: Server): Promise<number> {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });

  const address = server.address();

  if (!address || typeof address === "string") {
    throw new Error("runtime_launcher_test_address_unavailable");
  }

  return address.port;
}

async function close(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  });
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe("runtime launcher", () => {
  it("normalizes IPv4-mapped peers before signing", () => {
    expect(launcher.canonicalIp("::ffff:192.168.10.4")).toBe("192.168.10.4");
    expect(launcher.canonicalIp("::ffff:c0a8:a04")).toBe("192.168.10.4");
    expect(launcher.canonicalIp("2001:0DB8:0:0::1")).toBe("2001:db8::1");
    expect(launcher.canonicalIp("fe80::1%eth0")).toBeNull();
  });

  it("overwrites a forged peer header with an authenticated socket peer", async () => {
    vi.stubEnv("AIQSA_AUTH_SESSION_SECRET", sessionSecret);
    vi.stubEnv("AIQSA_APP_BASE_URL", "http://localhost:3000");
    vi.stubEnv("AIQSA_BIND_ADDRESS", "127.0.0.1");
    const originalCreateServer = http.createServer;
    const server = launcher.launch(fixture("runtime-launcher-server.cjs"));
    const port = await listen(server);

    try {
      const response = await fetch(`http://127.0.0.1:${port}`, {
        headers: {
          [DIRECT_PEER_HEADER]: "v1.Zm9yZ2Vk.invalid"
        }
      });
      const stamp = await response.text();
      const identity = directPeerIdentity(
        new Request("http://app.local", {
          headers: { [DIRECT_PEER_HEADER]: stamp }
        }),
        getRuntimePeerSecret()
      );

      expect(identity).toEqual({ key: "ip:127.0.0.1", status: "available" });
      expect(
        directPeerIdentity(
          new Request("http://app.local", {
            headers: { [DIRECT_PEER_HEADER]: stamp }
          }),
          sessionSecret
        )
      ).toEqual({ status: "unavailable" });
      expect(stamp).not.toContain("forged");
      expect(http.createServer).toBe(originalCreateServer);
    } finally {
      await close(server);
    }
  });

  it("passes request bodies and streamed responses through unchanged", async () => {
    const server = launcher.launch(fixture("runtime-launcher-server.cjs"));
    const port = await listen(server);

    try {
      const echoed = await fetch(`http://127.0.0.1:${port}/echo`, {
        body: "multipart-payload",
        method: "POST"
      });
      const streamed = await fetch(`http://127.0.0.1:${port}/stream`);

      expect(await echoed.text()).toBe("multipart-payload");
      expect(await streamed.text()).toBe("first\nsecond\n");
    } finally {
      await close(server);
    }
  });

  it("fails closed when the target does not install the expected server", () => {
    expect(() => launcher.launch(fixture("runtime-launcher-no-server.cjs"))).toThrow(
      "runtime_peer_bridge_not_installed"
    );
  });

  it("emits only a value-free warning for direct HTTP", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    launcher.warnForDirectHttp({
      AIQSA_APP_BASE_URL: "http://192.168.10.4:3000",
      AIQSA_BIND_ADDRESS: "0.0.0.0",
      AIQSA_TRUST_PROXY_HEADERS: ""
    });

    expect(warn).toHaveBeenCalledWith("AIQSA runtime warning: direct_http_transport");
    expect(JSON.stringify(warn.mock.calls)).not.toContain("192.168.10.4");
  });
});
