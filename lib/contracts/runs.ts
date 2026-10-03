import { decodeChatPdfPreparations, type ChatPdfPreparationWire } from "./chatPdfPreparation";
import { decodeRunFollowupState, type RunFollowupState } from "./runFollowups";
import type { ErrorResponse, SessionErrorCode } from "./http";

export const TOOL_SYNTHESIS_FAILURE = {
  code: "synthesis_tool_call_forbidden",
  message: "The model requested another tool after tool use was disabled, so the answer could not be completed. Completed steps and any partial answer are kept. Regenerate to try again."
} as const;

export function isToolSynthesisFailure(code: string | null | undefined, message?: string | null): boolean {
  return code === TOOL_SYNTHESIS_FAILURE.code || message === TOOL_SYNTHESIS_FAILURE.message ||
    message === "Provider returned a tool call from a no-tool synthesis request.";
}

/** Neutral user-facing text of a run that failed before or instead of an
 * answer for a reason users must not see (Memory, retired contracts); the
 * stable error code keeps the reason. */
export const RUN_PREPARATION_FAILURE_MESSAGE =
  "The answer could not be prepared. Try again." as const;

export const MCP_AUTO_DISCOVERY_UNAVAILABLE_CODE =
  "mcp_auto_discovery_unavailable" as const;
export const MCP_AUTO_DISCOVERY_UNAVAILABLE_MESSAGE =
  "Automatic tool discovery is unavailable." as const;

const mcpAutoDiscoveryFailures = {
  mcp_materialization_failed: {
    code: "mcp_auto_discovery_materialization_failed",
    message: "Automatic tool discovery could not activate the selected MCP tools. Review MCP settings, retry in Auto, or use Load all."
  }
} as const;

const genericMcpAutoDiscoveryFailure = {
  code: MCP_AUTO_DISCOVERY_UNAVAILABLE_CODE,
  message: MCP_AUTO_DISCOVERY_UNAVAILABLE_MESSAGE
} as const;

/** Stored runs may carry codes and copy of the retired System Model tool
 * selector. They are recognized only to render the generic failure. */
const RETIRED_MCP_AUTO_DISCOVERY_CODES: ReadonlySet<string> = new Set([
  "mcp_auto_discovery_request_rejected",
  "mcp_auto_discovery_output_limit",
  "mcp_auto_discovery_model_output_limit",
  "mcp_auto_discovery_timeout",
  "mcp_auto_discovery_output_invalid",
  "mcp_auto_discovery_credential_unavailable",
  "mcp_auto_discovery_model_unavailable"
]);
const RETIRED_MCP_AUTO_DISCOVERY_MESSAGES: ReadonlySet<string> = new Set([
  "The System Model rejected automatic tool selection (Gemini HTTP 400: invalid_request). Ask an administrator to check its routing compatibility, or use Load all to bypass automatic selection.",
  "The System Model rejected automatic tool selection (Gemini HTTP 400: parameter_unknown). Ask an administrator to check its routing compatibility, or use Load all to bypass automatic selection.",
  "The System Model rejected automatic tool selection (Gemini HTTP 400). Ask an administrator to check its routing compatibility, or use Load all to bypass automatic selection.",
  "The System Model could not complete automatic tool selection. Retry in Auto, or use Load all to bypass automatic selection.",
  "Automatic tool discovery reached its output-token limit before completing the JSON selection. Retry in Auto, use Load all, or ask an administrator to review MCP Auto output tokens.",
  "The MCP Auto output-token allowance exceeds the System Model’s declared output limit. Ask an administrator to lower the allowance or select a model with a larger limit.",
  "Automatic tool discovery exceeded its time limit. Retry in Auto or use Load all.",
  "Automatic tool discovery returned an invalid selection. Retry in Auto or use Load all.",
  "Automatic tool discovery could not use the System Model credential. Ask an administrator to check it, or use Load all.",
  "Automatic tool discovery needs an available, verified System Model. Ask an administrator to check Defaults & roles, or use Load all."
]);

/** Only fixed, content-free causes may reach stored failures and the browser. */
export function mcpAutoDiscoveryFailure(reason: string): Readonly<{ code: string; message: string }> {
  return reason === "mcp_materialization_failed" || reason === "mcp_materialization_mcp_not_ready" ||
    reason === "mcp_materialization_mcp_plan_too_large" || reason === "mcp_materialization_mismatch"
    ? mcpAutoDiscoveryFailures.mcp_materialization_failed
    : genericMcpAutoDiscoveryFailure;
}

export function isMcpAutoDiscoveryFailureCode(code: string | null | undefined): boolean {
  return code === MCP_AUTO_DISCOVERY_UNAVAILABLE_CODE || typeof code === "string" && (
    RETIRED_MCP_AUTO_DISCOVERY_CODES.has(code) ||
    Object.values(mcpAutoDiscoveryFailures).some((failure) => failure.code === code));
}

export function mcpAutoDiscoveryFailureForMessage(message: string | null | undefined) {
  if (!message) return null;
  return message === MCP_AUTO_DISCOVERY_UNAVAILABLE_MESSAGE || RETIRED_MCP_AUTO_DISCOVERY_MESSAGES.has(message)
    ? genericMcpAutoDiscoveryFailure
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
  followups?: RunFollowupState;
  answerComplete?: true;
  workspacePreparation?: true;
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
  const followups = value.run.followups === undefined ? undefined : decodeRunFollowupState(value.run.followups);
  if (followups === null) return null;
  if ((value.run.answerComplete !== undefined && value.run.answerComplete !== true) ||
    (value.run.workspacePreparation !== undefined && value.run.workspacePreparation !== true) ||
    (value.run.workspacePreparation === true && (status !== "queued" || value.run.answerComplete === true))) return null;
  return id && status && pdfPreparation !== null
    ? { id, status, ...(pdfPreparation ? { pdfPreparation } : {}), ...(followups ? { followups } : {}),
        ...(value.run.answerComplete === true ? { answerComplete: true } : {}),
        ...(value.run.workspacePreparation === true ? { workspacePreparation: true } : {}) } : null;
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
