import { randomBytes } from "node:crypto";
import { createServer } from "node:http";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { lstat, mkdir, open, readFile, rename, rm, writeFile } from "node:fs/promises";
import { auth, type OAuthClientProvider } from "@modelcontextprotocol/sdk/client/auth.js";
import type { OAuthClientInformationMixed, OAuthTokens } from "@modelcontextprotocol/sdk/shared/auth.js";
import { fail, safeAncestors, sha256 } from "./files";

const MAX_METADATA = 256 * 1024;
type Session = { origin: string; scope: string; client?: OAuthClientInformationMixed; tokens?: OAuthTokens; expiresAt?: number };

export function installationOrigin(value: string): string {
  let url: URL;
  try { url = new URL(value); } catch { return fail("origin_invalid"); }
  if (url.username || url.password || url.search || url.hash || !["/", ""].includes(url.pathname) ||
    (url.protocol !== "https:" && !(url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)))) fail("origin_invalid");
  return url.origin;
}

export function callbackCode(url: URL, state: string, issuer: string): string | null {
  const single = (name: string) => url.searchParams.getAll(name).length === 1;
  if (url.pathname !== "/callback" || !single("state") || url.searchParams.get("state") !== state ||
    !single("iss") || url.searchParams.get("iss") !== issuer || !single("code") || url.searchParams.has("error")) return null;
  const code = url.searchParams.get("code");
  return code && code.length <= 4096 ? code : null;
}

export async function boundedBytes(response: Response, maximum: number): Promise<Buffer> {
  const size = response.headers.get("content-length");
  if (size && (!/^\d+$/u.test(size) || Number(size) > maximum)) { await response.body?.cancel(); fail("response_too_large"); }
  if (!response.body) return Buffer.alloc(0);
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      total += next.value.length;
      if (total > maximum) fail("response_too_large");
      chunks.push(next.value);
    }
  } finally { await reader.cancel(); }
  return Buffer.concat(chunks);
}

/** OAuth discovery/token requests cannot redirect or leave the chosen installation. */
export function sameOriginFetch(origin: string, maximum = MAX_METADATA): typeof fetch {
  return async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (url.origin !== origin || url.username || url.password || url.hash) fail("cross_origin_request_denied");
    const response = await fetch(input, { ...init, redirect: "error", signal: AbortSignal.any([AbortSignal.timeout(30_000), ...(init?.signal ? [init.signal] : [])]) });
    const bytes = await boundedBytes(response, maximum);
    return new Response([204, 205, 304].includes(response.status) ? null : new Uint8Array(bytes), { status: response.status, statusText: response.statusText, headers: response.headers });
  };
}

export async function withSession<T>(input: {
  origin: string; write: boolean; stateDirectory?: string;
}, run: (session: StoreSession) => Promise<T>): Promise<T> {
  const scope = input.write ? "skills:read skills:write" : "skills:read";
  const directory = resolve(input.stateDirectory ?? join(homedir(), ".config", "aiqsa", "skills"), sha256(input.origin), input.write ? "write" : "read");
  await safeAncestors(directory);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const details = await lstat(directory);
  if ((details.mode & 0o077) !== 0 || (typeof process.getuid === "function" && details.uid !== process.getuid())) fail("credentials_directory_unsafe");
  const lockPath = join(directory, "session.lock");
  const lock = await open(lockPath, "wx", 0o600).catch(() => fail("credentials_busy"));
  try {
    const path = join(directory, "session.json");
    const saved = await lstat(path).catch(error => {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    });
    if (saved && (!saved.isFile() || saved.isSymbolicLink() || (saved.mode & 0o077) !== 0 || saved.size > MAX_METADATA || (typeof process.getuid === "function" && saved.uid !== process.getuid()))) fail("credentials_file_unsafe");
    const value: Session = saved ? JSON.parse(await readFile(path, "utf8")) as Session : { origin: input.origin, scope };
    if (value.origin !== input.origin || value.scope !== scope) fail("credentials_binding_invalid");
    return await run(new StoreSession(value, path));
  } finally { await lock.close(); await rm(lockPath, { force: true }); }
}

export class StoreSession {
  constructor(private readonly session: Session, private readonly path: string) {}

  hasWriteAccess(): boolean {
    return Boolean(this.session.tokens && (this.session.tokens.scope ?? this.session.scope).split(" ").includes("skills:write"));
  }

  private async save(): Promise<void> {
    const temporary = `${this.path}.${randomBytes(12).toString("hex")}`;
    await writeFile(temporary, JSON.stringify(this.session), { flag: "wx", mode: 0o600 });
    await rename(temporary, this.path);
  }

  async authorize(interactive: boolean): Promise<void> {
    if (!interactive && this.session.tokens && (this.session.expiresAt ?? 0) > Date.now() + 30_000) return;
    if (!interactive && !this.session.tokens?.refresh_token) fail("login_required");
    if (interactive) {
      // Explicit login means fresh consent, including the user's account choice.
      delete this.session.tokens;
      delete this.session.expiresAt;
      await this.save();
    }
    let verifier: string | undefined;
    const state = randomBytes(32).toString("hex");
    let settle: ((code: string) => void) | undefined;
    let rejectCode: ((error: Error) => void) | undefined;
    const codePromise = new Promise<string>((resolve, reject) => { settle = resolve; rejectCode = reject; });
    // The callback wait is activated only if interactive authorization redirects.
    void codePromise.catch(() => undefined);
    const server = createServer((request, response) => {
      const url = new URL(request.url ?? "/", "http://127.0.0.1");
      response.setHeader("Cache-Control", "no-store");
      response.setHeader("Content-Type", "text/plain; charset=utf-8");
      response.setHeader("X-Content-Type-Options", "nosniff");
      const code = callbackCode(url, state, this.session.origin);
      if (request.method !== "GET" || !code) { response.writeHead(400); response.end("Invalid authorization response."); return; }
      response.end("AIQSA authorization complete. You can close this window.");
      settle?.(code);
    });
    let redirectUrl = "http://127.0.0.1:1/callback";
    if (interactive) {
      await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
      const address = server.address();
      if (!address || typeof address === "string") fail("callback_unavailable");
      redirectUrl = `http://127.0.0.1:${address.port}/callback`;
    }
    const clientMetadata = {
      application_type: "native", client_name: "AIQSA Skill transfer", redirect_uris: [redirectUrl],
      grant_types: ["authorization_code", "refresh_token"], response_types: ["code"], token_endpoint_auth_method: "none", scope: this.session.scope
    };
    const provider: OAuthClientProvider = {
      redirectUrl,
      clientMetadata,
      state: () => state,
      clientInformation: () => this.session.client,
      saveClientInformation: async client => { this.session.client = client; await this.save(); },
      tokens: () => this.session.tokens,
      saveTokens: async tokens => {
        const scopes = (tokens.scope ?? this.session.scope).split(" ");
        if (scopes.some(scope => !this.session.scope.split(" ").includes(scope)) || !scopes.includes("skills:read")) fail("token_scope_invalid");
        this.session.tokens = tokens;
        this.session.expiresAt = Date.now() + (tokens.expires_in ?? 300) * 1000;
        await this.save();
      },
      redirectToAuthorization: url => {
        if (!interactive) fail("login_required");
        if (url.origin !== this.session.origin) fail("authorization_origin_invalid");
        process.stderr.write(`Open this URL in your browser and approve the requested AIQSA access:\n${url.href}\n`);
      },
      saveCodeVerifier: value => { verifier = value; },
      codeVerifier: () => verifier ?? fail("authorization_state_missing"),
      validateResourceURL: async (_url, resource) => {
        const expected = `${this.session.origin}/mcp/skills`;
        if (resource && resource !== expected) fail("authorization_resource_invalid");
        return new URL(expected);
      },
      invalidateCredentials: async kind => {
        if (kind === "all" || kind === "tokens") { delete this.session.tokens; delete this.session.expiresAt; }
        if (kind === "all" || kind === "client") delete this.session.client;
        if (kind === "all" || kind === "verifier") verifier = undefined;
        await this.save();
      }
    };
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      const options = { serverUrl: `${this.session.origin}/mcp/skills`, scope: this.session.scope, fetchFn: sameOriginFetch(this.session.origin) };
      const result = await auth(provider, options);
      if (result === "REDIRECT") {
        timeout = setTimeout(() => rejectCode?.(new Error("authorization_timeout")), 5 * 60_000);
        await auth(provider, { ...options, authorizationCode: await codePromise });
      }
      if (!this.session.tokens) fail("login_required");
    } finally {
      if (timeout) clearTimeout(timeout);
      if (server.listening) await new Promise<void>(resolve => server.close(() => resolve()));
    }
  }

  async request(path: string, init?: RequestInit, maximum = MAX_METADATA): Promise<Response> {
    await this.authorize(false);
    const url = new URL(path, this.session.origin);
    if (url.origin !== this.session.origin || !["/mcp/skills", "/mcp/skills/bundle"].includes(url.pathname) || url.username || url.password || url.hash) fail("transfer_url_invalid");
    const headers = new Headers(init?.headers);
    headers.set("Authorization", `Bearer ${this.session.tokens!.access_token}`);
    // No automatic replay: write operations are retried only by their caller with the same operation key.
    return sameOriginFetch(this.session.origin, maximum)(url, { ...init, headers });
  }
}
