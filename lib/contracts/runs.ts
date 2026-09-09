import { decodeChatPdfPreparations, type ChatPdfPreparationWire } from "./chatPdfPreparation";
import type { ErrorResponse, SessionErrorCode } from "./http";

export const TOOL_SYNTHESIS_FAILURE = {
  code: "synthesis_tool_call_forbidden",
  message: "The model requested another tool after tool use was disabled, so the answer could not be completed. Completed steps and any partial answer are kept. Regenerate to try again."
} as const;

export function isToolSynthesisFailure(code: string | null | undefined, message?: string | null): boolean {
  return code === TOOL_SYNTHESIS_FAILURE.code || message === TOOL_SYNTHESIS_FAILURE.message ||
    message === "Provider returned a tool call from a no-tool synthesis request.";
}

export const MCP_AUTO_DISCOVERY_UNAVAILABLE_CODE =
  "mcp_auto_discovery_unavailable" as const;
export const MCP_AUTO_DISCOVERY_UNAVAILABLE_MESSAGE =
  "Automatic tool discovery is unavailable." as const;

const mcpAutoDiscoveryFailures = {
  mcp_router_output_limit: {
    code: "mcp_auto_discovery_output_limit",
    message: "Automatic tool discovery reached its output-token limit before completing the JSON selection. Retry in Auto, use Load all, or ask an administrator to review MCP Auto output tokens."
  },
  mcp_router_model_output_limit: {
    code: "mcp_auto_discovery_model_output_limit",
    message: "The MCP Auto output-token allowance exceeds the System Model’s declared output limit. Ask an administrator to lower the allowance or select a model with a larger limit."
  },
  mcp_router_timeout: {
    code: "mcp_auto_discovery_timeout",
    message: "Automatic tool discovery exceeded its time limit. Retry in Auto or use Load all."
  },
  mcp_router_output_invalid: {
    code: "mcp_auto_discovery_output_invalid",
    message: "Automatic tool discovery returned an invalid selection. Retry in Auto or use Load all."
  },
  mcp_router_credential_unavailable: {
    code: "mcp_auto_discovery_credential_unavailable",
    message: "Automatic tool discovery could not use the System Model credential. Ask an administrator to check it, or use Load all."
  },
  mcp_router_system_model_unavailable: {
    code: "mcp_auto_discovery_model_unavailable",
    message: "Automatic tool discovery needs an available, verified System Model. Ask an administrator to check Defaults & roles, or use Load all."
  },
  mcp_materialization_failed: {
    code: "mcp_auto_discovery_materialization_failed",
    message: "Automatic tool discovery could not activate the selected MCP tools. Review MCP settings, retry in Auto, or use Load all."
  }
} as const;

const genericMcpAutoDiscoveryFailure = {
  code: MCP_AUTO_DISCOVERY_UNAVAILABLE_CODE,
  message: MCP_AUTO_DISCOVERY_UNAVAILABLE_MESSAGE
} as const;

/** Only fixed, content-free causes may reach stored failures and the browser. */
export function mcpAutoDiscoveryFailure(reason: string): Readonly<{ code: string; message: string }> {
  const key = reason === "mcp_router_system_model_absent" || reason === "mcp_router_structured_output_unverified"
    ? "mcp_router_system_model_unavailable"
    : reason === "mcp_materialization_mcp_not_ready" || reason === "mcp_materialization_mcp_plan_too_large" ||
        reason === "mcp_materialization_mismatch" ? "mcp_materialization_failed" : reason;
  return Object.hasOwn(mcpAutoDiscoveryFailures, key)
    ? mcpAutoDiscoveryFailures[key as keyof typeof mcpAutoDiscoveryFailures]
    : genericMcpAutoDiscoveryFailure;
}

export function isMcpAutoDiscoveryFailureCode(code: string | null | undefined): boolean {
  return code === MCP_AUTO_DISCOVERY_UNAVAILABLE_CODE ||
    Object.values(mcpAutoDiscoveryFailures).some((failure) => failure.code === code);
}

export function mcpAutoDiscoveryFailureForMessage(message: string | null | undefined) {
  return message === MCP_AUTO_DISCOVERY_UNAVAILABLE_MESSAGE ? genericMcpAutoDiscoveryFailure
    : Object.values(mcpAutoDiscoveryFailures).find((failure) => failure.message === message) ?? null;
}

export type RunEventView = {
  data: unknown;
  type: string;
};

export type ModelRunStatus =
  | "cancelled"
  | "complete"
  | "error"
  | "in_progress"
  | "queued"
  | "streaming";

export const RUN_OUTCOME_RESPONSE_VERSION = 1 as const;

/**
 * The complete browser-visible projection for an owner-authorized run read.
 * Answer content and outputs are reconciled through the chat projection.
 */
export type RunOutcome = Readonly<{
  pdfPreparation?: readonly ChatPdfPreparationWire[];
  id: string;
  status: ModelRunStatus;
}>;

export type RunOutcomeResponse = Readonly<{
  run: RunOutcome;
  version: typeof RUN_OUTCOME_RESPONSE_VERSION;
}>;

export type CancelModelRunProjection = Readonly<{
  id: string;
  status: ModelRunStatus;
}>;

export type CancelModelRunSuccessResponse = Readonly<{
  run: CancelModelRunProjection & {
    status: "cancelled";
  };
}>;

export type CancelModelRunNotCancelableResponse = Readonly<{
  error: "model_run_not_cancelable";
  run: CancelModelRunProjection;
}>;

export type DecodedCancelModelRunResponse =
  | {
      kind: "cancelled";
      run: CancelModelRunProjection & {
        status: "cancelled";
      };
    }
  | {
      kind: "not_cancelled";
      run: CancelModelRunProjection;
    };

export type ModelRunServerErrorCode =
  | SessionErrorCode
  | "model_run_not_cancelable"
  | "model_run_not_found";

export type ModelRunErrorResponse = ErrorResponse<ModelRunServerErrorCode>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function modelRunStatus(value: unknown): ModelRunStatus | null {
  return value === "cancelled" ||
    value === "complete" ||
    value === "error" ||
    value === "in_progress" ||
    value === "queued" ||
    value === "streaming"
    ? value
    : null;
}

export function decodeCancelModelRunResponse(
  value: unknown
): DecodedCancelModelRunResponse | null {
  if (!isRecord(value) || !isRecord(value.run)) {
    return null;
  }

  const id = nonEmptyString(value.run.id);
  const status = modelRunStatus(value.run.status);
  if (!id || !status) {
    return null;
  }

  if (!("error" in value)) {
    return status === "cancelled"
      ? {
          kind: "cancelled",
          run: {
            id,
            status
          }
        }
      : null;
  }

  if (value.error !== "model_run_not_cancelable") {
    return null;
  }

  return {
    kind: "not_cancelled",
    run: {
      id,
      status
    }
  };
}

export function decodeRunOutcomeResponse(value: unknown): RunOutcome | null {
  if (
    !isRecord(value) ||
    value.version !== RUN_OUTCOME_RESPONSE_VERSION ||
    !isRecord(value.run)
  ) {
    return null;
  }

  const id = nonEmptyString(value.run.id);
  const status = modelRunStatus(value.run.status);
  const pdfPreparation = value.run.pdfPreparation === undefined ? undefined : decodeChatPdfPreparations(value.run.pdfPreparation);
  return id && status && pdfPreparation !== null
    ? { id, status, ...(pdfPreparation ? { pdfPreparation } : {}) } : null;
}

export type PreparingRunAdmissionResponse = Readonly<{
  assistantMessageId: string;
  run: RunOutcome;
  userMessageId: string;
  version: 1;
}>;

export function decodePreparingRunAdmission(value: unknown): PreparingRunAdmissionResponse | null {
  if (!isRecord(value) || value.version !== 1) return null;
  const run = decodeRunOutcomeResponse(value);
  const assistantMessageId = nonEmptyString(value.assistantMessageId);
  const userMessageId = nonEmptyString(value.userMessageId);
  return run && assistantMessageId && userMessageId ? { assistantMessageId, run, userMessageId, version: 1 } : null;
}
