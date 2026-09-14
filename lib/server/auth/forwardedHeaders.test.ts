// @vitest-environment node
import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";
import { resolveLoginRateLimitIdentity } from "./clientIdentity";

const require = createRequire(import.meta.url);
const { preserveForwardedIdentity } = require("./forwardedHeaders.cjs") as {
  preserveForwardedIdentity(request: { headers: Record<string, string>; rawHeaders: string[] }): void;
};
const BaseServer = require("next/dist/server/base-server.js").default;
const { NodeNextRequest } = require("next/dist/server/base-http/node.js");

describe("forwarded identity before framework normalization", () => {
  it.each([
    { value: undefined, hops: 1, key: undefined },
    { value: "", hops: 1, key: undefined },
    { value: "malformed", hops: 1, key: undefined },
    { value: "192.0.2.1", hops: 1, key: "ip:192.0.2.1" },
    { value: "spoofed, 192.0.2.1, 192.0.2.2", hops: 2, key: "ip:192.0.2.1" }
  ])("preserves missing and valid identity through Next: $value / $hops", async ({ value, hops, key }) => {
    const raw = { method: "POST", url: "/api/auth/login", rawHeaders: [] as string[],
      headers: { host: "fixture.invalid" } as Record<string, string>, socket: { remoteAddress: "192.0.2.99" } };
    if (value !== undefined) { raw.headers["x-forwarded-for"] = value; raw.rawHeaders.push("X-Forwarded-For", value); }
    preserveForwardedIdentity(raw);
    preserveForwardedIdentity(raw);
    expect(raw.rawHeaders).toEqual(["X-Forwarded-For", value ?? ""]);
    const request = new NodeNextRequest(raw);
    const server = { matchers: { waitTillReady: async () => undefined }, hostname: "fixture.invalid", port: 3000,
      attachRequestMeta() {}, handleRSCRequest: async () => true };
    await BaseServer.prototype.handleRequestImpl.call(server, request,
      { originalResponse: { setHeader() {}, getHeader() {}, headersSent: false } }, { pathname: raw.url, query: {} });
    expect(request.headers["x-forwarded-for"]).toBe(value ?? "");
    const identity = resolveLoginRateLimitIdentity(new Request("http://fixture.invalid/api/auth/login", { headers: request.headers }), {
      clientIdentityMode: "trusted_proxy", trustedProxyCount: hops, runtimePeerSecret: ""
    });
    expect(identity).toEqual(key ? { status: "available", key } : { status: "unavailable" });
  });
});
