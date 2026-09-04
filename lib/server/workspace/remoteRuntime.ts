import type { WorkspaceMcpToolName } from "@/lib/domain/workspace";
import { isWorkspaceRuntimeExecSessionId, workspaceAttachmentPath } from "@/lib/domain/workspace";
import type { WorkspaceConfig } from "./config";
import {
  WorkspaceRuntimeError,
  type WorkspaceBoundTool,
  type WorkspaceExecutionTermination,
  type WorkspaceOutputStream,
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
    case "workspace_archive_limit_exceeded":
    case "workspace_execution_cleanup_failed":
    case "workspace_output_export_failed":
    case "workspace_output_limit_exceeded":
    case "workspace_runtime_incompatible":
    case "workspace_runtime_unavailable":
    case "workspace_session_create_failed":
    case "workspace_session_lost":
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
  });
}

function outputMetadata(value: unknown): Omit<WorkspaceOutputStream, "body"> | null {
  if (
    !isRecord(value) ||
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

  private async request(
    path: string,
    init: RequestInit & Readonly<{ duplex?: "half" }> = {}
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

  async ensureSession(input: Parameters<WorkspaceRuntime["ensureSession"]>[0]): Promise<WorkspaceRuntimeSession> {
    const value = await this.json("/v1/sessions/ensure", {
      body: JSON.stringify({
        cpus: input.cpus,
        diskMiB: input.diskMiB,
        imageRef: input.imageRef,
        internetEnabled: input.internetEnabled,
        memoryMiB: input.memoryMiB,
        runtimeSandboxId: input.runtimeSandboxId,
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
        runtimeSandboxId: input.runtimeSandboxId
      }),
      method: "POST",
      signal: input.signal
    });
  }

  async loadBoundTools(input: Parameters<WorkspaceRuntime["loadBoundTools"]>[0]): Promise<WorkspaceToolCatalog> {
    const value = await this.json(`/v1/sessions/${encodeURIComponent(input.sessionId)}/tools/catalog`, {
      body: JSON.stringify({ runtimeSandboxId: input.runtimeSandboxId }),
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

  async callBoundTool(input: Parameters<WorkspaceRuntime["callBoundTool"]>[0]): Promise<WorkspaceToolResult> {
    const value = await this.json(
      `/v1/sessions/${encodeURIComponent(input.sessionId)}/tools/${encodeURIComponent(input.originalName)}/call`,
      {
        body: JSON.stringify({
          arguments: input.arguments,
          modelRunId: input.modelRunId,
          modelRunToolCallId: input.modelRunToolCallId,
          runtimeSandboxId: input.runtimeSandboxId
        }),
        method: "POST",
        signal: input.signal
      }
    );
    if (
      !isRecord(value) ||
      !Array.isArray(value.content) ||
      (value.status !== "complete" && value.status !== "error") ||
      (value.execSessionId !== undefined && !isWorkspaceRuntimeExecSessionId(value.execSessionId))
    ) {
      throw new WorkspaceRuntimeError("workspace_runtime_incompatible");
    }
    return value as WorkspaceToolResult;
  }

  async terminateExecutions(input: Parameters<WorkspaceRuntime["terminateExecutions"]>[0]) {
    const value = await this.json(
      `/v1/sessions/${encodeURIComponent(input.sessionId)}/executions/terminate`,
      {
        body: JSON.stringify({
          executions: input.executions,
          runtimeSandboxId: input.runtimeSandboxId
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
    await this.json(
      `/v1/sessions/${encodeURIComponent(input.sessionId)}/tool-calls/${encodeURIComponent(input.modelRunToolCallId)}/abort`,
      {
        body: JSON.stringify({
          modelRunId: input.modelRunId,
          runtimeSandboxId: input.runtimeSandboxId
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
        `/v1/sessions/${encodeURIComponent(sessionId)}/outputs/stream?opaqueFileId=${encodeURIComponent(metadata.opaqueFileId)}`,
        { signal }
      ))
    };
  }

  async collectOutputs(input: Parameters<WorkspaceRuntime["collectOutputs"]>[0]): Promise<readonly WorkspaceOutputStream[]> {
    const value = await this.json(`/v1/sessions/${encodeURIComponent(input.sessionId)}/outputs/list`, {
      body: JSON.stringify({
        modelRunId: input.modelRunId,
        outputDirectory: input.outputDirectory,
        runtimeSandboxId: input.runtimeSandboxId
      }),
      method: "POST",
      signal: input.signal
    });
    if (!isRecord(value) || !Array.isArray(value.outputs)) {
      throw new WorkspaceRuntimeError("workspace_runtime_incompatible");
    }
    const metadata = value.outputs.map(outputMetadata);
    if (metadata.some((entry) => entry === null)) {
      throw new WorkspaceRuntimeError("workspace_runtime_incompatible");
    }
    return (metadata as Omit<WorkspaceOutputStream, "body">[])
      .map((entry) => this.output(input.sessionId, entry, input.signal));
  }

  async createProjectArchive(input: Parameters<WorkspaceRuntime["createProjectArchive"]>[0]): Promise<WorkspaceOutputStream> {
    const value = await this.json(`/v1/sessions/${encodeURIComponent(input.sessionId)}/project/archive`, {
      body: JSON.stringify({ runtimeSandboxId: input.runtimeSandboxId }),
      method: "POST",
      signal: input.signal
    });
    const metadata = outputMetadata(value);
    if (!metadata) throw new WorkspaceRuntimeError("workspace_runtime_incompatible");
    return this.output(input.sessionId, metadata, input.signal);
  }

  async stopSession(input: Parameters<WorkspaceRuntime["stopSession"]>[0]): Promise<void> {
    await this.json(`/v1/sessions/${encodeURIComponent(input.sessionId)}/stop`, {
      body: JSON.stringify({ runtimeSandboxId: input.runtimeSandboxId }),
      method: "POST",
      signal: input.signal
    });
  }

  async removeSession(input: Parameters<WorkspaceRuntime["removeSession"]>[0]): Promise<void> {
    await this.json(`/v1/sessions/${encodeURIComponent(input.sessionId)}`, {
      body: JSON.stringify({ runtimeSandboxId: input.runtimeSandboxId }),
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
