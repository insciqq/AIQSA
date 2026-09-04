import { timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { once } from "node:events";
import { Readable } from "node:stream";
import {
  isWorkspaceOpaqueId,
  workspaceAttachmentPath,
  workspaceToolIsAllowed
} from "@/lib/domain/workspace";
import {
  WorkspaceRuntimeError,
  type WorkspaceOutputStream,
  type WorkspaceRuntime
} from "./runtime";

const JSON_BODY_MAX_BYTES = 2 * 1_024 * 1_024;
const HEADER_VALUE_MAX_BYTES = 2_048;
const PENDING_OUTPUT_TTL_MS = 5 * 60_000;
const REQUEST_TIMEOUT_MS = 3_700_000;

type PendingOutput = Readonly<{
  expiresAt: number;
  output: WorkspaceOutputStream;
}>;

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

async function readJson(request: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let byteLength = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    byteLength += buffer.byteLength;
    if (byteLength > JSON_BODY_MAX_BYTES) throw new Error("body_too_large");
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
  return Readable.toWeb(request) as unknown as ReadableStream<Uint8Array>;
}

async function pipeOutput(response: ServerResponse, pending: PendingOutput): Promise<void> {
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
  try {
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
    reader.releaseLock();
  }
}

export function createWorkspaceRunnerServer(input: Readonly<{
  /** Clock for pending-output expiry; tests inject a controllable clock. */
  now?: () => number;
  runtime: WorkspaceRuntime;
  token: string;
}>): Server {
  if (input.token.length < 32) throw new Error("workspace_runner_token_invalid");
  const clock = input.now ?? Date.now;
  const pendingOutputs = new Map<string, PendingOutput>();
  const key = (sessionId: string, opaqueFileId: string) => `${sessionId}:${opaqueFileId}`;
  const prunePending = () => {
    const now = clock();
    for (const [id, pending] of pendingOutputs) {
      if (pending.expiresAt <= now) {
        void pending.output.body.cancel("expired").catch(() => undefined);
        pendingOutputs.delete(id);
      }
    }
  };

  const server = createServer(async (request, response) => {
    response.setHeader("cache-control", "no-store");
    if (!authorized(request, input.token)) {
      sendJson(response, 401, { error: "workspace_runtime_unavailable" });
      return;
    }
    const url = new URL(request.url ?? "/", "http://workspace-runner.invalid");
    try {
      if (request.method === "GET" && url.pathname === "/health") {
        sendJson(response, 200, await input.runtime.health());
        return;
      }
      if (request.method === "POST" && url.pathname === "/v1/sessions/ensure") {
        const body = await readJson(request);
        const sessionId = requiredString(body.sessionId, 128);
        if (!isWorkspaceOpaqueId(sessionId)) throw new Error("field_invalid");
        sendJson(response, 200, await input.runtime.ensureSession({
          cpus: integer(body.cpus, 1, 8),
          diskMiB: integer(body.diskMiB, 1_024, 131_072),
          imageRef: requiredString(body.imageRef),
          internetEnabled: boolean(body.internetEnabled),
          memoryMiB: integer(body.memoryMiB, 512, 32_768),
          runtimeSandboxId: optionalString(body.runtimeSandboxId, 256),
          sandboxName: requiredString(body.sandboxName, 160),
          sessionId
        }));
        return;
      }
      const match = /^\/v1\/sessions\/([^/]+)(\/.*)?$/u.exec(url.pathname);
      const sessionId = match ? decodeURIComponent(match[1]!) : null;
      const suffix = match?.[2] ?? "";
      if (!sessionId || !isWorkspaceOpaqueId(sessionId)) {
        sendJson(response, 404, { error: "workspace_session_lost" });
        return;
      }

      if (request.method === "POST" && suffix === "/stage") {
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
        await input.runtime.stageAttachments({
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
          sessionId
        });
        response.writeHead(204);
        response.end();
        return;
      }

      if (request.method === "POST" && suffix === "/stage/finalize") {
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
        await input.runtime.stageAttachments({
          attachments: [],
          inboxIndex: body.inboxIndex,
          manifests,
          ...(body.outputDirectory === undefined
            ? {}
            : { outputDirectory: requiredString(body.outputDirectory, 255) }),
          runtimeSandboxId: requiredString(body.runtimeSandboxId, 256),
          sessionId
        });
        sendJson(response, 200, { ok: true });
        return;
      }

      if (request.method === "POST" && suffix === "/tools/catalog") {
        const body = await readJson(request);
        sendJson(response, 200, await input.runtime.loadBoundTools({
          runtimeSandboxId: requiredString(body.runtimeSandboxId, 256),
          sessionId
        }));
        return;
      }

      const toolMatch = /^\/tools\/([^/]+)\/call$/u.exec(suffix);
      if (request.method === "POST" && toolMatch) {
        const toolName = decodeURIComponent(toolMatch[1]!);
        if (!workspaceToolIsAllowed(toolName)) throw new Error("field_invalid");
        const body = await readJson(request);
        if (!isRecord(body.arguments)) throw new Error("field_invalid");
        sendJson(response, 200, await input.runtime.callBoundTool({
          arguments: body.arguments,
          modelRunId: requiredString(body.modelRunId, 128),
          modelRunToolCallId: requiredString(body.modelRunToolCallId, 128),
          originalName: toolName,
          runtimeSandboxId: requiredString(body.runtimeSandboxId, 256),
          sessionId
        }));
        return;
      }

      if (request.method === "POST" && suffix === "/executions/terminate") {
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
          results: await input.runtime.terminateExecutions({
            executions,
            runtimeSandboxId: requiredString(body.runtimeSandboxId, 256),
            sessionId
          })
        });
        return;
      }

      const abortMatch = /^\/tool-calls\/([^/]+)\/abort$/u.exec(suffix);
      if (request.method === "POST" && abortMatch) {
        const body = await readJson(request);
        await input.runtime.cancelToolCall({
          modelRunId: requiredString(body.modelRunId, 128),
          modelRunToolCallId: requiredString(decodeURIComponent(abortMatch[1]!), 128),
          runtimeSandboxId: requiredString(body.runtimeSandboxId, 256),
          sessionId
        });
        sendJson(response, 200, { ok: true });
        return;
      }

      if (request.method === "POST" && suffix === "/outputs/list") {
        prunePending();
        const body = await readJson(request);
        const outputs = await input.runtime.collectOutputs({
          modelRunId: requiredString(body.modelRunId, 128),
          outputDirectory: requiredString(body.outputDirectory, 255),
          runtimeSandboxId: requiredString(body.runtimeSandboxId, 256),
          sessionId
        });
        for (const output of outputs) {
          pendingOutputs.set(key(sessionId, output.opaqueFileId), {
            expiresAt: clock() + PENDING_OUTPUT_TTL_MS,
            output
          });
        }
        sendJson(response, 200, {
          outputs: outputs.map(({ body: _body, ...metadata }) => metadata)
        });
        return;
      }

      if (request.method === "GET" && suffix === "/outputs/stream") {
        prunePending();
        const opaqueFileId = url.searchParams.get("opaqueFileId") ?? "";
        const outputKey = key(sessionId, opaqueFileId);
        const pending = pendingOutputs.get(outputKey);
        if (!pending) {
          sendJson(response, 404, { error: "workspace_output_export_failed" });
          return;
        }
        pendingOutputs.delete(outputKey);
        await pipeOutput(response, pending);
        return;
      }

      if (request.method === "POST" && suffix === "/project/archive") {
        prunePending();
        const body = await readJson(request);
        const output = await input.runtime.createProjectArchive({
          runtimeSandboxId: requiredString(body.runtimeSandboxId, 256),
          sessionId
        });
        pendingOutputs.set(key(sessionId, output.opaqueFileId), {
          expiresAt: clock() + PENDING_OUTPUT_TTL_MS,
          output
        });
        const { body: _body, ...metadata } = output;
        sendJson(response, 200, metadata);
        return;
      }

      if (request.method === "POST" && suffix === "/stop") {
        const body = await readJson(request);
        await input.runtime.stopSession({
          runtimeSandboxId: optionalString(body.runtimeSandboxId, 256),
          sessionId
        });
        sendJson(response, 200, { ok: true });
        return;
      }

      if (request.method === "DELETE" && suffix === "") {
        const body = await readJson(request);
        await input.runtime.removeSession({
          runtimeSandboxId: optionalString(body.runtimeSandboxId, 256),
          sessionId
        });
        sendJson(response, 200, { ok: true });
        return;
      }

      sendJson(response, 404, { error: "workspace_runtime_unavailable" });
    } catch (error) {
      if (!response.headersSent) sendJson(response, 400, { error: errorCode(error) });
      else response.destroy();
    }
  });
  server.headersTimeout = 10_000;
  server.keepAliveTimeout = 5_000;
  server.maxHeadersCount = 64;
  server.requestTimeout = REQUEST_TIMEOUT_MS;
  return server;
}
