import { randomBytes, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { once } from "node:events";
import { nodeByteStream } from "../http/byteStream";
import {
  decodeWorkspaceInboxIndexAttachments,
  WORKSPACE_INBOX_INDEX_VERSION,
  WORKSPACE_INBOX_INDEX_MAX_ENTRIES,
  isWorkspaceOpaqueId,
  workspaceAttachmentPath,
  workspaceToolIsAllowed
} from "@/lib/domain/workspace";
import {
  WorkspaceRuntimeError,
  type WorkspaceOutputStream,
  type WorkspaceRuntime
} from "./runtime";
import { parseWorkspaceOperation, WorkspaceOperationFence, type WorkspaceOperation } from "./operationFence";
import { parseOutputCaptureRequest } from "./outputManifest";
import { parseAcceptedWorkspaceSecrets, WORKSPACE_SECRETS_REQUEST_MAX_BYTES } from "./secrets/manifest";
import { logEvent, reportSubsystemFailure, runInBackground, runWithContext, type LifecycleStage } from "../observability";
import { AGENT_PROMPT_MAX_BYTES } from "../agents/guest";
import { renderCodexManagedProfile, type CodexManagedProfile } from "../agents/codexProfile";
import { observeWorkspaceHealth, workspaceLifecycleFailure } from "./lifecycleObservability";
import { parseSkillBundleRef, parseSkillInitial, SKILL_RUNTIME_JSON_MAX_BYTES,
  skillOperationSignal, validateSkillArchiveMetadata, validateSkillIdentity } from "./skillBundles";

const JSON_BODY_MAX_BYTES = 2 * 1_024 * 1_024;
const HEADER_VALUE_MAX_BYTES = 2_048;
/**
 * Output handles live in batches. A batch stays valid while the application
 * keeps opening its handles (inactivity lease, refreshed on every open and
 * while a stream is active), never expires under an active stream, and is
 * always discarded after an absolute safety lifetime so abandoned exports
 * cannot pin guest streams forever. Each handle is still single-use.
 */
const PENDING_OUTPUT_INACTIVITY_MS = 10 * 60_000;
const PENDING_OUTPUT_ABSOLUTE_MAX_MS = 6 * 60 * 60_000;
const REQUEST_TIMEOUT_MS = 3_700_000;

type PendingOutput = Readonly<{
  output: WorkspaceOutputStream;
}>;

type PendingBatch = {
  activeStreams: number;
  readonly createdAt: number;
  expiresAt: number;
  readonly handles: Map<string, PendingOutput>;
  readonly sessionId: string;
  readonly operation: WorkspaceOperation;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function sendJson(response: ServerResponse, status: number, value: unknown): void {
  const body = JSON.stringify(value);
  response.writeHead(status, {
    "cache-control": "no-store",
    "content-length": Buffer.byteLength(body),
    "content-type": "application/json; charset=utf-8",
    "x-content-type-options": "nosniff"
  });
  response.end(body);
}

function errorCode(error: unknown): string {
  return error instanceof WorkspaceRuntimeError
    ? error.code
    : "workspace_runtime_unavailable";
}

function header(request: IncomingMessage, name: string): string | null {
  const value = request.headers[name];
  if (typeof value !== "string" || Buffer.byteLength(value, "utf8") > HEADER_VALUE_MAX_BYTES) {
    return null;
  }
  return value;
}

function authorized(request: IncomingMessage, token: string): boolean {
  const value = header(request, "authorization");
  if (!value?.startsWith("Bearer ")) return false;
  const provided = Buffer.from(value.slice(7), "utf8");
  const expected = Buffer.from(token, "utf8");
  return provided.byteLength === expected.byteLength && timingSafeEqual(provided, expected);
}

async function readJson(request: IncomingMessage, maxBytes = JSON_BODY_MAX_BYTES): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let byteLength = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    byteLength += buffer.byteLength;
    if (byteLength > maxBytes) throw new Error("body_too_large");
    chunks.push(buffer);
  }
  const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
  if (!isRecord(parsed)) throw new Error("body_invalid");
  return parsed;
}

function requiredString(value: unknown, maximum = 512): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    Buffer.byteLength(value, "utf8") > maximum ||
    /[\u0000-\u001f\u007f]/u.test(value)
  ) {
    throw new Error("field_invalid");
  }
  return value;
}

function optionalString(value: unknown, maximum = 512): string | null {
  return value === null ? null : requiredString(value, maximum);
}

function integer(value: unknown, minimum: number, maximum: number): number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum || (value as number) > maximum) {
    throw new Error("field_invalid");
  }
  return value as number;
}

function boolean(value: unknown): boolean {
  if (typeof value !== "boolean") throw new Error("field_invalid");
  return value;
}

function incomingBody(request: IncomingMessage): ReadableStream<Uint8Array> {
  return nodeByteStream(request);
}

async function pipeOutput(response: ServerResponse, pending: PendingOutput, signal: AbortSignal): Promise<void> {
  const reader = pending.output.body.getReader();
  let written = 0;
  response.writeHead(200, {
    "cache-control": "private, no-store",
    "content-disposition": "attachment",
    "content-length": String(pending.output.byteSize),
    "content-type": pending.output.mimeType,
    "x-content-type-options": "nosniff"
  });
  const abort = () => void reader.cancel("client_disconnected").catch(() => undefined);
  response.on("close", abort);
  signal.addEventListener("abort", abort, { once: true });
  try {
    signal.throwIfAborted();
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      written += next.value.byteLength;
      if (written > pending.output.byteSize) throw new Error("stream_size_mismatch");
      if (!response.write(next.value)) await once(response, "drain");
    }
    if (written !== pending.output.byteSize) throw new Error("stream_size_mismatch");
    response.end();
  } finally {
    response.off("close", abort);
    signal.removeEventListener("abort", abort);
    reader.releaseLock();
  }
}

export function createWorkspaceRunnerServer(input: Readonly<{
  /** Clock for pending-output expiry; tests inject a controllable clock. */
  now?: () => number;
  /** Private runtime-volume directory; omitted only by isolated unit fixtures. */
  operationDirectory?: string;
  runtime: WorkspaceRuntime;
  token: string;
}>): Server {
  if (input.token.length < 32) throw new Error("workspace_runner_token_invalid");
  const clock = input.now ?? Date.now;
  const fence = new WorkspaceOperationFence({
    directory: input.operationDirectory,
    stop: (request) => input.runtime.stopSession(request)
  });
  const batches = new Map<string, PendingBatch>();
  const discardBatch = (batchId: string, reason: string) => {
    const batch = batches.get(batchId);
    if (!batch) return;
    for (const pending of batch.handles.values()) {
      void pending.output.body.cancel(reason).catch(() => undefined);
    }
    batches.delete(batchId);
  };
  const prunePending = () => {
    const now = clock();
    for (const [batchId, batch] of batches) {
      if (batch.activeStreams > 0) continue;
      if (batch.expiresAt <= now || batch.createdAt + PENDING_OUTPUT_ABSOLUTE_MAX_MS <= now) {
        discardBatch(batchId, "expired");
      }
    }
  };
  const registerBatch = (sessionId: string, operation: WorkspaceOperation, outputs: readonly WorkspaceOutputStream[]) => {
    const now = clock();
    const batchId = randomBytes(16).toString("hex");
    batches.set(batchId, {
      activeStreams: 0,
      createdAt: now,
      expiresAt: now + PENDING_OUTPUT_INACTIVITY_MS,
      handles: new Map(outputs.map((output) => [output.opaqueFileId, { output }])),
      operation,
      sessionId
    });
    return batchId;
  };

  const server = createServer((request, response) => runInBackground(async () => {
    response.setHeader("cache-control", "no-store");
    if (!authorized(request, input.token)) {
      sendJson(response, 401, { error: "workspace_runtime_unavailable" });
      return;
    }
    const url = new URL(request.url ?? "/", "http://workspace-runner.invalid");
    let stage: LifecycleStage = "preflight";
    try {
      if (request.method === "GET" && url.pathname === "/health") {
        stage = "health";
        const health = await input.runtime.health();
        observeWorkspaceHealth(health, "runner");
        sendJson(response, 200, health);
        return;
      }
      if (request.method === "GET" && url.pathname === "/v1/inventory") {
        stage = "discover";
        if (!input.runtime.listSessions) throw new WorkspaceRuntimeError("workspace_runtime_incompatible");
        if ([...url.searchParams.keys()].some((key) => key !== "cursor") || url.searchParams.getAll("cursor").length > 1) {
          throw new Error("field_invalid");
        }
        const cursor = url.searchParams.has("cursor") ? requiredString(url.searchParams.get("cursor"), 2_048) : undefined;
        const controller = new AbortController();
        const abort = () => controller.abort();
        response.once("close", abort);
        const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(5_000)]);
        let rejectAborted: (() => void) | undefined;
        try {
          const deadline = new Promise<never>((_resolve, reject) => {
            rejectAborted = () => reject(new WorkspaceRuntimeError("workspace_runtime_unavailable"));
            signal.addEventListener("abort", rejectAborted, { once: true });
          });
          sendJson(response, 200, await Promise.race([
            input.runtime.listSessions({ ...(cursor ? { cursor } : {}), signal }), deadline
          ]));
        } finally {
          response.off("close", abort);
          if (rejectAborted) signal.removeEventListener("abort", rejectAborted);
        }
        return;
      }
      if (request.method === "POST" && url.pathname === "/v1/sessions/ensure") {
        stage = "initialize";
        const body = await readJson(request);
        const sessionId = requiredString(body.sessionId, 128);
        if (!isWorkspaceOpaqueId(sessionId)) throw new Error("field_invalid");
        const operation = parseWorkspaceOperation(body.operation);
        const runtimeSandboxId = optionalString(body.runtimeSandboxId, 256);
        const ensure = {
          cpus: integer(body.cpus, 1, 8),
          diskMiB: integer(body.diskMiB, 1_024, 131_072),
          imageRef: requiredString(body.imageRef),
          internetEnabled: boolean(body.internetEnabled),
          memoryMiB: integer(body.memoryMiB, 512, 32_768),
          runtimeSandboxId,
          sandboxName: requiredString(body.sandboxName, 160),
          sessionId
        };
        await fence.claim({ operation, runtimeSandboxId, sessionId });
        sendJson(response, 200, await fence.run({ operation, sessionId }, (signal) => input.runtime.ensureSession({ ...ensure, signal })));
        return;
      }
      const match = /^\/v1\/sessions\/([^/]+)(\/.*)?$/u.exec(url.pathname);
      const sessionId = match ? decodeURIComponent(match[1]!) : null;
      const suffix = match?.[2] ?? "";
      if (!sessionId || !isWorkspaceOpaqueId(sessionId)) {
        sendJson(response, 404, { error: "workspace_session_lost" });
        return;
      }
      const execute = <T>(operation: unknown, action: (signal: AbortSignal) => Promise<T>) =>
        fence.run({ operation: parseWorkspaceOperation(operation), sessionId }, action);

      if (request.method === "POST" && (suffix === "/skills/prepare" || suffix === "/skills/complete")) {
        stage = "prepare";
        const body = await readJson(request, SKILL_RUNTIME_JSON_MAX_BYTES);
        const identity = { modelRunId: requiredString(body.modelRunId, 128), manifestHash: requiredString(body.manifestHash, 64),
          runtimeSandboxId: requiredString(body.runtimeSandboxId, 256), sessionId };
        validateSkillIdentity(identity);
        if (suffix === "/skills/prepare") {
          const initial = parseSkillInitial(body.initial);
          sendJson(response, 200, await execute(body.operation, signal => input.runtime.prepareSkillRun({ ...identity, initial, signal: skillOperationSignal(signal) })));
        } else {
          await execute(body.operation, signal => input.runtime.completeSkillRunPreparation({ ...identity, signal: skillOperationSignal(signal) }));
          sendJson(response, 200, { ok: true });
        }
        return;
      }

      if (request.method === "POST" && suffix === "/skills/install") {
        stage = "prepare";
        if (header(request, "content-type") !== "application/gzip") throw new Error("field_invalid");
        const operation = parseWorkspaceOperation(JSON.parse(requiredString(header(request, "x-aiqsa-operation"), HEADER_VALUE_MAX_BYTES)));
        const metadata = JSON.parse(requiredString(header(request, "x-aiqsa-skill-run"), HEADER_VALUE_MAX_BYTES)) as Record<string, unknown>;
        if (!isRecord(metadata)) throw new Error("field_invalid");
        const identity = { modelRunId: requiredString(metadata.modelRunId, 128), manifestHash: requiredString(metadata.manifestHash, 64),
          runtimeSandboxId: requiredString(header(request, "x-aiqsa-runtime-sandbox-id"), 256), sessionId };
        validateSkillIdentity(identity);
        const bundle = parseSkillBundleRef(metadata.bundle);
        const byteSize = Number(requiredString(header(request, "x-aiqsa-byte-size"), 32));
        const checksum = requiredString(header(request, "x-aiqsa-checksum"), 64);
        validateSkillArchiveMetadata({ byteSize, checksum });
        if (Number(requiredString(header(request, "content-length"), 32)) !== byteSize) throw new Error("field_invalid");
        sendJson(response, 200, await execute(operation, signal => input.runtime.installSkillBundle({
          ...identity, bundle, byteSize, checksum, archive: incomingBody(request), signal: skillOperationSignal(signal)
        })));
        return;
      }

      if (request.method === "POST" && suffix === "/secrets") {
        stage = "prepare";
        const body = await readJson(request, WORKSPACE_SECRETS_REQUEST_MAX_BYTES);
        const secrets = parseAcceptedWorkspaceSecrets(body.secrets);
        const modelRunId = requiredString(body.modelRunId, 128);
        const runtimeSandboxId = requiredString(body.runtimeSandboxId, 256);
        await execute(body.operation, (signal) => input.runtime.syncPersonalSecrets({
          secrets, modelRunId, runtimeSandboxId, sessionId, signal
        }));
        sendJson(response, 200, { ok: true });
        return;
      }

      if (request.method === "POST" && (suffix === "/operations/claim" || suffix === "/operations/retire")) {
        stage = suffix === "/operations/claim" ? "claim" : "release";
        const body = await readJson(request);
        const claim = { operation: parseWorkspaceOperation(body.operation), runtimeSandboxId: optionalString(body.runtimeSandboxId, 256), sessionId };
        if (suffix === "/operations/claim") await fence.claim(claim);
        else await fence.retire(claim);
        sendJson(response, 200, { ok: true });
        return;
      }

      if (request.method === "POST" && suffix === "/stage") {
        stage = "prepare";
        const runtimeSandboxId = requiredString(header(request, "x-aiqsa-runtime-sandbox-id"), 256);
        const attachmentId = requiredString(header(request, "x-aiqsa-attachment-id"), 128);
        const messageId = requiredString(header(request, "x-aiqsa-message-id"), 128);
        const encodedName = requiredString(header(request, "x-aiqsa-file-name"), 512);
        const originalName = Buffer.from(encodedName, "base64url").toString("utf8");
        const kind = requiredString(header(request, "x-aiqsa-file-kind"), 16);
        if (kind !== "document" && kind !== "file" && kind !== "image" && kind !== "pdf") {
          throw new Error("field_invalid");
        }
        const checksum = requiredString(header(request, "x-aiqsa-checksum"), 64);
        if (!/^[a-f0-9]{64}$/u.test(checksum)) throw new Error("field_invalid");
        const operation = JSON.parse(header(request, "x-aiqsa-workspace-operation") ?? "null") as unknown;
        await execute(operation, (signal) => input.runtime.stageAttachments({
          attachments: [{
            attachmentId,
            body: incomingBody(request),
            byteSize: integer(Number(header(request, "x-aiqsa-byte-size")), 1, 1_073_741_824),
            checksum,
            kind,
            messageId,
            mimeType: requiredString(header(request, "x-aiqsa-mime-type"), 255),
            originalName,
            sandboxPath: workspaceAttachmentPath({ attachmentId, messageId, originalName })
          }],
          inboxIndex: { attachments: [] },
          manifests: [],
          runtimeSandboxId,
          sessionId, signal
        }));
        response.writeHead(204);
        response.end();
        return;
      }

      if (request.method === "POST" && suffix === "/stage/list") {
        stage = "prepare";
        const body = await readJson(request);
        const attachments = decodeWorkspaceInboxIndexAttachments({ version: WORKSPACE_INBOX_INDEX_VERSION, attachments: body.attachments });
        if (!attachments) throw new Error("field_invalid");
        const staged = await execute(body.operation, (signal) => input.runtime.listStagedAttachments({
          attachments,
          runtimeSandboxId: requiredString(body.runtimeSandboxId, 256),
          sessionId, signal
        }));
        sendJson(response, 200, { staged: staged.slice(0, WORKSPACE_INBOX_INDEX_MAX_ENTRIES) });
        return;
      }

      if (request.method === "POST" && suffix === "/stage/finalize") {
        stage = "prepare";
        const body = await readJson(request);
        if (!Array.isArray(body.manifests) || body.manifests.length > 1_000) {
          throw new Error("field_invalid");
        }
        const manifests = body.manifests.map((manifest) => {
          if (!isRecord(manifest)) throw new Error("field_invalid");
          return {
            body: manifest.body,
            messageId: requiredString(manifest.messageId, 128)
          };
        });
        await execute(body.operation, (signal) => input.runtime.stageAttachments({
          attachments: [],
          inboxIndex: body.inboxIndex,
          manifests,
          ...(body.outputDirectory === undefined
            ? {}
            : { outputDirectory: requiredString(body.outputDirectory, 255) }),
          runtimeSandboxId: requiredString(body.runtimeSandboxId, 256),
          sessionId, signal
        }));
        sendJson(response, 200, { ok: true });
        return;
      }

      if (request.method === "POST" && suffix === "/tools/catalog") {
        stage = "discover";
        const body = await readJson(request);
        sendJson(response, 200, await execute(body.operation, (signal) => input.runtime.loadBoundTools({
          runtimeSandboxId: requiredString(body.runtimeSandboxId, 256),
          sessionId, signal
        })));
        return;
      }

      if (request.method === "POST" && ["/agent/start", "/agent/poll", "/agent/interrupt"].includes(suffix)) {
        stage = "dispatch";
        const body = await readJson(request);
        const identity = {
          modelRunId: requiredString(body.modelRunId, 128),
          runtimeExecSessionId: requiredString(body.runtimeExecSessionId, 128),
          runtimeSandboxId: requiredString(body.runtimeSandboxId, 256),
          sessionId
        };
        if (suffix === "/agent/start") {
          if (!input.runtime.startAgent || !isRecord(body.profile) || typeof body.prompt !== "string" ||
            Buffer.byteLength(body.prompt) > AGENT_PROMPT_MAX_BYTES) throw new Error("field_invalid");
          const profile = body.profile as CodexManagedProfile;
          renderCodexManagedProfile(profile);
          await execute(body.operation, (signal) => input.runtime.startAgent!({
            ...identity, signal, profile, prompt: body.prompt as string,
            skillManifestHash: requiredString(body.skillManifestHash, 64),
            runToken: requiredString(body.runToken, 128),
            threadId: body.threadId === undefined ? undefined : requiredString(body.threadId, 36),
            previousExecSessionId: body.previousExecSessionId === undefined ? undefined : requiredString(body.previousExecSessionId, 128),
            timeoutSeconds: body.timeoutSeconds === null ? null : integer(body.timeoutSeconds, 1, 7200)
          }));
          sendJson(response, 200, { started: true });
        } else if (suffix === "/agent/interrupt") {
          if (!input.runtime.interruptAgent) throw new Error("field_invalid");
          sendJson(response, 200, { interrupted: await execute(body.operation, signal => input.runtime.interruptAgent!({ ...identity, signal })) });
        } else {
          if (!input.runtime.pollAgent) throw new Error("field_invalid");
          sendJson(response, 200, await execute(body.operation, (signal) => input.runtime.pollAgent!({
            ...identity, signal, cursor: integer(body.cursor, 0, 64 * 1024 * 1024)
          })));
        }
        return;
      }

      const toolMatch = /^\/tools\/([^/]+)\/call$/u.exec(suffix);
      if (request.method === "POST" && toolMatch) {
        stage = "dispatch";
        const toolName = decodeURIComponent(toolMatch[1]!);
        if (!workspaceToolIsAllowed(toolName)) throw new Error("field_invalid");
        const body = await readJson(request);
        const toolArguments = body.arguments;
        if (!isRecord(toolArguments)) throw new Error("field_invalid");
        sendJson(response, 200, await execute(body.operation, (signal) => {
          const modelRunId = requiredString(body.modelRunId, 128);
          const modelRunToolCallId = requiredString(body.modelRunToolCallId, 128);
          return runWithContext({ run_id: modelRunId, tool_call_id: modelRunToolCallId }, () => input.runtime.callBoundTool({
            arguments: toolArguments,
            modelRunId,
            modelRunToolCallId,
            originalName: toolName,
            runtimeSandboxId: requiredString(body.runtimeSandboxId, 256),
            sessionId, signal
          }));
        }));
        return;
      }

      if (request.method === "POST" && suffix === "/executions/terminate") {
        stage = "quiesce";
        const body = await readJson(request);
        if (!Array.isArray(body.executions) || body.executions.length > 256) {
          throw new Error("field_invalid");
        }
        const executions = body.executions.map((execution) => {
          if (!isRecord(execution)) throw new Error("field_invalid");
          return {
            modelRunId: requiredString(execution.modelRunId, 128),
            runtimeExecSessionId: requiredString(execution.runtimeExecSessionId, 256)
          };
        });
        sendJson(response, 200, {
          results: await execute(body.operation, (signal) => input.runtime.terminateExecutions({
            executions,
            runtimeSandboxId: requiredString(body.runtimeSandboxId, 256),
            sessionId, signal
          }))
        });
        return;
      }

      const abortMatch = /^\/tool-calls\/([^/]+)\/abort$/u.exec(suffix);
      if (request.method === "POST" && abortMatch) {
        stage = "quiesce";
        const body = await readJson(request);
        await execute(body.operation, () => input.runtime.cancelToolCall({
          modelRunId: requiredString(body.modelRunId, 128),
          modelRunToolCallId: requiredString(decodeURIComponent(abortMatch[1]!), 128),
          runtimeSandboxId: requiredString(body.runtimeSandboxId, 256),
          sessionId
        }));
        sendJson(response, 200, { ok: true });
        return;
      }

      if (request.method === "POST" && suffix === "/outputs/list") {
        stage = "export";
        prunePending();
        const body = await readJson(request);
        const operation = parseWorkspaceOperation(body.operation);
        if (body.purpose === "browser_sessions") {
          if (body.capture !== undefined || body.outputDirectory !== undefined) throw new WorkspaceRuntimeError("workspace_runtime_incompatible");
          const collection = await execute(operation, (signal) => input.runtime.collectBrowserSessions({
            modelRunId: requiredString(body.modelRunId, 128), runtimeSandboxId: requiredString(body.runtimeSandboxId, 256), sessionId, signal
          }));
          const batchId = registerBatch(sessionId, operation, collection.files);
          sendJson(response, 200, { batchId, skipped: collection.skipped,
            outputs: collection.files.map(({ body: _body, ...metadata }) => ({ ...metadata, batchId })) });
          return;
        }
        if (body.purpose !== undefined) throw new WorkspaceRuntimeError("workspace_runtime_incompatible");
        const capture = body.capture === undefined ? undefined : parseOutputCaptureRequest(body.capture);
        const outputs = await execute(operation, (signal) => input.runtime.collectOutputs({
          ...(capture ? { capture } : {}),
          modelRunId: requiredString(body.modelRunId, 128),
          outputDirectory: requiredString(body.outputDirectory, 255),
          runtimeSandboxId: requiredString(body.runtimeSandboxId, 256),
          sessionId, signal
        }));
        const batchId = registerBatch(sessionId, operation, outputs);
        sendJson(response, 200, {
          batchId,
          ...(capture ? { captureId: capture.id } : {}),
          outputs: outputs.map(({ body: _body, ...metadata }) => ({ ...metadata, batchId }))
        });
        return;
      }

      if (request.method === "GET" && suffix === "/outputs/stream") {
        stage = "export";
        prunePending();
        const opaqueFileId = url.searchParams.get("opaqueFileId") ?? "";
        const batchId = url.searchParams.get("batchId") ?? "";
        const batch = batches.get(batchId);
        const pending = batch?.sessionId === sessionId ? batch.handles.get(opaqueFileId) : undefined;
        if (!batch || !pending) {
          sendJson(response, 404, { error: "workspace_output_export_failed" });
          return;
        }
        // Single use: the handle is gone before the first byte is written, and
        // the rest of the batch is kept alive by this activity.
        batch.handles.delete(opaqueFileId);
        batch.expiresAt = clock() + PENDING_OUTPUT_INACTIVITY_MS;
        batch.activeStreams += 1;
        try {
          await execute(batch.operation, (signal) => pipeOutput(response, pending, signal));
        } catch (error) {
          // A stale operation is rejected before pipeOutput takes ownership
          // of the body. Release that unopened handle as well.
          await pending.output.body.cancel(error).catch(() => undefined);
          throw error;
        } finally {
          batch.activeStreams -= 1;
          batch.expiresAt = clock() + PENDING_OUTPUT_INACTIVITY_MS;
          if (batch.handles.size === 0 && batch.activeStreams === 0) batches.delete(batchId);
        }
        return;
      }

      if (request.method === "POST" && suffix === "/outputs/capture/release") {
        stage = "release";
        const body = await readJson(request);
        const capture = parseOutputCaptureRequest({ id: body.captureId, create: false });
        if (!input.runtime.releaseOutputCapture) throw new WorkspaceRuntimeError("workspace_runtime_incompatible");
        await execute(body.operation, (signal) => input.runtime.releaseOutputCapture!({
          captureId: capture.id, modelRunId: requiredString(body.modelRunId, 128),
          runtimeSandboxId: requiredString(body.runtimeSandboxId, 256), sessionId, signal
        }));
        sendJson(response, 200, { ok: true });
        return;
      }

      if (request.method === "POST" && suffix === "/outputs/release") {
        stage = "release";
        const body = await readJson(request);
        const batchId = requiredString(body.batchId, 64);
        if (batches.get(batchId)?.sessionId === sessionId) discardBatch(batchId, "released");
        sendJson(response, 200, { ok: true });
        return;
      }

      if (request.method === "POST" && suffix === "/project/archive") {
        stage = "export";
        prunePending();
        const body = await readJson(request);
        const operation = parseWorkspaceOperation(body.operation);
        const output = await execute(operation, (signal) => input.runtime.createProjectArchive({
          runtimeSandboxId: requiredString(body.runtimeSandboxId, 256),
          sessionId, signal
        }));
        const batchId = registerBatch(sessionId, operation, [output]);
        const { body: _body, ...metadata } = output;
        sendJson(response, 200, { ...metadata, batchId });
        return;
      }

      if (request.method === "POST" && suffix === "/project/restore") {
        stage = "restore";
        const operationHeader = requiredString(header(request, "x-aiqsa-operation"), 2_048);
        const operation = parseWorkspaceOperation(JSON.parse(operationHeader));
        const runtimeSandboxId = requiredString(header(request, "x-aiqsa-runtime-sandbox-id"), 256);
        const checksum = requiredString(header(request, "x-aiqsa-checksum"), 128);
        if (!/^[a-f0-9]{64}$/u.test(checksum)) throw new Error("field_invalid");
        const byteSize = integer(Number(requiredString(header(request, "x-aiqsa-byte-size"), 32)), 1, 2 * 1_024 * 1_024 * 1_024);
        if (!input.runtime.restoreProjectArchive) throw new WorkspaceRuntimeError("workspace_runtime_incompatible");
        await execute(operation, (signal) => input.runtime.restoreProjectArchive!({
          archive: incomingBody(request), byteSize, checksum, runtimeSandboxId, sessionId, signal
        }));
        sendJson(response, 200, { ok: true });
        return;
      }

      if (request.method === "POST" && suffix === "/stop") {
        stage = "quiesce";
        const body = await readJson(request);
        await execute(body.operation, (signal) => input.runtime.stopSession({
          runtimeSandboxId: optionalString(body.runtimeSandboxId, 256),
          sessionId, signal
        }));
        sendJson(response, 200, { ok: true });
        return;
      }

      if (request.method === "DELETE" && suffix === "") {
        stage = "cleanup";
        const body = await readJson(request);
        await execute(body.operation, (signal) => input.runtime.removeSession({
          runtimeSandboxId: optionalString(body.runtimeSandboxId, 256),
          sessionId, signal
        }));
        sendJson(response, 200, { ok: true });
        return;
      }

      sendJson(response, 404, { error: "workspace_runtime_unavailable" });
    } catch (error) {
      const failure = workspaceLifecycleFailure(error);
      const httpStatus = errorCode(error) === "workspace_operation_stale" ? 409 : 400;
      if (stage === "health") reportSubsystemFailure({ subsystem: "workspace", stage, scope_id: "runner", ...failure, httpStatus, action: "wait" });
      else logEvent("runtime_lifecycle", { subsystem: "workspace", stage, ...failure, httpStatus, action: "stop" });
      if (!response.headersSent) sendJson(response, errorCode(error) === "workspace_operation_stale" ? 409 : 400, { error: errorCode(error) });
      else response.destroy();
    }
  }));
  server.headersTimeout = 10_000;
  server.keepAliveTimeout = 5_000;
  server.maxHeadersCount = 64;
  server.requestTimeout = REQUEST_TIMEOUT_MS;
  return server;
}
