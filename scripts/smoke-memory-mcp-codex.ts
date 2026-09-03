import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import {
  chmod,
  mkdtemp,
  mkdir,
  readFile,
  rm,
  writeFile
} from "node:fs/promises";
import { createServer } from "node:net";
import { homedir, tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { loadEnvConfig } from "@next/env";
import { PrismaClient } from "@prisma/client";
import {
  chromium,
  type Browser,
  type BrowserContext,
  type Page,
  type Request as PlaywrightRequest
} from "@playwright/test";
import { Client as PostgresClient } from "pg";
import {
  decodeMemoryConsumerListResponse,
  decodeMemoryConsumerMutationResponse
} from "../lib/contracts/memoryConsumer";
import { analyzeMemoryLexicalQuery } from
  "../lib/domain/memory/retrieval/lexical";
import { decodeMemoryMcpConnectedAppResponse } from
  "../lib/contracts/memoryMcpConnectedApps";
import { hashPassword } from "../lib/server/auth/password";
import { ensureFullAccessGroup } from "../lib/server/auth/fullAccessGroup";
import { createAdminMemoryEgressService } from
  "../lib/server/admin/memory/egressService";
import { createMemoryConsumerRefService } from
  "../lib/server/memory/consumer/ref";
import type { MemoryConsumerRefService } from
  "../lib/server/memory/consumer/ref";
import { defaultMemoryExecutionAuthority } from
  "../lib/server/memory/execution/defaultAuthority";
import { createAcceptedEmbeddingRuntime } from
  "../lib/server/providerRuntime/embeddingRuntime";
import { createAcceptedRerankerRuntime } from
  "../lib/server/providerRuntime/rerankerRuntime";
import { ExplicitMemoryServiceError } from
  "../lib/server/memory/explicit/service";
import { createPrismaExplicitMemoryRepository } from
  "../lib/server/memory/explicit/repository";
import { MEMORY_ITEM_EMBEDDING_VERSIONS } from
  "../lib/server/memory/embedding/contract";
import { probeCurrentMemoryEmbeddingPin } from
  "../lib/server/memory/embedding/handler";
import { createPrismaMemorySettingsRepository } from
  "../lib/server/memory/persistence/settings";
import {
  createMemoryNativeFactSearchPlan,
  createMemoryNativeFactSearchService
} from "../lib/server/memory/retrieval/nativeFactSearch";
import {
  createPrismaLocalMemoryRetrievalRepository,
  type MemoryLocalRetrievalResult
} from "../lib/server/memory/retrieval/localRepository";
import { createPrismaMemoryRunUtilityService } from
  "../lib/server/memory/retrieval/runUtilities";
import { createAcceptedMemoryRunUtilityProvider } from
  "../lib/server/memory/retrieval/runUtilityRuntime";
import { createPrismaMemoryVectorRepository } from
  "../lib/server/memory/retrieval/vector";
import { parseSecretEncryptionKey } from "../lib/server/secrets/envelope";
import { createPrismaMemoryRebuildRepository } from
  "../lib/server/memory/rebuild/repository";
import { createMemoryRebuildService } from
  "../lib/server/memory/rebuild/service";
import {
  MEMORY_MCP_SMOKE_TOOL_NAMES,
  auditCodexJsonEvents,
  codexAgentMessageContains,
  codexLbOverridesFromConfig,
  databaseUrlForOwnedSmoke,
  findAuthorizationUrl,
  ownedMemoryMcpSmokeDatabaseName,
  parseCodexMcpList,
  parseDisposableAdminDatabaseUrl,
  parseInspectorInitialize,
  parseInspectorToolNames,
  type CodexEventAudit
} from "./memory-mcp-codex-smoke-support";

const REPOSITORY_ROOT = resolve(import.meta.dirname, "..");
const CHILD_OUTPUT_MAX_BYTES = 12 * 1_024 * 1_024;
const APP_START_TIMEOUT_MS = 120_000;
const CLIENT_TIMEOUT_MS = 240_000;
const PROFILE_BOOTSTRAP_TIMEOUT_MS = 600_000;
const COORDINATOR_PROCESS_TIMEOUT_MS = 3_600_000;
const SEMANTIC_INDEX_TIMEOUT_MS = 240_000;
const EXPECTED_PROTOCOL_VERSION = "2026-07-28";
const SEMANTIC_EMBEDDING_MODEL_ID = "qwen/qwen3-embedding-8b";
const DEFAULT_ADMIN_DATABASE_URL =
  "postgresql://aiqsa:aiqsa-dev-password@127.0.0.1:5432/postgres";
// These are the repository's public docker-compose.dev.yml defaults. They are
// valid only because this script first proves and owns a disposable database;
// no persistent installation is ever opened with them.
const DISPOSABLE_LOCAL_DEV_ENCRYPTION_KEY =
  "QUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUE=";
const DISPOSABLE_LOCAL_DEV_FINGERPRINT_KEYRING =
  "current=v1,v1=CwwNDg8QERITFBUWFxgZGhscHR4fICEiIyQlJicoKSo=";

type SmokeStage =
  | "app_bootstrap"
  | "cleanup"
  | "codex_oauth"
  | "codex_tools"
  | "database_bootstrap"
  | "inspector"
  | "preflight"
  | "revoke"
  | "semantic_index"
  | "state_assertion";

class SmokeFailure extends Error {
  constructor(readonly stage: SmokeStage, readonly code: string) {
    super(code);
    this.name = "SmokeFailure";
  }
}

function fail(stage: SmokeStage, code: string): never {
  throw new SmokeFailure(stage, code);
}

function ensure(
  condition: unknown,
  stage: SmokeStage,
  code: string
): asserts condition {
  if (!condition) fail(stage, code);
}

async function guarded<T>(
  stage: SmokeStage,
  code: string,
  operation: () => Promise<T>
): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    if (error instanceof SmokeFailure) throw error;
    return fail(stage, code);
  }
}

function emit(stage: string, detail: Readonly<Record<string, unknown>>): void {
  process.stdout.write(`${JSON.stringify({ stage, ...detail })}\n`);
}

function diagnosticCodes(value: string): readonly string[] {
  const codes = new Set<string>();
  for (const match of value.matchAll(
    /["']?code["']?\s*[:=]\s*["']([a-z][a-z0-9_-]{1,63})["']/giu
  )) {
    if (match[1]) codes.add(match[1].toLowerCase());
  }
  for (const code of [
    "access_denied", "auth_required", "connection_failed", "invalid_client",
    "invalid_grant", "invalid_request", "invalid_target", "server_error"
  ]) {
    if (value.includes(code)) codes.add(code);
  }
  return [...codes].sort();
}

function sanitizedDiagnosticLines(value: string): readonly string[] {
  return value
    .replace(/https?:\/\/[^\s"'<>]+/giu, "<url>")
    .replace(/\b[A-Za-z0-9_-]{32,}\b/gu, "<opaque>")
    .replace(/[^\x20-\x7e\n]/gu, "")
    .split(/\r?\n/gu)
    .map((line) => line.trim())
    .filter((line) => /error|fail|invalid|oauth|mcp|warn/iu.test(line))
    .slice(-12)
    .map((line) => line.slice(0, 300));
}

function safeError(error: unknown): SmokeFailure {
  if (error instanceof SmokeFailure) return error;
  if (error instanceof Error && /^[a-z0-9_]{1,96}$/u.test(error.message)) {
    return new SmokeFailure("preflight", error.message);
  }
  return new SmokeFailure("preflight", "memory_mcp_smoke_unexpected_failure");
}

function boundedAppend(current: string, chunk: Buffer): string {
  const next = current + chunk.toString("utf8");
  if (Buffer.byteLength(next, "utf8") > CHILD_OUTPUT_MAX_BYTES) {
    throw new Error("memory_mcp_smoke_child_output_too_large");
  }
  return next;
}

type CapturedProcess = Readonly<{
  child: ChildProcess;
  done: Promise<Readonly<{ code: number; stderr: string; stdout: string }>>;
  output(): string;
}>;

function killProcessGroup(child: ChildProcess, signal: NodeJS.Signals): void {
  if (!child.pid) return;
  try {
    process.kill(-child.pid, signal);
  } catch {
    child.kill(signal);
  }
}

function spawnCaptured(
  command: string,
  args: readonly string[],
  input: Readonly<{
    cwd?: string;
    env?: NodeJS.ProcessEnv;
    timeoutMs: number;
  }>
): CapturedProcess {
  const child = spawn(command, [...args], {
    cwd: input.cwd ?? REPOSITORY_ROOT,
    detached: true,
    env: input.env ?? process.env,
    stdio: ["ignore", "pipe", "pipe"]
  });
  let stdout = "";
  let stderr = "";
  let overflow = false;
  child.stdout?.on("data", (chunk: Buffer) => {
    try {
      stdout = boundedAppend(stdout, chunk);
    } catch {
      overflow = true;
      killProcessGroup(child, "SIGKILL");
    }
  });
  child.stderr?.on("data", (chunk: Buffer) => {
    try {
      stderr = boundedAppend(stderr, chunk);
    } catch {
      overflow = true;
      killProcessGroup(child, "SIGKILL");
    }
  });
  const done = new Promise<Readonly<{ code: number; stderr: string; stdout: string }>>(
    (resolvePromise, rejectPromise) => {
      const timer = setTimeout(() => {
        killProcessGroup(child, "SIGKILL");
        rejectPromise(new Error("memory_mcp_smoke_child_timeout"));
      }, input.timeoutMs);
      child.once("error", (error) => {
        clearTimeout(timer);
        rejectPromise(error);
      });
      child.once("close", (code) => {
        clearTimeout(timer);
        if (overflow) {
          rejectPromise(new Error("memory_mcp_smoke_child_output_too_large"));
          return;
        }
        resolvePromise({ code: code ?? 1, stderr, stdout });
      });
    }
  );
  return {
    child,
    done,
    output: () => `${stdout}\n${stderr}`
  };
}

async function runCaptured(
  command: string,
  args: readonly string[],
  input: Readonly<{
    cwd?: string;
    env?: NodeJS.ProcessEnv;
    timeoutMs?: number;
  }> = {}
): Promise<Readonly<{ code: number; stderr: string; stdout: string }>> {
  return spawnCaptured(command, args, {
    ...input,
    timeoutMs: input.timeoutMs ?? CLIENT_TIMEOUT_MS
  }).done;
}

async function freeLoopbackPort(): Promise<number> {
  return new Promise<number>((resolvePromise, rejectPromise) => {
    const server = createServer();
    server.once("error", rejectPromise);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      server.close((error) => {
        if (error) rejectPromise(error);
        else if (!port) rejectPromise(new Error("memory_mcp_smoke_port_unavailable"));
        else resolvePromise(port);
      });
    });
  });
}

async function waitForApp(baseUrl: string, child: ChildProcess): Promise<void> {
  const deadline = Date.now() + APP_START_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) fail("app_bootstrap", "memory_mcp_smoke_app_exited");
    try {
      const response = await fetch(`${baseUrl}/api/health/live`, {
        cache: "no-store",
        signal: AbortSignal.timeout(2_000)
      });
      if (response.ok) return;
    } catch {
      // The isolated dev server is still compiling or binding.
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 250));
  }
  fail("app_bootstrap", "memory_mcp_smoke_app_start_timeout");
}

async function stopProcessGroup(child: ChildProcess | null): Promise<void> {
  if (!child?.pid || child.exitCode !== null) return;
  try {
    process.kill(-child.pid, "SIGTERM");
  } catch {
    child.kill("SIGTERM");
  }
  await Promise.race([
    new Promise<void>((resolvePromise) => child.once("close", () => resolvePromise())),
    new Promise<void>((resolvePromise) => setTimeout(resolvePromise, 5_000))
  ]);
  if (child.exitCode === null) {
    try {
      process.kill(-child.pid, "SIGKILL");
    } catch {
      child.kill("SIGKILL");
    }
  }
}

async function readCapture(path: string): Promise<string> {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return "";
    throw error;
  }
}

async function waitForAuthorizationUrl(
  processHandle: CapturedProcess,
  capturePath: string,
  issuer: string,
  stage: SmokeStage
): Promise<string> {
  const deadline = Date.now() + 45_000;
  while (Date.now() < deadline) {
    const captured = await readCapture(capturePath);
    const url = findAuthorizationUrl(`${captured}\n${processHandle.output()}`, issuer);
    if (url) return url;
    if (processHandle.child.exitCode !== null) break;
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 100));
  }
  return fail(stage, "memory_mcp_smoke_authorization_url_missing");
}

async function approveInBrowser(
  page: Page,
  authorizationUrl: string,
  issuer: string,
  stage: SmokeStage
): Promise<void> {
  const parsed = new URL(authorizationUrl);
  ensure(parsed.origin === issuer && parsed.pathname === "/oauth/authorize",
    stage, "memory_mcp_smoke_authorization_url_invalid");
  const redirectUri = parsed.searchParams.get("redirect_uri");
  const clientId = parsed.searchParams.get("client_id");
  let redirectLoopback = false;
  let clientIdUrl: URL | null = null;
  try {
    const redirect = redirectUri ? new URL(redirectUri) : null;
    redirectLoopback = redirect?.hostname === "127.0.0.1" ||
      redirect?.hostname === "localhost" || redirect?.hostname === "[::1]";
    clientIdUrl = clientId ? new URL(clientId) : null;
  } catch {
    redirectLoopback = false;
  }
  emit("oauth_client", {
    challengeLength: parsed.searchParams.get("code_challenge")?.length ?? 0,
    clientIdKind: clientId?.startsWith("aiqsa_dcr_")
      ? "dcr"
      : clientIdUrl ? "cimd" : "other",
    clientIdLoopback: clientIdUrl
      ? ["127.0.0.1", "localhost", "[::1]"].includes(clientIdUrl.hostname)
      : false,
    clientIdPathIsRoot: clientIdUrl?.pathname === "/",
    clientIdProtocol: clientIdUrl?.protocol ?? null,
    clientStage: stage,
    parameterNames: [...new Set(parsed.searchParams.keys())].sort(),
    redirectLoopback,
    resourceMatches: parsed.searchParams.get("resource") === `${issuer}/mcp`,
    scopeEmpty: (parsed.searchParams.get("scope") ?? "") === "",
    scopePresent: parsed.searchParams.has("scope")
  });
  if (clientIdUrl) {
    const metadataResponse = await guarded(
      stage,
      "memory_mcp_smoke_cimd_probe_failed",
      () => fetch(clientIdUrl, {
        headers: { accept: "application/json, application/*+json" },
        signal: AbortSignal.timeout(3_000)
      })
    );
    const metadata = await guarded(
      stage,
      "memory_mcp_smoke_cimd_probe_body_failed",
      () => metadataResponse.json() as Promise<unknown>
    );
    const metadataRecord = metadata && typeof metadata === "object" &&
      !Array.isArray(metadata) ? metadata as Record<string, unknown> : null;
    const registeredRedirects = Array.isArray(metadataRecord?.redirect_uris)
      ? metadataRecord.redirect_uris.filter((value): value is string =>
          typeof value === "string")
      : [];
    const authorizationRedirect = redirectUri ? new URL(redirectUri) : null;
    const redirectRelationship = registeredRedirects.map((value) => {
      try {
        const registered = new URL(value);
        return {
          bothLoopback: Boolean(authorizationRedirect &&
            ["127.0.0.1", "localhost", "[::1]"].includes(registered.hostname) &&
            ["127.0.0.1", "localhost", "[::1]"].includes(
              authorizationRedirect.hostname
            )),
          exact: value === redirectUri,
          hostMatches: registered.hostname === authorizationRedirect?.hostname,
          pathMatches: registered.pathname === authorizationRedirect?.pathname,
          portMatches: registered.port === authorizationRedirect?.port,
          protocolMatches: registered.protocol === authorizationRedirect?.protocol
        };
      } catch {
        return { validUrl: false };
      }
    });
    emit("oauth_client", {
      clientIdMatches: metadataRecord?.client_id === clientId,
      clientStage: stage,
      contentTypeJson: metadataResponse.headers.get("content-type")
        ?.toLowerCase().includes("json") ?? false,
      forbiddenCredentialMaterial: Boolean(metadataRecord && [
        "client_secret", "client_secret_expires_at", "jwks", "jwks_uri"
      ].some((key) => Object.hasOwn(metadataRecord, key))),
      metadataKeys: metadataRecord ? Object.keys(metadataRecord).sort() : [],
      metadataStatus: metadataResponse.status,
      milestone: "cimd_metadata_probed",
      redirectCount: registeredRedirects.length,
      redirectRegistered: registeredRedirects.includes(redirectUri ?? ""),
      redirectRelationship
    });
  }
  const navigation = await guarded(
    stage,
    "memory_mcp_smoke_consent_navigation_failed",
    () => page.goto(authorizationUrl, { waitUntil: "domcontentloaded" })
  );
  emit("oauth_client", {
    clientStage: stage,
    consentStatus: navigation?.status() ?? null,
    milestone: "consent_response_received"
  });
  ensure(navigation?.ok(), stage, "memory_mcp_smoke_consent_response_invalid");
  emit("oauth_client", { clientStage: stage, milestone: "consent_page_loaded" });
  const consentHeading = page.getByRole("heading", {
    name: "Connect Personal Memory?"
  });
  const consentHeadingVisible = await consentHeading.waitFor({ timeout: 15_000 })
    .then(() => true)
    .catch(() => false);
  if (!consentHeadingVisible) {
    const currentUrl = new URL(page.url());
    const body = await page.locator("body").innerText().catch(() => "");
    const title = await page.title().catch(() => "");
    emit("oauth_client", {
      bodyBytes: Buffer.byteLength(body),
      clientStage: stage,
      currentOriginMatches: currentUrl.origin === issuer,
      currentPath: currentUrl.pathname,
      diagnosticCodes: diagnosticCodes(`${title}\n${body}`),
      hasAuthorizationErrorHeading: body.includes(
        "Authorization could not be completed"
      ),
      hasConsentHeadingText: body.includes("Connect Personal Memory?"),
      milestone: "consent_page_unexpected",
      titleKind: title === "Connect Personal Memory · AIQSA"
        ? "consent"
        : title === "Authorization failed · AIQSA" ? "authorization_error" : "other"
    });
    fail(stage, "memory_mcp_smoke_consent_heading_missing");
  }
  await guarded(stage, "memory_mcp_smoke_consent_scope_copy_missing", () =>
    page.getByText(/read, add, change, and delete your Personal Memory facts/iu)
      .waitFor());
  await guarded(stage, "memory_mcp_smoke_consent_history_copy_missing", () =>
    page.getByText(/Chat history is not available/iu).waitFor());
  emit("oauth_client", { clientStage: stage, milestone: "consent_copy_verified" });
  let callbackRequested = false;
  const observeCallback = (request: PlaywrightRequest) => {
    try {
      const url = new URL(request.url());
      if (url.origin !== issuer && url.searchParams.has("code")) {
        callbackRequested = true;
      }
    } catch {
      // Ignore unrelated malformed browser requests.
    }
  };
  page.on("request", observeCallback);
  try {
    const authorizationResponse = page.waitForResponse((response) => {
      const url = new URL(response.url());
      return response.request().method() === "POST" && url.origin === issuer &&
        url.pathname === "/oauth/authorize";
    }, { timeout: 30_000 });
    await guarded(stage, "memory_mcp_smoke_consent_click_failed", () =>
      page.getByRole("button", { name: "Approve" }).click({ noWaitAfter: true }));
    const response = await guarded(
      stage,
      "memory_mcp_smoke_consent_post_missing",
      () => authorizationResponse
    );
    emit("oauth_client", {
      clientStage: stage,
      consentPostStatus: response.status(),
      milestone: "consent_post_received"
    });
    ensure(response.status() === 303, stage,
      "memory_mcp_smoke_consent_post_invalid");
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 250));
    if (!callbackRequested) {
      const location = response.headers()["location"];
      const callback = location ? new URL(location, issuer) : null;
      const expectedCallback = redirectUri ? new URL(redirectUri) : null;
      emit("oauth_client", {
        callbackHasCode: callback?.searchParams.has("code") ?? false,
        callbackIssuerMatches: callback?.searchParams.get("iss") === issuer,
        callbackOriginMatches: callback?.origin === expectedCallback?.origin,
        callbackPathMatches: callback?.pathname === expectedCallback?.pathname,
        callbackStateMatches: callback?.searchParams.get("state") ===
          parsed.searchParams.get("state"),
        clientStage: stage,
        milestone: "callback_redirect_received"
      });
      ensure(callback && expectedCallback &&
        callback.origin === expectedCallback.origin &&
        callback.pathname === expectedCallback.pathname &&
        callback.searchParams.has("code") &&
        callback.searchParams.get("iss") === issuer &&
        callback.searchParams.get("state") === parsed.searchParams.get("state"),
      stage, "memory_mcp_smoke_callback_redirect_invalid");
      await page.goto(callback.toString(), {
        timeout: 10_000,
        waitUntil: "commit"
      }).catch(() => undefined);
    }
    const callbackDeadline = Date.now() + 10_000;
    while (!callbackRequested && Date.now() < callbackDeadline) {
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 25));
    }
    ensure(callbackRequested, stage, "memory_mcp_smoke_callback_missing");
    emit("oauth_client", { clientStage: stage, milestone: "callback_requested" });
  } finally {
    page.off("request", observeCallback);
  }
}

async function runBrowserOAuth(input: Readonly<{
  args: readonly string[];
  browserCapturePath: string;
  command: string;
  env: NodeJS.ProcessEnv;
  issuer: string;
  page: Page;
  stage: SmokeStage;
  timeoutMs?: number;
}>): Promise<Readonly<{ stderr: string; stdout: string }>> {
  await writeFile(input.browserCapturePath, "", { mode: 0o600 });
  const processHandle = spawnCaptured(input.command, input.args, {
    env: input.env,
    timeoutMs: input.timeoutMs ?? CLIENT_TIMEOUT_MS
  });
  try {
    const authorizationUrl = await waitForAuthorizationUrl(
      processHandle,
      input.browserCapturePath,
      input.issuer,
      input.stage
    );
    emit("oauth_client", {
      clientStage: input.stage,
      milestone: "authorization_url_captured"
    });
    await approveInBrowser(input.page, authorizationUrl, input.issuer, input.stage);
    const result = await processHandle.done;
    if (result.code !== 0) {
      const combinedOutput = `${result.stdout}\n${result.stderr}`;
      emit("oauth_client", {
        clientStage: input.stage,
        diagnosticCodes: diagnosticCodes(combinedOutput),
        exitCode: result.code,
        milestone: "client_failed_after_callback",
        stderrBytes: Buffer.byteLength(result.stderr),
        stdoutBytes: Buffer.byteLength(result.stdout)
      });
      if (process.env.AIQSA_MEMORY_MCP_SMOKE_DEBUG === "SANITIZED") {
        emit("diagnostic", {
          clientStage: input.stage,
          lines: sanitizedDiagnosticLines(combinedOutput)
        });
      }
    }
    ensure(result.code === 0, input.stage, "memory_mcp_smoke_oauth_client_failed");
    emit("oauth_client", { clientStage: input.stage, milestone: "tokens_stored" });
    return result;
  } catch (error) {
    killProcessGroup(processHandle.child, "SIGKILL");
    await processHandle.done.catch(() => undefined);
    if (error instanceof SmokeFailure) throw error;
    return fail(input.stage, "memory_mcp_smoke_oauth_interaction_failed");
  }
}


function processEnvWith(
  overrides: Readonly<Record<string, string | undefined>>
): NodeJS.ProcessEnv {
  const environment = { ...process.env, ...overrides };
  delete environment.CODEX_SESSION_ID;
  delete environment.CODEX_THREAD_ID;
  return environment;
}

async function createOwnedDatabase(adminUrl: URL, databaseName: string): Promise<void> {
  const client = new PostgresClient({ connectionString: adminUrl.toString() });
  await client.connect();
  try {
    const current = await client.query<{ database: string }>(
      "SELECT current_database() AS database"
    );
    ensure(current.rows[0]?.database === "postgres", "database_bootstrap",
      "memory_mcp_smoke_admin_database_invalid");
    const existing = await client.query(
      "SELECT 1 FROM pg_database WHERE datname = $1",
      [databaseName]
    );
    ensure(existing.rowCount === 0, "database_bootstrap",
      "memory_mcp_smoke_database_collision");
    await client.query(`CREATE DATABASE "${databaseName}" TEMPLATE template0`);
  } finally {
    await client.end();
  }
}

async function dropOwnedDatabase(adminUrl: URL, databaseName: string): Promise<void> {
  ensure(/^aiqsa_memory_mcp_e2e_[a-f0-9]{12}$/u.test(databaseName), "cleanup",
    "memory_mcp_smoke_cleanup_database_invalid");
  const client = new PostgresClient({ connectionString: adminUrl.toString() });
  await client.connect();
  try {
    await client.query(
      "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()",
      [databaseName]
    );
    await client.query(`DROP DATABASE IF EXISTS "${databaseName}"`);
  } finally {
    await client.end();
  }
}

async function createSyntheticUser(
  prisma: PrismaClient,
  input: Readonly<{ email: string; password: string; userId: string }>
): Promise<void> {
  const passwordHash = await guarded(
    "database_bootstrap",
    "memory_mcp_smoke_password_hash_failed",
    () => hashPassword(input.password)
  );
  await prisma.$transaction(async (transaction) => {
    await guarded("database_bootstrap", "memory_mcp_smoke_user_row_failed", () =>
      transaction.user.create({
      data: {
        displayName: "Memory MCP E2E",
        email: input.email,
        id: input.userId,
        role: "user",
        status: "active"
      }
      }));
    await guarded("database_bootstrap", "memory_mcp_smoke_identity_row_failed", () =>
      transaction.authIdentity.create({
      data: {
        emailVerifiedAt: new Date(),
        normalizedEmail: input.email,
        passwordHash,
        provider: "password",
        providerAccountId: input.email,
        userId: input.userId
      }
      }));
    await guarded("database_bootstrap", "memory_mcp_smoke_settings_row_failed", () =>
      transaction.userSettings.create({ data: { userId: input.userId } }));
    await guarded("database_bootstrap", "memory_mcp_smoke_memory_settings_row_failed", () =>
      transaction.userMemorySettings.update({
      data: {
        learnAutomatically: false,
        referenceChatHistory: false,
        useMemoryFacts: true
      },
      where: { userId: input.userId }
      }));
  });
}

async function selectSyntheticEmbedding(
  prisma: PrismaClient,
  userId: string
): Promise<string> {
  await ensureFullAccessGroup(prisma, userId);
  const candidates = await prisma.providerModel.findMany({
    orderBy: { id: "asc" },
    select: {
      activeConfig: true,
      activeVersion: true,
      enabled: true,
      id: true,
      modelClass: true,
      modelId: true
    },
    where: { modelId: SEMANTIC_EMBEDDING_MODEL_ID }
  });
  const embedding = candidates.find((candidate) =>
    candidate.activeConfig !== null && candidate.activeVersion > 0 &&
    candidate.enabled && candidate.modelClass === "embedding");
  ensure(embedding, "semantic_index",
    "memory_mcp_smoke_embedding_profile_missing");
  const repository = createPrismaMemorySettingsRepository(prisma);
  const current = await repository.get(userId);
  const updated = await repository.patch(userId, {
    embeddingDeploymentId: embedding.id,
    expectedMemoryRevision: current.memoryRevision,
    expectedSettingsRevision: current.settingsRevision
  });
  ensure(updated.embeddingProviderModelId === embedding.id, "semantic_index",
    "memory_mcp_smoke_embedding_selection_failed");
  // Selecting a new Memory destination deliberately invalidates the global
  // admin-consent fingerprint. Re-acknowledge that exact reviewed disposable
  // profile before admitting the rebuild; this performs no provider call.
  const administrator = await prisma.user.findFirst({
    orderBy: { id: "asc" },
    select: { id: true },
    where: { role: "admin", status: "active" }
  });
  ensure(administrator, "semantic_index",
    "memory_mcp_smoke_profile_administrator_missing");
  const egress = createAdminMemoryEgressService(prisma, {
    consentMode: "ADMIN"
  });
  const review = await egress.get();
  if (review.reviewRequired) {
    await egress.acknowledge(administrator.id, {
      currentFingerprint: review.currentFingerprint,
      expectedVersion: review.version
    });
  }
  const accepted = await egress.get();
  ensure(!accepted.reviewRequired, "semantic_index",
    "memory_mcp_smoke_egress_review_incomplete");
  return embedding.id;
}

async function waitForCoordinator(
  coordinator: CapturedProcess
): Promise<void> {
  const deadline = Date.now() + APP_START_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (coordinator.output().includes("AIQSA Memory coordinator started.")) return;
    if (coordinator.child.exitCode !== null) break;
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 250));
  }
  fail("semantic_index", "memory_mcp_smoke_coordinator_unavailable");
}

async function activateEmptyHybridGeneration(
  prisma: PrismaClient,
  userId: string,
  embeddingDeploymentId: string,
  coordinator: CapturedProcess
): Promise<string> {
  const settingsRepository = createPrismaMemorySettingsRepository(prisma);
  const current = await settingsRepository.get(userId);
  const rebuild = createMemoryRebuildService({
    probeEmbeddingPin: (ownerId) => probeCurrentMemoryEmbeddingPin(
      defaultMemoryExecutionAuthority,
      prisma,
      ownerId,
      MEMORY_ITEM_EMBEDDING_VERSIONS
    ),
    repository: createPrismaMemoryRebuildRepository(prisma)
  });
  const admitted = await rebuild.start(userId, {
    embeddingDeploymentId,
    expectedMemoryRevision: current.memoryRevision,
    expectedSettingsRevision: current.settingsRevision,
    operation: "REEMBED"
  });
  const deadline = Date.now() + SEMANTIC_INDEX_TIMEOUT_MS;
  while (Date.now() < deadline) {
    ensure(coordinator.child.exitCode === null, "semantic_index",
      "memory_mcp_smoke_coordinator_exited");
    const status = await rebuild.status(userId, admitted.jobId);
    if (status.state === "SUCCEEDED") {
      const settings = await settingsRepository.get(userId);
      ensure(settings.activeIndexGenerationId, "semantic_index",
        "memory_mcp_smoke_active_generation_missing");
      const generation = await prisma.memoryIndexGeneration.findFirst({
        select: { indexMode: true, state: true },
        where: {
          id: settings.activeIndexGenerationId,
          userId
        }
      });
      ensure(generation?.state === "ACTIVE" && generation.indexMode === "HYBRID",
        "semantic_index", "memory_mcp_smoke_active_generation_invalid");
      return settings.activeIndexGenerationId;
    }
    if (["FAILED", "STALE", "CANCELLED"].includes(status.state)) {
      fail("semantic_index", status.errorCode
        ? `memory_mcp_smoke_rebuild_${status.errorCode}`
        : "memory_mcp_smoke_rebuild_failed");
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 250));
  }
  return fail("semantic_index", "memory_mcp_smoke_rebuild_timeout");
}

async function waitForFactVector(
  prisma: PrismaClient,
  input: Readonly<{
    factVersionId: string;
    generationId: string;
    userId: string;
  }>,
  coordinator: CapturedProcess
): Promise<void> {
  const deadline = Date.now() + SEMANTIC_INDEX_TIMEOUT_MS;
  while (Date.now() < deadline) {
    ensure(coordinator.child.exitCode === null, "semantic_index",
      "memory_mcp_smoke_coordinator_exited");
    const rows = await prisma.$queryRawUnsafe<Array<{
      embeddingDimension: number | null;
      ready: boolean;
    }>>(`
      SELECT entry."embeddingDimension",
        (entry."embeddingState" = 'READY'::"MemoryEmbeddingState" AND
          entry."embedding" IS NOT NULL) AS ready
      FROM "MemorySearchEntry" AS entry
      WHERE entry."userId" = $1
        AND entry."indexGenerationId" = $2
        AND entry."factVersionId" = $3
      LIMIT 1
    `, input.userId, input.generationId, input.factVersionId);
    const row = rows[0];
    if (row?.ready && Number.isSafeInteger(row.embeddingDimension) &&
      (row.embeddingDimension ?? 0) > 0) return;
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 250));
  }
  fail("semantic_index", "memory_mcp_smoke_fact_vector_timeout");
}

type RunCounts = Readonly<{
  chats: number;
  mcpBindings: number;
  messages: number;
  modelRuns: number;
  retrievalAttempts: number;
  toolCalls: number;
}>;

type InboundExecutionSnapshot = Readonly<{
  failed: number;
  ownerCount: number;
  queryEmbedding: number;
  rerank: number;
  unexpectedRoles: number;
}>;

async function runCounts(prisma: PrismaClient, userId: string): Promise<RunCounts> {
  const rows = await prisma.$queryRawUnsafe<RunCounts[]>(`
    SELECT
      (SELECT count(*)::integer FROM "Chat" WHERE "userId" = $1) AS "chats",
      (SELECT count(*)::integer FROM "Message" message
        INNER JOIN "Chat" chat ON chat."id" = message."chatId"
        WHERE chat."userId" = $1) AS "messages",
      (SELECT count(*)::integer FROM "ModelRun" WHERE "userId" = $1) AS "modelRuns",
      (SELECT count(*)::integer FROM "MemoryRetrievalAttempt" WHERE "userId" = $1) AS "retrievalAttempts",
      (SELECT count(*)::integer FROM "McpRunBinding" binding
        INNER JOIN "ModelRun" run ON run."id" = binding."modelRunId"
        WHERE run."userId" = $1) AS "mcpBindings",
      (SELECT count(*)::integer FROM "ModelRunToolCall" call
        INNER JOIN "ModelRun" run ON run."id" = call."modelRunId"
        WHERE run."userId" = $1) AS "toolCalls"
  `, userId);
  const row = rows[0];
  return row ?? fail("state_assertion", "memory_mcp_smoke_count_query_failed");
}

async function inboundExecutionSnapshot(
  prisma: PrismaClient,
  userId: string
): Promise<InboundExecutionSnapshot> {
  const rows = await prisma.$queryRawUnsafe<InboundExecutionSnapshot[]>(`
    SELECT
      COUNT(*) FILTER (
        WHERE binding."logicalRole" = 'MEMORY_QUERY_EMBED'
          AND binding."state" = 'SUCCEEDED'::"MemoryExecutionState"
      )::integer AS "queryEmbedding",
      COUNT(*) FILTER (
        WHERE binding."logicalRole" = 'MEMORY_RERANK'
          AND binding."state" = 'SUCCEEDED'::"MemoryExecutionState"
      )::integer AS "rerank",
      COUNT(*) FILTER (
        WHERE binding."state" <> 'SUCCEEDED'::"MemoryExecutionState"
      )::integer AS "failed",
      COUNT(*) FILTER (
        WHERE binding."logicalRole" NOT IN ('MEMORY_QUERY_EMBED', 'MEMORY_RERANK')
      )::integer AS "unexpectedRoles",
      COUNT(DISTINCT binding."inboundMcpRequestId")::integer AS "ownerCount"
    FROM "MemoryExecutionBinding" AS binding
    WHERE binding."userId" = $1
      AND binding."ownerType" = 'INBOUND_MCP_REQUEST'::"MemoryExecutionOwnerType"
  `, userId);
  return rows[0] ?? fail(
    "state_assertion",
    "memory_mcp_smoke_execution_query_failed"
  );
}

type CurrentFact = Readonly<{
  currentVersionId: string | null;
  displayText: string | null;
  factId: string;
  forgottenAt: Date | null;
  state: string;
  versionCount: number;
}>;

async function currentFactByText(
  prisma: PrismaClient,
  userId: string,
  text: string
): Promise<CurrentFact | null> {
  const rows = await prisma.$queryRawUnsafe<CurrentFact[]>(`
    SELECT fact."id" AS "factId", fact."state"::text AS "state",
      fact."currentVersionId", fact."forgottenAt", version."displayText",
      (SELECT count(*)::integer FROM "MemoryFactVersion" all_versions
        WHERE all_versions."userId" = fact."userId"
          AND all_versions."factId" = fact."id") AS "versionCount"
    FROM "MemoryFact" fact
    LEFT JOIN "MemoryFactVersion" version
      ON version."userId" = fact."userId"
     AND version."id" = fact."currentVersionId"
    WHERE fact."userId" = $1 AND version."displayText" = $2
    LIMIT 1
  `, userId, text);
  return rows[0] ?? null;
}

async function factById(
  prisma: PrismaClient,
  userId: string,
  factId: string
): Promise<CurrentFact | null> {
  const rows = await prisma.$queryRawUnsafe<CurrentFact[]>(`
    SELECT fact."id" AS "factId", fact."state"::text AS "state",
      fact."currentVersionId", fact."forgottenAt", version."displayText",
      (SELECT count(*)::integer FROM "MemoryFactVersion" all_versions
        WHERE all_versions."userId" = fact."userId"
          AND all_versions."factId" = fact."id") AS "versionCount"
    FROM "MemoryFact" fact
    LEFT JOIN "MemoryFactVersion" version
      ON version."userId" = fact."userId"
     AND version."id" = fact."currentVersionId"
    WHERE fact."userId" = $1 AND fact."id" = $2
    LIMIT 1
  `, userId, factId);
  return rows[0] ?? null;
}

type CapturedSemanticSearch = Readonly<{
  limit: number | null;
  memoryRefs: readonly string[];
  query: string;
}>;

function resolvedFactIdentities(
  refs: ReturnType<typeof createMemoryConsumerRefService>,
  userId: string,
  memoryRefs: readonly string[]
): readonly string[] {
  return memoryRefs.map((memoryRef) => {
    const identity = refs.resolveItem(userId, memoryRef, "READ");
    ensure(identity, "state_assertion", "memory_mcp_smoke_memory_ref_invalid");
    return `${identity.factId}:${identity.factVersionId}`;
  });
}

async function proveNativeSemanticParity(
  prisma: PrismaClient,
  input: Readonly<{
    captured: CapturedSemanticSearch;
    encryptionKey: Buffer;
    factId: string;
    factVersionId: string;
    factText: string;
    refs: MemoryConsumerRefService;
    userId: string;
  }>
): Promise<Readonly<{
  lexicalTokenOverlap: number;
  nativeIdentityCount: number;
  vectorHit: boolean;
}>> {
  const queryTerms = new Set(
    analyzeMemoryLexicalQuery(input.captured.query).logicalTerms
  );
  const factTerms = analyzeMemoryLexicalQuery(input.factText).logicalTerms;
  const lexicalTokenOverlap = factTerms.filter((term) => queryTerms.has(term)).length;
  ensure(queryTerms.size > 0 && factTerms.length > 0 && lexicalTokenOverlap === 0,
    "state_assertion", "memory_mcp_smoke_lexical_overlap_detected");

  const repository = createPrismaLocalMemoryRetrievalRepository(prisma);
  let observedResult: MemoryLocalRetrievalResult | null = null;
  let observedPlanMatches = false;
  const expectedPlan = createMemoryNativeFactSearchPlan(
    input.captured.query,
    new Date()
  );
  const observedRepository = {
    expand: repository.expand,
    retrieve: async (...args: Parameters<typeof repository.retrieve>) => {
      const result = await repository.retrieve(...args);
      const plan = args[0].plan;
      observedPlanMatches = plan.mode === expectedPlan.mode &&
        plan.originalSanitizedQuery === expectedPlan.originalSanitizedQuery &&
        plan.filters.sourceKinds.length === 1 &&
        plan.filters.sourceKinds[0] === "FACT";
      observedResult = result;
      return result;
    },
    snapshot: repository.snapshot
  };
  const readRepository = createPrismaExplicitMemoryRepository(prisma);
  const verifierUtilities = createPrismaMemoryRunUtilityService(
    defaultMemoryExecutionAuthority,
    prisma,
    {
      embeddingRuntime: createAcceptedEmbeddingRuntime(prisma, {
        encryptionKey: () => Buffer.from(input.encryptionKey)
      }),
      provider: createAcceptedMemoryRunUtilityProvider(prisma, {
        encryptionKey: () => Buffer.from(input.encryptionKey)
      }),
      rerankerRuntime: createAcceptedRerankerRuntime(prisma, {
        encryptionKey: () => Buffer.from(input.encryptionKey)
      })
    }
  );
  const native = createMemoryNativeFactSearchService({
    explicitService: {
      get: async (userId, factId) => {
        const detail = await readRepository.detail(userId, factId);
        if (!detail) throw new ExplicitMemoryServiceError("memory_not_found");
        return detail;
      }
    },
    refs: input.refs,
    repository: observedRepository,
    utilities: {
      async embedQuery(utilityInput) {
        const embedded = await verifierUtilities.embedQuery(utilityInput);
        emit("verifier_embedding", {
          externalCallCount: embedded.externalCallCount ?? 0,
          reason: embedded.status === "UNAVAILABLE" ? embedded.reason : null,
          routeCount: embedded.providerRequestRoutes?.length ?? 0,
          status: embedded.status
        });
        return embedded;
      },
      rerank: verifierUtilities.rerank
    },
    vectorRepository: createPrismaMemoryVectorRepository(prisma)
  });
  const verifierRequestId = `semantic-parity-${randomUUID()}`;
  const result = await native.search(input.userId, {
    limit: input.captured.limit ?? 20,
    query: input.captured.query,
    requestId: verifierRequestId,
    signal: AbortSignal.timeout(26_000)
  });
  const retrievalEvidence = observedResult as MemoryLocalRetrievalResult | null;
  ensure(retrievalEvidence && observedPlanMatches, "state_assertion",
    "memory_mcp_smoke_native_path_unobserved");
  const targetKey = `${input.factId}:${input.factVersionId}`;
  const vectorHit = retrievalEvidence.laneResults.some(({ candidates, lane }) =>
    lane === "FACT_VECTOR" && candidates.some((candidate) =>
      `${candidate.metadata.factId}:${candidate.itemId}` === targetKey));
  const lexicalLanes = new Set([
    "FACT_EXACT",
    "FACT_ENTITY",
    "FACT_LEXICAL_UNICODE",
    "FACT_LEXICAL_NGRAM"
  ]);
  const lexicalHit = retrievalEvidence.laneResults.some(({ candidates, lane }) =>
    lexicalLanes.has(lane) && candidates.some((candidate) =>
      `${candidate.metadata.factId}:${candidate.itemId}` === targetKey));
  emit("semantic_probe", {
    executions: await prisma.memoryExecutionBinding.findMany({
      orderBy: [{ ordinal: "asc" }, { createdAt: "asc" }],
      select: { errorCode: true, logicalRole: true, state: true },
      where: {
        inboundMcpRequestId: verifierRequestId,
        ownerType: "INBOUND_MCP_REQUEST",
        userId: input.userId
      }
    }),
    laneCandidateCounts: retrievalEvidence.laneResults.map(({ candidates, lane }) => ({
      count: candidates.length,
      lane
    })),
    vectorEvidence: retrievalEvidence.vectorEvidence,
    vectorState: retrievalEvidence.vectorState
  });
  ensure(vectorHit, "state_assertion",
    "memory_mcp_smoke_vector_hit_missing");
  ensure(!lexicalHit, "state_assertion",
    "memory_mcp_smoke_lexical_lane_miss_failed");

  const capturedIdentities = resolvedFactIdentities(
    input.refs,
    input.userId,
    input.captured.memoryRefs
  );
  const nativeIdentities = resolvedFactIdentities(
    input.refs,
    input.userId,
    result.items.map(({ memoryRef }) => memoryRef)
  );
  ensure(capturedIdentities.length > 0 &&
    JSON.stringify(capturedIdentities) === JSON.stringify(nativeIdentities) &&
    capturedIdentities.includes(targetKey),
  "state_assertion", "memory_mcp_smoke_native_order_parity_failed");
  return {
    lexicalTokenOverlap,
    nativeIdentityCount: nativeIdentities.length,
    vectorHit
  };
}

async function loginBrowser(
  context: BrowserContext,
  baseUrl: string,
  email: string,
  password: string,
  expectedUserId: string
): Promise<void> {
  let lastError: unknown = null;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const response = await context.request.post(`${baseUrl}/api/auth/login`, {
        data: { email, password },
        headers: { origin: baseUrl },
        timeout: 60_000
      });
      if (!response.ok()) {
        lastError = new SmokeFailure(
          "app_bootstrap",
          "memory_mcp_smoke_login_failed"
        );
      } else {
        const body = await response.json() as { user?: { id?: unknown } };
        ensure(body.user?.id === expectedUserId, "app_bootstrap",
          "memory_mcp_smoke_login_identity_invalid");
        return;
      }
    } catch (error) {
      lastError = error;
    }
    if (attempt < 2) {
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 500));
    }
  }
  if (lastError instanceof SmokeFailure) throw lastError;
  fail("app_bootstrap", "memory_mcp_smoke_login_failed");
}

async function seedFactThroughApi(
  context: BrowserContext,
  baseUrl: string,
  text: string
): Promise<void> {
  const response = await context.request.post(`${baseUrl}/api/me/memories`, {
    data: { requestId: randomUUID(), statement: text },
    headers: { origin: baseUrl }
  });
  ensure(response.status() === 201, "state_assertion",
    "memory_mcp_smoke_seed_failed");
  const decoded = decodeMemoryConsumerMutationResponse(await response.json());
  ensure(decoded.ok && decoded.value.item.statement === text, "state_assertion",
    "memory_mcp_smoke_seed_contract_invalid");
}

async function activeFactsThroughApi(
  context: BrowserContext,
  baseUrl: string
): Promise<readonly string[]> {
  return (await activeItemsThroughApi(context, baseUrl))
    .map((item) => item.statement);
}

async function activeItemsThroughApi(
  context: BrowserContext,
  baseUrl: string
): Promise<readonly Readonly<{ memoryRef: string; statement: string }>[]> {
  const response = await context.request.get(
    `${baseUrl}/api/me/memories?pageSize=20`
  );
  ensure(response.ok(), "state_assertion", "memory_mcp_smoke_list_failed");
  const decoded = decodeMemoryConsumerListResponse(await response.json());
  ensure(decoded.ok, "state_assertion", "memory_mcp_smoke_list_contract_invalid");
  return decoded.value.items.map((item) => ({
    memoryRef: item.memoryRef,
    statement: item.statement
  }));
}

async function connectedApps(
  context: BrowserContext,
  baseUrl: string
): Promise<readonly Readonly<{
  connectionId: string;
  state: "ACTIVE" | "REVOKED";
}>[]> {
  const response = await context.request.get(`${baseUrl}/api/me/connected-apps`);
  ensure(response.ok(), "state_assertion",
    "memory_mcp_smoke_connected_apps_failed");
  const body = await response.json() as {
    apps?: Array<{ connectionId?: unknown; state?: unknown }>;
  };
  ensure(Array.isArray(body.apps), "state_assertion",
    "memory_mcp_smoke_connected_apps_invalid");
  return body.apps.map((app) => {
    ensure(typeof app.connectionId === "string" &&
      (app.state === "ACTIVE" || app.state === "REVOKED"),
    "state_assertion", "memory_mcp_smoke_connected_apps_invalid");
    return { connectionId: app.connectionId, state: app.state };
  });
}

async function revokeConnectedApp(
  context: BrowserContext,
  baseUrl: string,
  connectionId: string
): Promise<void> {
  const response = await context.request.delete(
    `${baseUrl}/api/me/connected-apps/${encodeURIComponent(connectionId)}`,
    { headers: { origin: baseUrl } }
  );
  ensure(response.ok(), "revoke", "memory_mcp_smoke_revoke_failed");
  const decoded = decodeMemoryMcpConnectedAppResponse(await response.json());
  ensure(decoded?.app.state === "REVOKED", "revoke",
    "memory_mcp_smoke_revoke_contract_invalid");
}

function exactToolCoverage(audits: readonly CodexEventAudit[]): readonly string[] {
  const seen = new Set(audits.flatMap((audit) => audit.completedTools));
  return MEMORY_MCP_SMOKE_TOOL_NAMES.filter((name) => seen.has(name));
}

function assertCodexAuditBoundaries(audit: CodexEventAudit): void {
  ensure(audit.invalidLines === 0, "codex_tools",
    "memory_mcp_smoke_codex_events_invalid");
  ensure(audit.foreignMcpCalls === 0, "codex_tools",
    "memory_mcp_smoke_foreign_mcp_called");
  ensure(audit.forbiddenItemTypes.length === 0, "codex_tools",
    "memory_mcp_smoke_forbidden_tool_called");
}

function assertCleanCodexAudit(audit: CodexEventAudit): void {
  assertCodexAuditBoundaries(audit);
  ensure(audit.failedTools.length === 0, "codex_tools",
    "memory_mcp_smoke_memory_tool_failed");
}

async function main(): Promise<void> {
  const startedAt = Date.now();
  loadEnvConfig(REPOSITORY_ROOT, true, {
    error() {},
    info() {}
  }, true);
  const runId = randomBytes(6).toString("hex");
  const databaseName = ownedMemoryMcpSmokeDatabaseName(runId);
  const adminDatabaseUrl = parseDisposableAdminDatabaseUrl(
    process.env.AIQSA_MEMORY_MCP_CODEX_SMOKE,
    process.env.AIQSA_MEMORY_MCP_CODEX_ADMIN_DATABASE_URL ??
      DEFAULT_ADMIN_DATABASE_URL
  );
  const databaseUrl = databaseUrlForOwnedSmoke(adminDatabaseUrl, databaseName);
  const sourceCodexConfig = resolve(
    process.env.AIQSA_MEMORY_MCP_CODEX_SOURCE_CONFIG ??
      join(homedir(), ".codex", "config.toml")
  );
  const provider = codexLbOverridesFromConfig(
    await readFile(sourceCodexConfig, "utf8")
  );
  const encryptionKey = process.env.AIQSA_ENCRYPTION_KEY?.trim() ||
    DISPOSABLE_LOCAL_DEV_ENCRYPTION_KEY;
  const fingerprintKeyring = process.env.AIQSA_MEMORY_FINGERPRINT_KEYRING?.trim() ||
    DISPOSABLE_LOCAL_DEV_FINGERPRINT_KEYRING;
  ensure(Boolean(process.env.CODEX_LB_API_KEY), "preflight",
    "memory_mcp_smoke_codex_lb_key_missing");
  const requestedModel = process.env.AIQSA_MEMORY_MCP_CODEX_MODEL?.trim() ||
    "gpt-5.6-luna";
  ensure(/^gpt-5\.6-(?:luna|terra|sol)$/u.test(requestedModel), "preflight",
    "memory_mcp_smoke_codex_model_invalid");

  const versionResult = await runCaptured("codex", ["--version"]);
  ensure(versionResult.code === 0, "preflight", "memory_mcp_smoke_codex_missing");
  const codexVersion = versionResult.stdout.trim().match(/\d+\.\d+\.\d+/u)?.[0];
  ensure(codexVersion, "preflight", "memory_mcp_smoke_codex_version_invalid");
  const globalBeforeResult = await runCaptured("codex", ["mcp", "list", "--json"]);
  ensure(globalBeforeResult.code === 0, "preflight",
    "memory_mcp_smoke_codex_list_failed");
  const globalBefore = parseCodexMcpList(globalBeforeResult.stdout);
  const globalBeforeSnapshot = JSON.stringify(JSON.parse(globalBeforeResult.stdout));

  const appPort = await freeLoopbackPort();
  const inspectorCallbackPort = await freeLoopbackPort();
  const baseUrl = `http://127.0.0.1:${appPort}`;
  const mcpUrl = `${baseUrl}/mcp`;
  const mcpName = `aiqsa_memory_e2e_${runId}`;
  ensure(!globalBefore.some((entry) => entry.name === mcpName), "preflight",
    "memory_mcp_smoke_codex_name_collision");

  const temporaryRoot = await mkdtemp(join(tmpdir(), "aiqsa-memory-mcp-e2e-"));
  const codexHomePath = join(temporaryRoot, "codex-home");
  const codexWorkPath = join(temporaryRoot, "workspace");
  const inspectorStoragePath = join(temporaryRoot, "inspector-storage");
  const inspectorConfigPath = join(temporaryRoot, "inspector.json");
  const npmCachePath = join(temporaryRoot, "npm-cache");
  const browserCapturePath = join(temporaryRoot, "browser-capture.txt");
  const browserHelperPath = join(temporaryRoot, "capture-browser.cjs");

  const words = [
    "amber", "birch", "cedar", "coral", "fern", "harbor", "indigo",
    "juniper", "linen", "maple", "meadow", "orchard", "pebble",
    "saffron", "willow", "zephyr"
  ];
  const entropy = randomBytes(6);
  const marker = Array.from(entropy, (value) => words[value % words.length]).join(" ");
  const recalledName = `Cedar-${runId}`;
  const seedText = `Пользователя зовут ${recalledName}; контроль ${marker}.`;
  const writtenText = `My synthetic ${marker} briefing preference is amber order.`;
  const updatedText = `My synthetic ${marker} briefing preference is willow order.`;
  const retainedText = `My synthetic ${marker} review preference is linen order.`;
  const email = `memory-mcp-${runId}@example.test`;
  const password = randomBytes(24).toString("base64url");
  const userId = randomUUID();

  let appProcess: ChildProcess | null = null;
  let appDone: Promise<unknown> | null = null;
  let coordinatorProcess: CapturedProcess | null = null;
  let appDiagnosticOutput = "";
  let browser: Browser | null = null;
  let context: BrowserContext | null = null;
  let prisma: PrismaClient | null = null;
  let databaseCreated = false;
  let codexEntryAdded = false;
  let failure: SmokeFailure | null = null;
  let codexConfigurationRestored = false;
  let codexTemporaryEntryRemoved = false;
  let databaseRemoved = false;
  let temporaryResourcesRemoved = false;

  emit("preflight", {
    codexMcpEntries: globalBefore.length,
    codexVersion,
    disposable: true,
    modelProvider: "codex-lb"
  });

  try {
    await chmod(temporaryRoot, 0o700);
    await Promise.all([
      mkdir(codexHomePath, { mode: 0o700 }),
      mkdir(codexWorkPath, { mode: 0o700 }),
      mkdir(inspectorStoragePath, { mode: 0o700 }),
      mkdir(npmCachePath, { mode: 0o700 })
    ]);
    await writeFile(browserHelperPath, `#!/usr/bin/env node
const fs = require("node:fs");
const target = process.env.AIQSA_MEMORY_MCP_BROWSER_CAPTURE;
if (target) fs.appendFileSync(target, process.argv.slice(2).join(" ") + "\\n", { mode: 0o600 });
`, { mode: 0o700 });
    await chmod(browserHelperPath, 0o700);
    await createOwnedDatabase(adminDatabaseUrl, databaseName);
    databaseCreated = true;
    const migration = await guarded(
      "database_bootstrap",
      "memory_mcp_smoke_migration_process_failed",
      () => runCaptured("npx", ["prisma", "migrate", "deploy"], {
        env: processEnvWith({
          AIQSA_LOCAL_DEV_PROFILE_DISABLED: "1",
          AIQSA_TEST_MODE: "1",
          DATABASE_URL: databaseUrl,
          NODE_ENV: "development"
        })
      })
    );
    ensure(migration.code === 0, "database_bootstrap",
      "memory_mcp_smoke_migration_failed");
    const profileEnvironment = processEnvWith({
      AIQSA_ENCRYPTION_KEY: encryptionKey,
      AIQSA_MEMORY_FINGERPRINT_KEYRING: fingerprintKeyring,
      AIQSA_TEST_MODE: "1",
      DATABASE_URL: databaseUrl,
      NODE_ENV: "development"
    });
    delete profileEnvironment.AIQSA_LOCAL_DEV_PROFILE_DISABLED;
    const seededProfile = await guarded(
      "database_bootstrap",
      "memory_mcp_smoke_local_profile_process_failed",
      () => runCaptured("npm", ["run", "db:seed"], {
        env: profileEnvironment,
        timeoutMs: PROFILE_BOOTSTRAP_TIMEOUT_MS
      })
    );
    ensure(seededProfile.code === 0 &&
      `${seededProfile.stdout}\n${seededProfile.stderr}`.includes(
        "Applied the optional local development profile."
      ), "database_bootstrap", "memory_mcp_smoke_local_profile_failed");
    prisma = new PrismaClient({ datasources: { db: { url: databaseUrl } } });
    await guarded("database_bootstrap", "memory_mcp_smoke_prisma_connect_failed",
      () => prisma!.$connect());
    await guarded("database_bootstrap", "memory_mcp_smoke_user_seed_failed",
      () => createSyntheticUser(prisma!, { email, password, userId }));
    const embeddingDeploymentId = await guarded(
      "semantic_index",
      "memory_mcp_smoke_embedding_selection_process_failed",
      () => selectSyntheticEmbedding(prisma!, userId)
    );
    const baselineCounts = await guarded(
      "database_bootstrap",
      "memory_mcp_smoke_baseline_query_failed",
      () => runCounts(prisma!, userId)
    );
    ensure(Object.values(baselineCounts).every((value) => value === 0),
      "database_bootstrap", "memory_mcp_smoke_database_not_empty");
    emit("database_bootstrap", { isolatedDatabase: true, syntheticAccount: true });

    const codexEnvironment = processEnvWith({
      AIQSA_MEMORY_MCP_BROWSER_CAPTURE: browserCapturePath,
      BROWSER: browserHelperPath,
      CODEX_HOME: codexHomePath
    });
    emit("oauth_client", {
      clientStage: "codex_oauth",
      milestone: "isolated_config_check_started"
    });
    const isolatedBefore = await guarded(
      "codex_oauth",
      "memory_mcp_smoke_isolated_codex_list_failed",
      () => runCaptured("codex", ["mcp", "list", "--json"], {
        env: codexEnvironment,
        timeoutMs: 30_000
      })
    );
    ensure(isolatedBefore.code === 0 &&
      parseCodexMcpList(isolatedBefore.stdout).length === 0,
    "preflight", "memory_mcp_smoke_isolated_codex_not_empty");
    emit("oauth_client", {
      clientStage: "codex_oauth",
      milestone: "isolated_config_verified"
    });
    const add = await guarded(
      "codex_oauth",
      "memory_mcp_smoke_codex_add_process_failed",
      () => runCaptured(
        "codex", [
          "mcp", "add", mcpName, "--url", mcpUrl,
          "--oauth-client-registration", "auto"
        ],
        { env: codexEnvironment, timeoutMs: 30_000 }
      )
    );
    ensure(add.code === 0, "codex_oauth", "memory_mcp_smoke_codex_add_failed");
    codexEntryAdded = true;
    emit("oauth_client", { clientStage: "codex_oauth", milestone: "client_added" });

    const sessionSecret = randomBytes(48).toString("base64url");
    const routingKey = randomBytes(32).toString("base64");
    const appEnvironment = processEnvWith({
      AIQSA_APP_BASE_URL: baseUrl,
      AIQSA_AUTH_SESSION_SECRET: sessionSecret,
      AIQSA_BIND_ADDRESS: "127.0.0.1",
      AIQSA_BOOTSTRAP_LOGIN_ENABLED: "",
      AIQSA_COOKIE_SECURE: "0",
      AIQSA_ENCRYPTION_KEY: encryptionKey,
      AIQSA_LOCAL_DEV_PROFILE_DISABLED: "1",
      AIQSA_MEMORY_FINGERPRINT_KEYRING: fingerprintKeyring,
      AIQSA_MEMORY_LEXICAL_BACKEND: "POSTGRES",
      AIQSA_MEMORY_OPENSEARCH_ROUTING_KEY: routingKey,
      AIQSA_MEMORY_OPENSEARCH_ROUTING_KEY_ID: "e2e-v1",
      AIQSA_OPENSEARCH_URL: "http://127.0.0.1:1",
      AIQSA_TEST_MODE: "1",
      AIQSA_TOOLHIVE_URL: "http://127.0.0.1:1",
      DATABASE_URL: databaseUrl,
      NEXT_TELEMETRY_DISABLED: "1",
      NODE_ENV: "development",
      PLAYWRIGHT_TEST_AUTH: "",
      S3_ACCESS_KEY_ID: "e2e",
      S3_BUCKET: "e2e",
      S3_ENDPOINT: "http://127.0.0.1:1",
      S3_REGION: "us-east-1",
      S3_SECRET_ACCESS_KEY: "e2e"
    });
    const app = spawn("npx", [
      "next", "dev", "--hostname", "127.0.0.1", "--port", String(appPort)
    ], {
      cwd: REPOSITORY_ROOT,
      detached: true,
      env: appEnvironment,
      stdio: ["ignore", "pipe", "pipe"]
    });
    appProcess = app;
    const captureAppDiagnostic = (chunk: Buffer | string) => {
      if (Buffer.byteLength(appDiagnosticOutput) >= CHILD_OUTPUT_MAX_BYTES) return;
      appDiagnosticOutput += chunk.toString().slice(
        0,
        CHILD_OUTPUT_MAX_BYTES - Buffer.byteLength(appDiagnosticOutput)
      );
    };
    app.stdout?.on("data", captureAppDiagnostic);
    app.stderr?.on("data", captureAppDiagnostic);
    appDone = new Promise((resolvePromise) => app.once("close", resolvePromise));
    await waitForApp(baseUrl, app);
    emit("app_bootstrap", { loopbackOnly: true, ready: true });

    coordinatorProcess = spawnCaptured("npm", ["run", "memory:coordinator"], {
      env: appEnvironment,
      timeoutMs: COORDINATOR_PROCESS_TIMEOUT_MS
    });
    await waitForCoordinator(coordinatorProcess);
    const activeGenerationId = await guarded(
      "semantic_index",
      "memory_mcp_smoke_hybrid_generation_failed",
      () => activateEmptyHybridGeneration(
        prisma!,
        userId,
        embeddingDeploymentId,
        coordinatorProcess!
      )
    );
    emit("semantic_index", {
      coordinatorReady: true,
      hybridGenerationActive: true,
      localProfileApplied: true
    });

    browser = await guarded(
      "app_bootstrap",
      "memory_mcp_smoke_browser_launch_failed",
      () => chromium.launch({
        executablePath: process.env.AIQSA_MEMORY_MCP_BROWSER_PATH ??
          "/usr/bin/google-chrome",
        headless: true
      })
    );
    context = await guarded(
      "app_bootstrap",
      "memory_mcp_smoke_browser_context_failed",
      () => browser!.newContext()
    );
    const page = await guarded(
      "app_bootstrap",
      "memory_mcp_smoke_browser_page_failed",
      () => context!.newPage()
    );
    await guarded(
      "app_bootstrap",
      "memory_mcp_smoke_browser_login_failed",
      () => loginBrowser(context!, baseUrl, email, password, userId)
    );
    await guarded(
      "app_bootstrap",
      "memory_mcp_smoke_seed_fact_failed",
      () => seedFactThroughApi(context!, baseUrl, seedText)
    );
    const seedFact = await currentFactByText(prisma, userId, seedText);
    ensure(seedFact?.state === "ACTIVE" && seedFact.currentVersionId,
      "semantic_index", "memory_mcp_smoke_seed_fact_missing");
    await waitForFactVector(prisma, {
      factVersionId: seedFact.currentVersionId,
      generationId: activeGenerationId,
      userId
    }, coordinatorProcess);
    emit("app_bootstrap", {
      authenticated: true,
      seedFactCreated: true,
      seedFactVectorReady: true
    });
    await runBrowserOAuth({
      args: ["mcp", "login", mcpName, "--oauth-client-registration", "auto"],
      browserCapturePath,
      command: "codex",
      env: codexEnvironment,
      issuer: baseUrl,
      page,
      stage: "codex_oauth"
    });
    const authenticatedListResult = await guarded(
      "codex_oauth",
      "memory_mcp_smoke_authenticated_codex_list_failed",
      () => runCaptured("codex", ["mcp", "list", "--json"], {
        env: codexEnvironment,
        timeoutMs: 30_000
      })
    );
    ensure(authenticatedListResult.code === 0, "codex_oauth",
      "memory_mcp_smoke_authenticated_codex_list_failed");
    const authenticatedEntries = parseCodexMcpList(authenticatedListResult.stdout);
    const authenticatedEntry = authenticatedEntries.find(
      (entry) => entry.name === mcpName
    );
    ensure(authenticatedEntries.length === 1 && authenticatedEntry?.enabled,
      "codex_oauth", "memory_mcp_smoke_authenticated_codex_entry_invalid");
    emit("oauth_client", {
      authStatus: authenticatedEntry.authStatus,
      clientStage: "codex_oauth",
      milestone: "authenticated_config_verified"
    });
    const codexApps = await connectedApps(context, baseUrl);
    ensure(codexApps.length === 1 && codexApps[0]?.state === "ACTIVE",
      "codex_oauth", "memory_mcp_smoke_codex_grant_missing");
    const codexConnectionId = codexApps[0].connectionId;
    emit("oauth", {
      authorized: true,
      browserConsent: true,
      registrationStrategy: "auto"
    });

    const inspectorEnvironment = processEnvWith({
      AIQSA_MEMORY_MCP_BROWSER_CAPTURE: browserCapturePath,
      BROWSER: browserHelperPath,
      MCP_AUTO_OPEN_ENABLED: "true",
      MCP_OAUTH_CALLBACK_URL:
        `http://127.0.0.1:${inspectorCallbackPort}/oauth/callback`,
      MCP_STORAGE_DIR: inspectorStoragePath,
      npm_config_cache: npmCachePath
    });
    const inspectorServerName = "aiqsa-memory-modern";
    await writeFile(inspectorConfigPath, JSON.stringify({
      mcpServers: {
        [inspectorServerName]: {
          protocolEra: "modern",
          type: "http",
          url: mcpUrl
        }
      }
    }), { mode: 0o600 });
    const inspectorBaseArgs = [
      "-y", "@modelcontextprotocol/inspector", "--cli",
      "--config", inspectorConfigPath,
      "--server", inspectorServerName,
      "--format", "json"
    ];
    const inspectorInitialize = await runBrowserOAuth({
      args: [...inspectorBaseArgs, "--method", "initialize"],
      browserCapturePath,
      command: "npx",
      env: inspectorEnvironment,
      issuer: baseUrl,
      page,
      stage: "inspector",
      timeoutMs: CLIENT_TIMEOUT_MS
    });
    const initialized = parseInspectorInitialize(inspectorInitialize.stdout.trim());
    ensure(initialized.protocolVersion === EXPECTED_PROTOCOL_VERSION, "inspector",
      "memory_mcp_smoke_inspector_protocol_mismatch");
    const inspectorList = await runCaptured("npx", [
      ...inspectorBaseArgs,
      "--stored-auth-only",
      "--strict",
      "--method", "tools/list"
    ], { env: inspectorEnvironment });
    ensure(inspectorList.code === 0, "inspector",
      "memory_mcp_smoke_inspector_tools_failed");
    const inspectorTools = parseInspectorToolNames(inspectorList.stdout.trim());
    ensure(JSON.stringify(inspectorTools) ===
      JSON.stringify(MEMORY_MCP_SMOKE_TOOL_NAMES),
    "inspector", "memory_mcp_smoke_inspector_tool_catalog_mismatch");
    const inspectorVersionResult = await runCaptured(
      "npm", ["view", "@modelcontextprotocol/inspector", "version", "--json"],
      { env: inspectorEnvironment }
    );
    const inspectorVersion = inspectorVersionResult.stdout.trim()
      .match(/\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?/u)?.[0] ?? "current";
    emit("inspector", {
      inspectorVersion,
      protocolVersion: initialized.protocolVersion,
      strictSchemas: true,
      toolNames: inspectorTools
    });

    const execBaseArgs = [
      "exec",
      "--ephemeral",
      "--json",
      "--sandbox", "read-only",
      "--ignore-user-config",
      "--ignore-rules",
      "--skip-git-repo-check",
      "--cd", codexWorkPath,
      "--model", requestedModel,
      ...provider.args,
      "-c", "model_reasoning_effort=\"medium\"",
      "-c", "approval_policy=\"never\"",
      "-c", "shell_environment_policy.inherit=\"none\"",
      "-c", `mcp_servers.${mcpName}.url=${JSON.stringify(mcpUrl)}`,
      "-c", `mcp_servers.${mcpName}.enabled_tools=${JSON.stringify(
        MEMORY_MCP_SMOKE_TOOL_NAMES
      )}`,
      "-c", `mcp_servers.${mcpName}.default_tools_approval_mode="approve"`,
      "-c", `mcp_servers.${mcpName}.startup_timeout_sec=30`,
      "-c", `mcp_servers.${mcpName}.tool_timeout_sec=30`
    ];
    const recallRun = await runCaptured(
      "codex", [...execBaseArgs, "What is my name?"],
      { cwd: codexWorkPath, env: codexEnvironment }
    );
    ensure(recallRun.code === 0, "codex_tools",
      "memory_mcp_smoke_codex_autonomous_recall_failed");
    const recallAudit = auditCodexJsonEvents({
      events: recallRun.stdout,
      evidenceNeedles: { seedRecall: seedText },
      expectedServer: mcpName,
      stderr: recallRun.stderr
    });
    const recallAnswerContainsName = codexAgentMessageContains(
      recallRun.stdout,
      recalledName
    );
    emit("codex_recall_attempt", {
      answerContainsName: recallAnswerContainsName,
      completedTools: recallAudit.completedTools,
      seedObserved: recallAudit.evidence.seedRecall
    });
    assertCleanCodexAudit(recallAudit);
    ensure(recallAudit.completedTools.includes("search_memories") &&
      recallAudit.completedTools.every((tool) => [
        "search_memories", "list_memories", "get_memory"
      ].includes(tool)),
    "codex_tools", "memory_mcp_smoke_codex_autonomous_read_missing");
    ensure(recallAudit.evidence.seedRecall && recallAnswerContainsName,
    "codex_tools", "memory_mcp_smoke_codex_autonomous_answer_invalid");
    const refEncryptionKey = parseSecretEncryptionKey(encryptionKey);
    const refVerifier = createMemoryConsumerRefService({
      encryptionKey: () => refEncryptionKey
    });
    const capturedSemanticSearch = recallAudit.capturedSearchCalls.find((call) =>
      call.memoryRefs.some((memoryRef) => {
        const identity = refVerifier.resolveItem(userId, memoryRef, "READ");
        return identity?.factId === seedFact.factId &&
          identity.factVersionId === seedFact.currentVersionId;
      }));
    ensure(capturedSemanticSearch, "codex_tools",
      "memory_mcp_smoke_semantic_search_evidence_missing");
    const autonomousSearchCount = recallAudit.completedTools.filter(
      (tool) => tool === "search_memories"
    ).length;
    const autonomousExecutions = await inboundExecutionSnapshot(prisma, userId);
    ensure(autonomousExecutions.failed === 0 &&
      autonomousExecutions.unexpectedRoles === 0 &&
      autonomousExecutions.queryEmbedding === autonomousSearchCount &&
      autonomousExecutions.rerank === autonomousSearchCount &&
      autonomousExecutions.ownerCount === autonomousSearchCount,
    "state_assertion", "memory_mcp_smoke_native_utility_execution_invalid");
    const semanticEvidence = await proveNativeSemanticParity(prisma, {
      captured: capturedSemanticSearch,
      encryptionKey: refEncryptionKey,
      factId: seedFact.factId,
      factText: seedText,
      factVersionId: seedFact.currentVersionId,
      refs: refVerifier,
      userId
    });
    emit("semantic_recall", {
      actualToolQueryCaptured: true,
      lexicalMiss: semanticEvidence.lexicalTokenOverlap === 0,
      nativeIdentityCount: semanticEvidence.nativeIdentityCount,
      orderedNativeParity: true,
      queryEmbeddingSucceeded: true,
      rerankerSucceeded: true,
      vectorHit: semanticEvidence.vectorHit
    });
    emit("codex_recall", {
      answeredFromMemory: true,
      autonomous: true,
      completedTools: recallAudit.completedTools,
      seedObserved: true,
      semantic: true
    });

    const firstPrompt = [
      `Use only tools from the MCP server ${mcpName}; never use shell, web, files, or any other tool.`,
      "Call search_memories with query \"What is my name?\".",
      "From that search result, call get_memory for the exact fact containing the synthetic user's name.",
      `Then call add_memory once with text ${JSON.stringify(writtenText)}.`,
      `Then call add_memory once with text ${JSON.stringify(retainedText)}.`,
      "Perform every requested tool call and then reply with only done."
    ].join(" ");
    const firstRun = await runCaptured(
      "codex", [...execBaseArgs, firstPrompt],
      { cwd: codexWorkPath, env: codexEnvironment }
    );
    ensure(firstRun.code === 0, "codex_tools",
      "memory_mcp_smoke_codex_first_turn_failed");
    const firstAudit = auditCodexJsonEvents({
      events: firstRun.stdout,
      evidenceNeedles: {
        retainedWrite: retainedText,
        seedRecall: seedText,
        write: writtenText
      },
      expectedServer: mcpName,
      stderr: firstRun.stderr
    });
    emit("codex_turn", {
      completedTools: firstAudit.completedTools,
      evidence: firstAudit.evidence,
      failedTools: firstAudit.failedTools,
      forbiddenItemTypes: firstAudit.forbiddenItemTypes,
      foreignMcpCalls: firstAudit.foreignMcpCalls,
      invalidLines: firstAudit.invalidLines,
      toolCalls: firstAudit.toolCalls,
      toolErrorCodes: firstAudit.toolErrorCodes,
      turn: 1
    });
    assertCleanCodexAudit(firstAudit);
    for (const required of ["search_memories", "get_memory", "add_memory"] as const) {
      ensure(firstAudit.completedTools.includes(required), "codex_tools",
        "memory_mcp_smoke_codex_first_tool_missing");
    }
    ensure(firstAudit.completedTools.filter((tool) => tool === "add_memory").length === 2,
      "codex_tools", "memory_mcp_smoke_codex_add_count_invalid");
    ensure(Object.values(firstAudit.evidence).every(Boolean), "codex_tools",
      "memory_mcp_smoke_codex_first_evidence_missing");

    const writtenFact = await currentFactByText(prisma, userId, writtenText);
    const retainedFactBeforeRevoke = await currentFactByText(prisma, userId, retainedText);
    ensure(writtenFact?.state === "ACTIVE" && writtenFact.currentVersionId,
      "state_assertion", "memory_mcp_smoke_codex_add_not_persisted");
    ensure(retainedFactBeforeRevoke?.state === "ACTIVE",
      "state_assertion", "memory_mcp_smoke_retained_add_not_persisted");
    const originalWrittenVersionId = writtenFact.currentVersionId;
    const writtenItem = (await activeItemsThroughApi(context, baseUrl))
      .find((item) => item.statement === writtenText);
    ensure(writtenItem, "state_assertion",
      "memory_mcp_smoke_codex_add_not_visible");

    const secondPrompt = [
      `Use only tools from the MCP server ${mcpName}; never use shell, web, files, or any other tool.`,
      "The user authorizes these exact operations on this disposable synthetic test fact.",
      `Call get_memory with memoryRef ${JSON.stringify(writtenItem.memoryRef)}.`,
      `Call update_memory with that fresh memoryRef and text ${JSON.stringify(updatedText)}.`,
      "Call list_memories with provenance SAVED and limit 20, and locate that updated fact.",
      "Call delete_memory with the current memoryRef returned by update_memory or list_memories for that exact updated fact.",
      "After deletion, call get_memory exactly once with that just-deleted memoryRef; memory_not_found is the expected proof of deletion, so do not retry it.",
      "Perform every requested tool call and then reply with only done."
    ].join(" ");
    const secondRun = await runCaptured(
      "codex", [...execBaseArgs, secondPrompt],
      { cwd: codexWorkPath, env: codexEnvironment }
    );
    ensure(secondRun.code === 0, "codex_tools",
      "memory_mcp_smoke_codex_second_turn_failed");
    const secondAudit = auditCodexJsonEvents({
      events: secondRun.stdout,
      evidenceNeedles: { update: updatedText },
      expectedServer: mcpName,
      stderr: secondRun.stderr
    });
    emit("codex_turn", {
      completedTools: secondAudit.completedTools,
      evidence: secondAudit.evidence,
      failedTools: secondAudit.failedTools,
      forbiddenItemTypes: secondAudit.forbiddenItemTypes,
      foreignMcpCalls: secondAudit.foreignMcpCalls,
      invalidLines: secondAudit.invalidLines,
      toolCalls: secondAudit.toolCalls,
      toolErrorCodes: secondAudit.toolErrorCodes,
      turn: 2
    });
    assertCodexAuditBoundaries(secondAudit);
    const deleteCallIndex = secondAudit.toolCalls.findIndex((call) =>
      call.tool === "delete_memory" && call.status === "COMPLETED");
    const expectedNotFoundCalls = secondAudit.toolCalls.filter((call, index) =>
      call.tool === "get_memory" && call.status === "FAILED" &&
      index > deleteCallIndex &&
      call.errorCodes.length === 1 && call.errorCodes[0] === "memory_not_found");
    ensure(deleteCallIndex >= 0 && expectedNotFoundCalls.length >= 1 &&
      secondAudit.failedTools.length === expectedNotFoundCalls.length,
    "codex_tools", "memory_mcp_smoke_post_delete_read_invalid");
    for (const required of [
      "get_memory", "update_memory", "list_memories", "delete_memory"
    ] as const) {
      ensure(secondAudit.completedTools.includes(required), "codex_tools",
        "memory_mcp_smoke_codex_second_tool_missing");
    }
    ensure(secondAudit.evidence.update, "codex_tools",
      "memory_mcp_smoke_codex_update_evidence_missing");
    const coveredTools = exactToolCoverage([recallAudit, firstAudit, secondAudit]);
    ensure(coveredTools.length === MEMORY_MCP_SMOKE_TOOL_NAMES.length,
      "codex_tools", "memory_mcp_smoke_codex_tool_coverage_incomplete");

    const forgottenFact = await factById(prisma, userId, writtenFact.factId);
    ensure(forgottenFact?.state === "FORGOTTEN" && forgottenFact.forgottenAt &&
      forgottenFact.versionCount >= 2,
    "state_assertion", "memory_mcp_smoke_forget_not_durable");
    const updatedVersion = await prisma.memoryFactVersion.findFirst({
      select: { id: true },
      where: {
        displayText: updatedText,
        factId: writtenFact.factId,
        userId
      }
    });
    ensure(updatedVersion && updatedVersion.id !== originalWrittenVersionId,
      "state_assertion", "memory_mcp_smoke_version_not_changed");
    const deletionOutbox = await prisma.memoryDeletionOutbox.count({
      where: {
        operation: "FORGET_PURGE",
        targetId: writtenFact.factId,
        userId
      }
    });
    ensure(deletionOutbox === 1, "state_assertion",
      "memory_mcp_smoke_forget_obligation_missing");
    const activeFacts = await activeFactsThroughApi(context, baseUrl);
    ensure(!activeFacts.includes(writtenText) && !activeFacts.includes(updatedText) &&
      activeFacts.includes(seedText) && activeFacts.includes(retainedText),
    "state_assertion", "memory_mcp_smoke_active_read_invalid");
    const afterToolCounts = await runCounts(prisma, userId);
    ensure(JSON.stringify(afterToolCounts) === JSON.stringify(baselineCounts),
      "state_assertion", "memory_mcp_smoke_synthetic_run_state_created");
    const completedSearches = [recallAudit, firstAudit, secondAudit]
      .flatMap((audit) => audit.completedTools)
      .filter((tool) => tool === "search_memories").length;
    const finalExecutions = await inboundExecutionSnapshot(prisma, userId);
    ensure(finalExecutions.failed === 0 && finalExecutions.unexpectedRoles === 0 &&
      finalExecutions.queryEmbedding === completedSearches + 1 &&
      finalExecutions.rerank === completedSearches + 1 &&
      finalExecutions.ownerCount === completedSearches + 1,
    "state_assertion", "memory_mcp_smoke_execution_totals_invalid");
    emit("codex_tools", {
      forbiddenToolCalls: 0,
      toolCallCount: recallAudit.completedTools.length +
        firstAudit.completedTools.length + secondAudit.completedTools.length,
      toolNames: coveredTools
    });
    emit("state", {
      addVisible: true,
      durableForget: true,
      historyRunDeltas: afterToolCounts,
      postDeleteNotFound: true,
      seedObserved: true,
      updateVisible: true,
      versionChanged: true,
      nativeQueryEmbeddingExecutions: finalExecutions.queryEmbedding,
      nativeRerankerExecutions: finalExecutions.rerank
    });

    await revokeConnectedApp(context, baseUrl, codexConnectionId);
    const grant = await prisma.inboundMcpOAuthGrant.findUnique({
      select: {
        state: true,
        tokenFamilies: { select: { revokedAt: true } }
      },
      where: { id: codexConnectionId }
    });
    ensure(grant?.state === "REVOKED" && grant.tokenFamilies.length > 0 &&
      grant.tokenFamilies.every((family) => family.revokedAt instanceof Date),
    "revoke", "memory_mcp_smoke_revoke_not_terminal");
    const retainedAfterRevoke = await currentFactByText(prisma, userId, retainedText);
    ensure(retainedAfterRevoke?.factId === retainedFactBeforeRevoke.factId &&
      retainedAfterRevoke.state === "ACTIVE",
    "revoke", "memory_mcp_smoke_revoke_deleted_fact");

    const revokedPrompt = [
      `Use only the search_memories tool from MCP server ${mcpName}.`,
      `Search once for ${JSON.stringify(marker)} and do not use shell, web, files, or another tool.`
    ].join(" ");
    const revokedRun = await runCaptured(
      "codex", [...execBaseArgs, revokedPrompt],
      { cwd: codexWorkPath, env: codexEnvironment }
    );
    const revokedAudit = auditCodexJsonEvents({
      events: revokedRun.stdout,
      expectedServer: mcpName,
      stderr: revokedRun.stderr
    });
    ensure(revokedAudit.completedTools.length === 0 &&
      revokedAudit.forbiddenItemTypes.length === 0 &&
      revokedAudit.foreignMcpCalls === 0 &&
      (revokedRun.code !== 0 || revokedAudit.authorizationSignal),
    "revoke", "memory_mcp_smoke_revoked_client_executed");
    emit("revoke", {
      blockedBeforeToolExecution: true,
      factsRetained: true,
      requiresFreshAuthorization: true
    });
  } catch (error) {
    failure = safeError(error);
    if (process.env.AIQSA_MEMORY_MCP_SMOKE_DEBUG === "SANITIZED") {
      const failureDiagnostic = error instanceof Error
        ? `${error.name}: ${error.message}`
        : "unknown error";
      emit("diagnostic", {
        clientStage: failure.stage,
        lines: sanitizedDiagnosticLines(
          `${failureDiagnostic}\n${appDiagnosticOutput}`
        )
      });
    }
  } finally {
    if (codexEntryAdded) {
      const codexEnvironment = processEnvWith({ CODEX_HOME: codexHomePath });
      await runCaptured("codex", ["mcp", "logout", mcpName], {
        env: codexEnvironment,
        timeoutMs: 30_000
      }).catch(() => undefined);
      await runCaptured("codex", ["mcp", "remove", mcpName], {
        env: codexEnvironment,
        timeoutMs: 30_000
      }).catch(() => undefined);
      try {
        const temporaryList = await runCaptured(
          "codex", ["mcp", "list", "--json"],
          { env: codexEnvironment, timeoutMs: 30_000 }
        );
        codexTemporaryEntryRemoved = temporaryList.code === 0 &&
          parseCodexMcpList(temporaryList.stdout).length === 0;
      } catch {
        codexTemporaryEntryRemoved = false;
      }
      if (!codexTemporaryEntryRemoved) {
        failure ??= new SmokeFailure(
          "cleanup",
          "memory_mcp_smoke_temporary_codex_entry_cleanup_failed"
        );
      }
    } else {
      codexTemporaryEntryRemoved = true;
    }
    await context?.close().catch(() => undefined);
    await browser?.close().catch(() => undefined);
    await stopProcessGroup(coordinatorProcess?.child ?? null).catch(() => undefined);
    await coordinatorProcess?.done.catch(() => undefined);
    await stopProcessGroup(appProcess).catch(() => undefined);
    await appDone?.catch(() => undefined);
    await prisma?.$disconnect().catch(() => undefined);
    if (databaseCreated) {
      try {
        await dropOwnedDatabase(adminDatabaseUrl, databaseName);
        databaseRemoved = true;
      } catch {
        failure ??= new SmokeFailure("cleanup", "memory_mcp_smoke_database_cleanup_failed");
      }
    }
    try {
      const globalAfterResult = await runCaptured(
        "codex", ["mcp", "list", "--json"], { timeoutMs: 30_000 }
      );
      const globalAfter = globalAfterResult.code === 0
        ? parseCodexMcpList(globalAfterResult.stdout)
        : [];
      codexConfigurationRestored = globalAfterResult.code === 0 &&
        JSON.stringify(globalAfter) === JSON.stringify(globalBefore) &&
        JSON.stringify(JSON.parse(globalAfterResult.stdout)) === globalBeforeSnapshot;
      if (!codexConfigurationRestored) {
        failure ??= new SmokeFailure(
          "cleanup",
          "memory_mcp_smoke_codex_configuration_changed"
        );
      }
    } catch {
      failure ??= new SmokeFailure(
        "cleanup",
        "memory_mcp_smoke_codex_configuration_check_failed"
      );
    }
    const safeTemporaryRoot = basename(temporaryRoot)
      .startsWith("aiqsa-memory-mcp-e2e-") &&
      resolve(temporaryRoot).startsWith(`${resolve(tmpdir())}/`);
    if (safeTemporaryRoot) {
      await rm(temporaryRoot, { force: true, recursive: true }).then(() => {
        temporaryResourcesRemoved = true;
      }).catch(() => {
        failure ??= new SmokeFailure("cleanup", "memory_mcp_smoke_temp_cleanup_failed");
      });
    } else {
      failure ??= new SmokeFailure("cleanup", "memory_mcp_smoke_temp_path_invalid");
    }
    emit("cleanup", {
      codexConfigurationRestored,
      codexTemporaryEntryRemoved,
      databaseRemoved,
      temporaryResourcesRemoved
    });
  }

  if (failure) {
    emit("failure", { code: failure.code, failedStage: failure.stage });
    process.exitCode = 1;
    return;
  }
  emit("complete", {
    durationMs: Math.min(Date.now() - startedAt, 3_600_000),
    passed: true
  });
}

const entryPath = process.argv[1];
if (entryPath && import.meta.url === pathToFileURL(entryPath).href) {
  void main().catch((error: unknown) => {
    const failure = safeError(error);
    emit("failure", { code: failure.code, failedStage: failure.stage });
    process.exitCode = 1;
  });
}
