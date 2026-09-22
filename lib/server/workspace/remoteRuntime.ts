import type { WorkspaceMcpToolName } from "@/lib/domain/workspace";
import {
  WORKSPACE_INBOX_INDEX_MAX_ENTRIES,
  decodeWorkspaceStagedAttachmentEntry,
  isWorkspaceRuntimeExecSessionId,
  workspaceAttachmentPath
} from "@/lib/domain/workspace";
import type { WorkspaceConfig } from "./config";
import { beginWorkspaceToolStage, observeWorkspaceAbort, workspaceToolFailure } from "./toolObservability";
import { transportFailureFacts } from "../providers/providerObservability";
import { parseWorkspaceOperation } from "./operationFence";
import { parseOutputCaptureRequest } from "./outputManifest";
import { parseSkillBundleRef, parseSkillInitial, skillOperationSignal, validateSkillArchiveMetadata, validateSkillIdentity, WORKSPACE_SKILLS_DIRECTORY } from "./skillBundles";
import { WORKSPACE_BROWSER_SESSION_MAX_BYTES, WORKSPACE_BROWSER_SESSION_MAX_COUNT, isWorkspaceBrowserSessionFilename } from "@/lib/contracts/workspaceSecrets";
import { WORKSPACE_BROWSER_SKIP_CODES, type WorkspaceBrowserSkipCode } from "./secrets/browserSession";
import {
  WorkspaceRuntimeError,
  WORKSPACE_RUNTIME_INVENTORY_PAGE_SIZE,
  WORKSPACE_RUNTIME_INVENTORY_STATES,
  type WorkspaceRuntimeInventoryInput,
  type WorkspaceRuntimeInventoryPage,
  type WorkspaceBoundTool,
  type WorkspaceExecutionTermination,
  type WorkspaceOutputReleaseInput,
  type WorkspaceOutputStream,
  type WorkspaceOperationInput,
  type WorkspaceRuntime,
  type WorkspaceRuntimeHealth,
  type WorkspaceRuntimeSession,
  type WorkspaceToolCatalog,
  type WorkspaceToolResult
} from "./runtime";

const RESPONSE_MAX_BYTES = 2 * 1_024 * 1_024;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function workspaceError(value: unknown): WorkspaceRuntimeError {
  const code = isRecord(value) && typeof value.error === "string" ? value.error : "";
  switch (code) {
    case "workspace_attachment_unavailable":
    case "workspace_secrets_prepare_failed":
    case "workspace_skills_prepare_failed":
    case "workspace_skill_bundle_invalid":
    case "workspace_skill_bundle_limit_exceeded":
    case "workspace_archive_limit_exceeded":
    case "workspace_agent_output_invalid":
    case "workspace_archive_invalid":
    case "workspace_archive_restore_failed":
    case "workspace_execution_cleanup_failed":
    case "workspace_operation_stale":
    case "workspace_output_export_failed":
    case "workspace_output_limit_exceeded":
    case "workspace_runtime_incompatible":
    case "workspace_runtime_unavailable":
    case "workspace_session_create_failed":
    case "workspace_session_lost":
    case "workspace_session_lost_before_dispatch":
    case "workspace_tool_cancelled":
    case "workspace_tool_timeout":
      return new WorkspaceRuntimeError(code);
    default:
      return new WorkspaceRuntimeError("workspace_runtime_unavailable");
  }
}

async function jsonResponse(response: Response): Promise<unknown> {
  const length = Number(response.headers.get("content-length"));
  if (Number.isFinite(length) && length > RESPONSE_MAX_BYTES) {
    throw new WorkspaceRuntimeError("workspace_runtime_incompatible");
  }
  const text = await response.text();
  if (new TextEncoder().encode(text).byteLength > RESPONSE_MAX_BYTES) {
    throw new WorkspaceRuntimeError("workspace_runtime_incompatible");
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new WorkspaceRuntimeError("workspace_runtime_incompatible");
  }
}

/**
 * A genuinely lazy body: the runner handle is opened on the first read, not
 * when the listing returns. With the default high-water mark the stream would
 * pull immediately and open every single-use guest stream at listing time.
 */
function remoteBody(open: () => Promise<Response>): ReadableStream<Uint8Array> {
  let reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
  return new ReadableStream<Uint8Array>({
    async cancel(reason) {
      await reader?.cancel(reason).catch(() => undefined);
    },
    async pull(controller) {
      try {
        if (!reader) {
          const response = await open();
          if (!response.ok || !response.body) {
            throw workspaceError(await jsonResponse(response));
          }
          reader = response.body.getReader();
        }
        const next = await reader.read();
        if (next.done) controller.close();
        else controller.enqueue(next.value);
      } catch (error) {
        controller.error(error);
      }
    }
  }, { highWaterMark: 0 });
}

function outputMetadata(value: unknown): Omit<WorkspaceOutputStream, "body"> | null {
  if (
    !isRecord(value) ||
    typeof value.batchId !== "string" ||
    !/^[a-f0-9]{32}$/u.test(value.batchId) ||
    typeof value.byteSize !== "number" ||
    !Number.isSafeInteger(value.byteSize) ||
    value.byteSize <= 0 ||
    typeof value.checksum !== "string" ||
    !/^[a-f0-9]{64}$/u.test(value.checksum) ||
    typeof value.mimeType !== "string" ||
    value.mimeType.length === 0 ||
    value.mimeType.length > 255 ||
    typeof value.opaqueFileId !== "string" ||
    !/^[a-f0-9]{64}$/u.test(value.opaqueFileId) ||
    typeof value.relativePath !== "string" ||
    value.relativePath.length === 0 ||
    value.relativePath.length > 512
  ) {
    return null;
  }
  return value as Omit<WorkspaceOutputStream, "body">;
}

export class RemoteWorkspaceRuntime implements WorkspaceRuntime {
  private readonly baseUrl: URL;
  private readonly token: string;

  constructor(config: WorkspaceConfig) {
    if (!config.runnerUrl || !config.runnerToken || config.runtimeMode !== "remote") {
      throw new WorkspaceRuntimeError("workspace_runtime_unavailable");
    }
    this.baseUrl = config.runnerUrl;
    this.token = config.runnerToken;
  }

  async claimSessionOperation(input: WorkspaceOperationInput): Promise<void> {
    await this.operationRequest("claim", input);
  }

  async retireSessionOperation(input: WorkspaceOperationInput): Promise<void> {
    await this.operationRequest("retire", input);
  }

  private async operationRequest(action: "claim" | "retire", input: WorkspaceOperationInput): Promise<void> {
    await this.boundedJson(`/v1/sessions/${encodeURIComponent(input.sessionId)}/operations/${action}`, {
      body: JSON.stringify({ operation: parseWorkspaceOperation(input.operation), runtimeSandboxId: input.runtimeSandboxId }),
      method: "POST"
    });
  }

  private async boundedJson(path: string, init: RequestInit): Promise<unknown> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 15_000);
    timer.unref?.();
    try {
      return await this.json(path, {
        ...init,
        signal: init.signal ? AbortSignal.any([init.signal, controller.signal]) : controller.signal
      });
    } catch (error) {
      if (controller.signal.aborted && !init.signal?.aborted) throw new WorkspaceRuntimeError("workspace_execution_cleanup_failed");
      throw error;
    } finally { clearTimeout(timer); }
  }

  private async request(
    path: string,
    init: RequestInit & Readonly<{ duplex?: "half" }> = {},
    observedToolRequest?: ReturnType<typeof beginWorkspaceToolStage>
  ): Promise<Response> {
    try {
      return await fetch(new URL(path, this.baseUrl), {
        ...init,
        cache: "no-store",
        credentials: "omit",
        headers: {
          authorization: `Bearer ${this.token}`,
          ...init.headers
        },
        redirect: "error"
      } as RequestInit);
    } catch (error) {
      if (observedToolRequest) {
        const facts = transportFailureFacts(error, init.signal ?? undefined);
        observedToolRequest({ outcome: facts.category === "aborted" ? "cancelled" : "failed", code: facts.code,
          reason: facts.category === "timeout" ? "deadline" : facts.category === "aborted" ? "cancelled"
            : facts.category === "dns" || facts.category === "tls" || facts.category === "connect" ? "network" : "unknown" });
      }
      if (error instanceof WorkspaceRuntimeError) throw error;
      // A caller-initiated abort is a cancellation, never a runner outage:
      // reporting it as unavailable would falsely fail the session.
      if (init.signal?.aborted) throw new WorkspaceRuntimeError("workspace_tool_cancelled");
      throw new WorkspaceRuntimeError("workspace_runtime_unavailable");
    }
  }

  private async json(path: string, init: RequestInit = {}): Promise<unknown> {
    const response = await this.request(path, {
      ...init,
      headers: { "content-type": "application/json", ...init.headers }
    });
    const value = await jsonResponse(response);
    if (!response.ok) throw workspaceError(value);
    return value;
  }

  async health(signal?: AbortSignal): Promise<WorkspaceRuntimeHealth> {
    try {
      const value = await this.json("/health", { signal });
      if (!isRecord(value) || (value.state !== "ready" && value.state !== "unavailable")) {
        throw new WorkspaceRuntimeError("workspace_runtime_incompatible");
      }
      return value as WorkspaceRuntimeHealth;
    } catch (error) {
      return {
        reasonCode: error instanceof WorkspaceRuntimeError
          ? error.code
          : "workspace_runtime_unavailable",
        state: "unavailable"
      };
    }
  }

  async listSessions(input: WorkspaceRuntimeInventoryInput): Promise<WorkspaceRuntimeInventoryPage> {
    const query = input.cursor ? `?cursor=${encodeURIComponent(input.cursor)}` : "";
    const deadline = AbortSignal.timeout(5_000);
    const value = await this.json(`/v1/inventory${query}`, {
      signal: input.signal ? AbortSignal.any([input.signal, deadline]) : deadline
    });
    if (!isRecord(value) || !Array.isArray(value.entries) ||
      value.entries.length > WORKSPACE_RUNTIME_INVENTORY_PAGE_SIZE ||
      !(value.nextCursor === null || typeof value.nextCursor === "string" && value.nextCursor.length > 0 && value.nextCursor.length <= 2_048)) {
      throw new WorkspaceRuntimeError("workspace_runtime_incompatible");
    }
    const entries = value.entries.map((entry) => {
      if (!isRecord(entry) || typeof entry.runtimeSandboxId !== "string" || !entry.runtimeSandboxId ||
        entry.runtimeSandboxId.length > 256 || typeof entry.sandboxName !== "string" || !entry.sandboxName ||
        entry.sandboxName.length > 160 || !(WORKSPACE_RUNTIME_INVENTORY_STATES as readonly unknown[]).includes(entry.state)) {
        throw new WorkspaceRuntimeError("workspace_runtime_incompatible");
      }
      return {
        runtimeSandboxId: entry.runtimeSandboxId,
        sandboxName: entry.sandboxName,
        state: entry.state as WorkspaceRuntimeInventoryPage["entries"][number]["state"]
      };
    });
    return { entries, nextCursor: value.nextCursor as string | null };
  }

  async ensureSession(input: Parameters<WorkspaceRuntime["ensureSession"]>[0]): Promise<WorkspaceRuntimeSession> {
    const value = await this.json("/v1/sessions/ensure", {
      body: JSON.stringify({
        cpus: input.cpus,
        diskMiB: input.diskMiB,
        imageRef: input.imageRef,
        internetEnabled: input.internetEnabled,
        memoryMiB: input.memoryMiB,
        operation: parseWorkspaceOperation(input.operation), runtimeSandboxId: input.runtimeSandboxId,
        sandboxName: input.sandboxName,
        sessionId: input.sessionId
      }),
      method: "POST",
      signal: input.signal
    });
    if (
      !isRecord(value) ||
      typeof value.runtimeSandboxId !== "string" ||
      typeof value.sandboxName !== "string" ||
      (value.state !== "ready" && value.state !== "running")
    ) {
      throw new WorkspaceRuntimeError("workspace_runtime_incompatible");
    }
    return value as WorkspaceRuntimeSession;
  }

  async listStagedAttachments(input: Parameters<WorkspaceRuntime["listStagedAttachments"]>[0]) {
    const value = await this.json(`/v1/sessions/${encodeURIComponent(input.sessionId)}/stage/list`, {
      body: JSON.stringify({ attachments: input.attachments, operation: parseWorkspaceOperation(input.operation), runtimeSandboxId: input.runtimeSandboxId }),
      method: "POST",
      signal: input.signal
    });
    if (
      !isRecord(value) ||
      !Array.isArray(value.staged) ||
      value.staged.length > WORKSPACE_INBOX_INDEX_MAX_ENTRIES
    ) {
      throw new WorkspaceRuntimeError("workspace_runtime_incompatible");
    }
    return value.staged.map((entry) => {
      const decoded = decodeWorkspaceStagedAttachmentEntry(entry);
      if (!decoded) throw new WorkspaceRuntimeError("workspace_runtime_incompatible");
      return decoded;
    });
  }

  async stageAttachments(input: Parameters<WorkspaceRuntime["stageAttachments"]>[0]): Promise<void> {
    for (const attachment of input.attachments) {
      const response = await this.request(`/v1/sessions/${encodeURIComponent(input.sessionId)}/stage`, {
        body: attachment.body,
        duplex: "half",
        headers: {
          "content-type": "application/octet-stream",
          "x-aiqsa-attachment-id": attachment.attachmentId,
          "x-aiqsa-byte-size": String(attachment.byteSize),
          "x-aiqsa-checksum": attachment.checksum,
          "x-aiqsa-file-kind": attachment.kind,
          "x-aiqsa-file-name": Buffer.from(attachment.originalName, "utf8").toString("base64url"),
          "x-aiqsa-message-id": attachment.messageId,
          "x-aiqsa-mime-type": attachment.mimeType,
          "x-aiqsa-workspace-operation": JSON.stringify(parseWorkspaceOperation(input.operation)),
          "x-aiqsa-runtime-sandbox-id": input.runtimeSandboxId
        },
        method: "POST",
        signal: input.signal
      });
      if (!response.ok) throw workspaceError(await jsonResponse(response));
    }
    await this.json(`/v1/sessions/${encodeURIComponent(input.sessionId)}/stage/finalize`, {
      body: JSON.stringify({
        inboxIndex: input.inboxIndex,
        manifests: input.manifests,
        ...(input.outputDirectory ? { outputDirectory: input.outputDirectory } : {}),
        operation: parseWorkspaceOperation(input.operation), runtimeSandboxId: input.runtimeSandboxId
      }),
      method: "POST",
      signal: input.signal
    });
  }

  async syncPersonalSecrets(input: Parameters<WorkspaceRuntime["syncPersonalSecrets"]>[0]): Promise<void> {
    await this.json(`/v1/sessions/${encodeURIComponent(input.sessionId)}/secrets`, {
      body: JSON.stringify({ secrets: input.secrets, modelRunId: input.modelRunId,
        operation: parseWorkspaceOperation(input.operation), runtimeSandboxId: input.runtimeSandboxId }),
      method: "POST", signal: input.signal
    });
  }

  async loadBoundTools(input: Parameters<WorkspaceRuntime["loadBoundTools"]>[0]): Promise<WorkspaceToolCatalog> {
    const value = await this.json(`/v1/sessions/${encodeURIComponent(input.sessionId)}/tools/catalog`, {
      body: JSON.stringify({ operation: parseWorkspaceOperation(input.operation), runtimeSandboxId: input.runtimeSandboxId }),
      method: "POST",
      signal: input.signal
    });
    if (
      !isRecord(value) ||
      typeof value.hash !== "string" ||
      typeof value.mcpVersion !== "string" ||
      typeof value.runtimeVersion !== "string" ||
      !Array.isArray(value.tools)
    ) {
      throw new WorkspaceRuntimeError("workspace_runtime_incompatible");
    }
    return value as WorkspaceToolCatalog & { tools: readonly WorkspaceBoundTool[] };
  }

  async startAgent(input: Parameters<NonNullable<WorkspaceRuntime["startAgent"]>>[0]): Promise<void> {
    const { signal, sessionId, ...body } = input;
    await this.json(`/v1/sessions/${encodeURIComponent(sessionId)}/agent/start`, {
      body: JSON.stringify({ ...body, operation: parseWorkspaceOperation(input.operation) }),
      method: "POST", signal
    });
  }

  async interruptAgent(input: Parameters<NonNullable<WorkspaceRuntime["interruptAgent"]>>[0]): Promise<boolean> {
    const { signal, sessionId, ...body } = input;
    const value = await this.json(`/v1/sessions/${encodeURIComponent(sessionId)}/agent/interrupt`, {
      body: JSON.stringify({ ...body, operation: parseWorkspaceOperation(input.operation) }), method: "POST", signal
    });
    if (!isRecord(value) || typeof value.interrupted !== "boolean") throw new WorkspaceRuntimeError("workspace_runtime_incompatible");
    return value.interrupted;
  }

  async prepareSkillRun(input: Parameters<WorkspaceRuntime["prepareSkillRun"]>[0]) {
    input = { ...input, signal: skillOperationSignal(input.signal) };
    validateSkillIdentity(input);
    const value = await this.json(`/v1/sessions/${encodeURIComponent(input.sessionId)}/skills/prepare`, {
      body: JSON.stringify({ modelRunId: input.modelRunId, manifestHash: input.manifestHash,
        runtimeSandboxId: input.runtimeSandboxId, operation: parseWorkspaceOperation(input.operation), initial: parseSkillInitial(input.initial) }),
      method: "POST", signal: input.signal
    });
    if (!isRecord(value) || (value.state !== "preparing" && value.state !== "ready")) throw new WorkspaceRuntimeError("workspace_runtime_incompatible");
    return { state: value.state as "preparing" | "ready" };
  }

  async installSkillBundle(input: Parameters<WorkspaceRuntime["installSkillBundle"]>[0]) {
    input = { ...input, signal: skillOperationSignal(input.signal) };
    validateSkillIdentity(input); validateSkillArchiveMetadata(input);
    const bundle = parseSkillBundleRef(input.bundle);
    const response = await this.request(`/v1/sessions/${encodeURIComponent(input.sessionId)}/skills/install`, {
      body: input.archive, duplex: "half", method: "POST", signal: input.signal,
      headers: {
        "content-length": String(input.byteSize), "content-type": "application/gzip",
        "x-aiqsa-byte-size": String(input.byteSize), "x-aiqsa-checksum": input.checksum,
        "x-aiqsa-operation": JSON.stringify(parseWorkspaceOperation(input.operation)),
        "x-aiqsa-runtime-sandbox-id": input.runtimeSandboxId,
        "x-aiqsa-skill-run": JSON.stringify({ modelRunId: input.modelRunId, manifestHash: input.manifestHash, bundle })
      }
    });
    const value = await jsonResponse(response);
    if (!response.ok) throw workspaceError(value);
    const workspacePath = `${WORKSPACE_SKILLS_DIRECTORY}/${bundle.alias}`;
    if (!isRecord(value) || value.workspacePath !== workspacePath) throw new WorkspaceRuntimeError("workspace_runtime_incompatible");
    return { workspacePath };
  }

  async completeSkillRunPreparation(input: Parameters<WorkspaceRuntime["completeSkillRunPreparation"]>[0]): Promise<void> {
    input = { ...input, signal: skillOperationSignal(input.signal) };
    validateSkillIdentity(input);
    await this.json(`/v1/sessions/${encodeURIComponent(input.sessionId)}/skills/complete`, {
      body: JSON.stringify({ modelRunId: input.modelRunId, manifestHash: input.manifestHash,
        runtimeSandboxId: input.runtimeSandboxId, operation: parseWorkspaceOperation(input.operation) }),
      method: "POST", signal: input.signal
    });
  }

  async pollAgent(input: Parameters<NonNullable<WorkspaceRuntime["pollAgent"]>>[0]) {
    const { signal, sessionId, ...body } = input;
    const value = await this.json(`/v1/sessions/${encodeURIComponent(sessionId)}/agent/poll`, {
      body: JSON.stringify({ ...body, operation: parseWorkspaceOperation(input.operation) }),
      method: "POST", signal
    });
    if (!isRecord(value) || value.cursor !== input.cursor ||
      typeof value.nextCursor !== "number" || !Number.isSafeInteger(value.nextCursor) ||
      value.nextCursor < input.cursor || value.nextCursor > input.cursor + 65536 ||
      typeof value.stdoutBase64 !== "string" || value.stdoutBase64.length > 87384 ||
      !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(value.stdoutBase64) ||
      Buffer.from(value.stdoutBase64, "base64").byteLength !== value.nextCursor - input.cursor ||
      typeof value.done !== "boolean" || (value.exitCode !== null &&
        (typeof value.exitCode !== "number" || !Number.isSafeInteger(value.exitCode)))) {
      throw new WorkspaceRuntimeError("workspace_agent_output_invalid");
    }
    return { cursor: input.cursor, nextCursor: value.nextCursor, stdoutBase64: value.stdoutBase64,
      done: value.done, exitCode: value.exitCode as number | null };
  }

  async callBoundTool(input: Parameters<WorkspaceRuntime["callBoundTool"]>[0]): Promise<WorkspaceToolResult> {
    const path = `/v1/sessions/${encodeURIComponent(input.sessionId)}/tools/${encodeURIComponent(input.originalName)}/call`;
    const request = {
      body: JSON.stringify({
        arguments: input.arguments,
        modelRunId: input.modelRunId,
        modelRunToolCallId: input.modelRunToolCallId,
        operation: parseWorkspaceOperation(input.operation), runtimeSandboxId: input.runtimeSandboxId
      }),
      headers: { "content-type": "application/json" },
      method: "POST",
      signal: input.signal
    };
    const finish = beginWorkspaceToolStage("request");
    const observeAbort = observeWorkspaceAbort();
    const onAbort = () => observeAbort({ stage: "delivery", abort_source: "parent_signal", deadline_kind: "request" });
    if (input.signal?.aborted) observeAbort({ stage: "before_start", abort_source: "unknown", deadline_kind: "request" });
    else input.signal?.addEventListener("abort", onAbort, { once: true });
    let httpStatus: number | undefined;
    try {
      const response = await this.request(path, request, finish);
      httpStatus = response.status;
      const value = await jsonResponse(response);
      if (!response.ok) throw workspaceError(value);
      if (
        !isRecord(value) ||
        !Array.isArray(value.content) ||
        (value.status !== "complete" && value.status !== "error") ||
        (value.execSessionId !== undefined && !isWorkspaceRuntimeExecSessionId(value.execSessionId))
      ) {
        throw new WorkspaceRuntimeError("workspace_runtime_incompatible");
      }
      finish({ outcome: value.status === "error" ? "failed" : "completed", httpStatus });
      return value as WorkspaceToolResult;
    } catch (error) {
      const facts = workspaceToolFailure(error);
      const transport = transportFailureFacts(error, input.signal);
      const reason = transport.category === "aborted" ? "cancelled" : transport.category === "timeout" ? "deadline"
        : transport.category === "dns" || transport.category === "tls" || transport.category === "connect" ? "network" : facts.reason;
      finish({ outcome: reason === "cancelled" ? "cancelled" : "failed", httpStatus,
        code: transport.category !== "unknown" ? transport.code : facts.code, reason });
      throw error;
    } finally {
      input.signal?.removeEventListener("abort", onAbort);
    }
  }

  async terminateExecutions(input: Parameters<WorkspaceRuntime["terminateExecutions"]>[0]) {
    const value = await this.boundedJson(
      `/v1/sessions/${encodeURIComponent(input.sessionId)}/executions/terminate`,
      {
        body: JSON.stringify({
          executions: input.executions,
          operation: parseWorkspaceOperation(input.operation), runtimeSandboxId: input.runtimeSandboxId
        }),
        method: "POST",
        signal: input.signal
      }
    );
    if (!isRecord(value) || !Array.isArray(value.results) || value.results.length > 256) {
      throw new WorkspaceRuntimeError("workspace_runtime_incompatible");
    }
    return value.results.map((result): WorkspaceExecutionTermination => {
      const outcome = isRecord(result) && result.outcome === "closed"
        ? "closed"
        : isRecord(result) && result.outcome === "unknown"
          ? "unknown"
          : null;
      const runtimeExecSessionId = isRecord(result) ? result.runtimeExecSessionId : null;
      if (!outcome || !isWorkspaceRuntimeExecSessionId(runtimeExecSessionId)) {
        throw new WorkspaceRuntimeError("workspace_runtime_incompatible");
      }
      return { outcome, runtimeExecSessionId };
    });
  }

  async cancelToolCall(input: Parameters<WorkspaceRuntime["cancelToolCall"]>[0]): Promise<void> {
    await this.boundedJson(
      `/v1/sessions/${encodeURIComponent(input.sessionId)}/tool-calls/${encodeURIComponent(input.modelRunToolCallId)}/abort`,
      {
        body: JSON.stringify({
          modelRunId: input.modelRunId,
          operation: parseWorkspaceOperation(input.operation), runtimeSandboxId: input.runtimeSandboxId
        }),
        method: "POST"
      }
    );
  }

  private output(
    sessionId: string,
    metadata: Omit<WorkspaceOutputStream, "body">,
    signal?: AbortSignal
  ): WorkspaceOutputStream {
    return {
      ...metadata,
      body: remoteBody(() => this.request(
        `/v1/sessions/${encodeURIComponent(sessionId)}/outputs/stream` +
          `?opaqueFileId=${encodeURIComponent(metadata.opaqueFileId)}` +
          `&batchId=${encodeURIComponent(metadata.batchId ?? "")}`,
        { signal }
      ))
    };
  }

  async collectOutputs(input: Parameters<WorkspaceRuntime["collectOutputs"]>[0]): Promise<readonly WorkspaceOutputStream[]> {
    const value = await this.json(`/v1/sessions/${encodeURIComponent(input.sessionId)}/outputs/list`, {
      body: JSON.stringify({
        ...(input.capture ? { capture: parseOutputCaptureRequest(input.capture) } : {}),
        modelRunId: input.modelRunId,
        outputDirectory: input.outputDirectory,
        operation: parseWorkspaceOperation(input.operation), runtimeSandboxId: input.runtimeSandboxId
      }),
      method: "POST",
      signal: input.signal
    });
    if (!isRecord(value) || !Array.isArray(value.outputs) || (input.capture && value.captureId !== input.capture.id)) {
      throw new WorkspaceRuntimeError("workspace_runtime_incompatible");
    }
    const metadata = value.outputs.map(outputMetadata);
    if (metadata.some((entry) => entry === null)) {
      throw new WorkspaceRuntimeError("workspace_runtime_incompatible");
    }
    return (metadata as Omit<WorkspaceOutputStream, "body">[])
      .map((entry) => this.output(input.sessionId, entry, input.signal));
  }

  async releaseOutputs(input: WorkspaceOutputReleaseInput): Promise<void> {
    await this.json(`/v1/sessions/${encodeURIComponent(input.sessionId)}/outputs/release`, {
      body: JSON.stringify({ batchId: input.batchId, operation: parseWorkspaceOperation(input.operation), runtimeSandboxId: input.runtimeSandboxId }),
      method: "POST",
      signal: input.signal
    });
  }

  async collectBrowserSessions(input: Parameters<WorkspaceRuntime["collectBrowserSessions"]>[0]): ReturnType<WorkspaceRuntime["collectBrowserSessions"]> {
    const value = await this.json(`/v1/sessions/${encodeURIComponent(input.sessionId)}/outputs/list`, {
      body: JSON.stringify({ purpose: "browser_sessions", modelRunId: input.modelRunId,
        operation: parseWorkspaceOperation(input.operation), runtimeSandboxId: input.runtimeSandboxId }),
      method: "POST", signal: input.signal
    });
    if (!isRecord(value) || !Array.isArray(value.outputs) || value.outputs.length > WORKSPACE_BROWSER_SESSION_MAX_COUNT ||
      !Array.isArray(value.skipped) || value.skipped.length > 130 ||
      !value.skipped.every((code) => WORKSPACE_BROWSER_SKIP_CODES.includes(code))) throw new WorkspaceRuntimeError("workspace_runtime_incompatible");
    const metadata = value.outputs.map(outputMetadata);
    if (metadata.some((entry) => !entry || !isWorkspaceBrowserSessionFilename(entry.relativePath) ||
      entry.byteSize > WORKSPACE_BROWSER_SESSION_MAX_BYTES)) throw new WorkspaceRuntimeError("workspace_runtime_incompatible");
    return { files: (metadata as Omit<WorkspaceOutputStream, "body">[]).map((entry) => this.output(input.sessionId, entry, input.signal)),
      skipped: value.skipped as WorkspaceBrowserSkipCode[] };
  }

  async releaseOutputCapture(input: Parameters<NonNullable<WorkspaceRuntime["releaseOutputCapture"]>>[0]): Promise<void> {
    await this.json(`/v1/sessions/${encodeURIComponent(input.sessionId)}/outputs/capture/release`, {
      body: JSON.stringify({ captureId: input.captureId, modelRunId: input.modelRunId,
        operation: parseWorkspaceOperation(input.operation), runtimeSandboxId: input.runtimeSandboxId }),
      method: "POST", signal: input.signal
    });
  }

  async createProjectArchive(input: Parameters<WorkspaceRuntime["createProjectArchive"]>[0]): Promise<WorkspaceOutputStream> {
    const value = await this.json(`/v1/sessions/${encodeURIComponent(input.sessionId)}/project/archive`, {
      body: JSON.stringify({ operation: parseWorkspaceOperation(input.operation), runtimeSandboxId: input.runtimeSandboxId }),
      method: "POST",
      signal: input.signal
    });
    const metadata = outputMetadata(value);
    if (!metadata) throw new WorkspaceRuntimeError("workspace_runtime_incompatible");
    return this.output(input.sessionId, metadata, input.signal);
  }

  async restoreProjectArchive(input: Parameters<NonNullable<WorkspaceRuntime["restoreProjectArchive"]>>[0]): Promise<void> {
    const operation = parseWorkspaceOperation(input.operation);
    const response = await this.request(`/v1/sessions/${encodeURIComponent(input.sessionId)}/project/restore`, {
      body: input.archive,
      duplex: "half",
      headers: {
        "content-length": String(input.byteSize),
        "content-type": "application/gzip",
        "x-aiqsa-byte-size": String(input.byteSize),
        "x-aiqsa-checksum": input.checksum,
        "x-aiqsa-operation": JSON.stringify(operation),
        "x-aiqsa-runtime-sandbox-id": input.runtimeSandboxId
      },
      method: "POST",
      signal: input.signal
    });
    const value = await jsonResponse(response);
    if (!response.ok) throw workspaceError(value);
  }

  async stopSession(input: Parameters<WorkspaceRuntime["stopSession"]>[0]): Promise<void> {
    await this.boundedJson(`/v1/sessions/${encodeURIComponent(input.sessionId)}/stop`, {
      body: JSON.stringify({ operation: parseWorkspaceOperation(input.operation), runtimeSandboxId: input.runtimeSandboxId }),
      method: "POST",
      signal: input.signal
    });
  }

  async removeSession(input: Parameters<WorkspaceRuntime["removeSession"]>[0]): Promise<void> {
    await this.boundedJson(`/v1/sessions/${encodeURIComponent(input.sessionId)}`, {
      body: JSON.stringify({ operation: parseWorkspaceOperation(input.operation), runtimeSandboxId: input.runtimeSandboxId }),
      method: "DELETE",
      signal: input.signal
    });
  }
}

export function remoteWorkspaceAttachmentPath(input: Readonly<{
  attachmentId: string;
  messageId: string;
  originalName: string;
}>): string {
  return workspaceAttachmentPath(input);
}
