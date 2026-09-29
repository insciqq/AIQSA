import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it, vi } from "vitest";
import { boundedBytes, callbackCode, installationOrigin, sameOriginFetch, withSession } from "./auth";
import { sha256 } from "./files";

const directories: string[] = [];
afterEach(async () => { vi.restoreAllMocks(); vi.unstubAllGlobals(); await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true }))); });
describe("transfer client credential boundary", () => {
  it("accepts installation origins and confines insecure transport to loopback", () => {
    expect(installationOrigin("https://aiqsa.example/")).toBe("https://aiqsa.example");
    expect(installationOrigin("http://127.0.0.1:3000")).toBe("http://127.0.0.1:3000");
    for (const value of ["http://aiqsa.example", "https://user:password@aiqsa.example", "https://aiqsa.example/?token=x", "https://aiqsa.example/path", "file:///tmp/example"]) expect(() => installationOrigin(value)).toThrow("origin_invalid");
  });

  it("rejects discovery outside the chosen origin before network I/O", async () => {
    const fetch = vi.fn(); vi.stubGlobal("fetch", fetch);
    await expect(sameOriginFetch("https://aiqsa.example")("https://other.example/oauth/token")).rejects.toThrow("cross_origin_request_denied");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("requires a unique callback state, code and exact issuer before exchange", () => {
    const callback = new URL("http://127.0.0.1:4000/callback?state=selected-state&code=auth-code&iss=https%3A%2F%2Faiqsa.example");
    expect(callbackCode(callback, "selected-state", "https://aiqsa.example")).toBe("auth-code");
    for (const key of ["state", "code", "iss"]) {
      const missing = new URL(callback); missing.searchParams.delete(key);
      expect(callbackCode(missing, "selected-state", "https://aiqsa.example")).toBeNull();
      const duplicate = new URL(callback); duplicate.searchParams.append(key, callback.searchParams.get(key)!);
      expect(callbackCode(duplicate, "selected-state", "https://aiqsa.example")).toBeNull();
    }
    expect(callbackCode(callback, "wrong-state", "https://aiqsa.example")).toBeNull();
    expect(callbackCode(callback, "selected-state", "https://other.example")).toBeNull();
  });

  it("bounds responses even without declared content length", async () => {
    await expect(boundedBytes(new Response("a".repeat(20)), 10)).rejects.toThrow("response_too_large");
    expect((await boundedBytes(new Response("hello"), 5)).toString()).toBe("hello");
  });

  it("isolates read and write credentials and does not replay failed requests", async () => {
    const directory = await mkdtemp(join(tmpdir(), "aiqsa-auth-client-test-")); directories.push(directory);
    const origin = "https://aiqsa.example";
    const sessionDirectory = join(directory, sha256(origin), "read");
    await mkdir(sessionDirectory, { recursive: true, mode: 0o700 });
    await writeFile(join(sessionDirectory, "session.json"), JSON.stringify({ origin, scope: "skills:read", tokens: { access_token: "test-only", token_type: "Bearer" }, expiresAt: Date.now() + 60_000 }), { mode: 0o600 });
    const fetch = vi.fn().mockResolvedValue(new Response("{}", { status: 401 })); vi.stubGlobal("fetch", fetch);
    await withSession({ origin, write: false, stateDirectory: directory }, async session => {
      expect((await session.request("/mcp/skills/bundle", { method: "POST", body: "{}" })).status).toBe(401);
    });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch.mock.calls[0]?.[1].redirect).toBe("error");
    expect(new Headers(fetch.mock.calls[0]?.[1].headers).get("Authorization")).toBe("Bearer test-only");
    await expect(withSession({ origin, write: true, stateDirectory: directory }, session => session.authorize(false))).rejects.toThrow("login_required");
    expect(await readFile(join(sessionDirectory, "session.json"), "utf8")).toContain("test-only");
  });

  it("refuses world-readable credential directories", async () => {
    const directory = await mkdtemp(join(tmpdir(), "aiqsa-auth-client-test-")); directories.push(directory);
    await mkdir(join(directory, sha256("https://aiqsa.example"), "read"), { recursive: true, mode: 0o755 });
    await expect(withSession({ origin: "https://aiqsa.example", write: false, stateDirectory: directory }, async () => undefined)).rejects.toThrow("credentials_directory_unsafe");
  });

  it("completes SDK PKCE login through its callback and reconsents on explicit login", async () => {
    const directory = await mkdtemp(join(tmpdir(), "aiqsa-auth-client-test-")); directories.push(directory);
    const origin = "https://aiqsa.example";
    const nativeFetch = globalThis.fetch;
    const grants: URLSearchParams[] = [];
    const callbacks: Promise<void>[] = [];
    const prompts: URL[] = [];
    vi.stubGlobal("fetch", vi.fn(async (value: string | URL | Request, init?: RequestInit) => {
      const url = new URL(value instanceof Request ? value.url : String(value));
      if (url.pathname === "/.well-known/oauth-protected-resource/mcp/skills") return Response.json({ resource: `${origin}/mcp/skills`, authorization_servers: [origin], scopes_supported: ["skills:read", "skills:write"] });
      if (url.pathname === "/.well-known/oauth-authorization-server") return Response.json({ issuer: origin, authorization_endpoint: `${origin}/oauth/authorize`, token_endpoint: `${origin}/oauth/token`, registration_endpoint: `${origin}/oauth/register`, response_types_supported: ["code"], grant_types_supported: ["authorization_code", "refresh_token"], code_challenge_methods_supported: ["S256"], token_endpoint_auth_methods_supported: ["none"] });
      if (url.pathname === "/oauth/register") {
        const metadata = JSON.parse(String(init?.body));
        expect(metadata.application_type).toBe("native");
        return Response.json({ ...metadata, client_id: "synthetic-client" }, { status: 201 });
      }
      if (url.pathname === "/oauth/token") {
        grants.push(new URLSearchParams(String(init?.body)));
        return Response.json({ access_token: "synthetic-access", refresh_token: "synthetic-refresh", token_type: "Bearer", expires_in: 3600, scope: "skills:read" });
      }
      throw new Error("unexpected synthetic OAuth endpoint");
    }));
    vi.spyOn(process.stderr, "write").mockImplementation((chunk) => {
      const match = String(chunk).match(/https:\/\/aiqsa\.example\/oauth\/authorize\?[^\n]+/u);
      if (!match) return true;
      const authorization = new URL(match[0]); prompts.push(authorization);
      const callback = new URL(authorization.searchParams.get("redirect_uri")!);
      callback.searchParams.set("state", authorization.searchParams.get("state")!);
      callback.searchParams.set("iss", origin);
      callback.searchParams.set("code", "synthetic-code");
      callbacks.push(nativeFetch(callback).then(async response => { expect(response.ok).toBe(true); await response.text(); }));
      return true;
    });
    for (let attempt = 0; attempt < 2; attempt += 1) await withSession({ origin, write: false, stateDirectory: directory }, session => session.authorize(true));
    await Promise.all(callbacks);
    expect(prompts).toHaveLength(2);
    expect(prompts.every(url => url.searchParams.get("scope") === "skills:read" && url.searchParams.get("code_challenge_method") === "S256")).toBe(true);
    expect(grants.map(grant => grant.get("grant_type"))).toEqual(["authorization_code", "authorization_code"]);
    expect(grants.every(grant => grant.get("resource") === `${origin}/mcp/skills` && Boolean(grant.get("code_verifier")))).toBe(true);
    const saved = JSON.parse(await readFile(join(directory, sha256(origin), "read", "session.json"), "utf8"));
    expect(saved.tokens.access_token).toBe("synthetic-access");
  });
});
