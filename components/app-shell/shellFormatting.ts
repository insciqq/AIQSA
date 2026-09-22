import { isRecord } from "@/components/app-shell/shellValues";
import type { CatalogModel } from "@/components/app-shell/types";

export function formatTokenCount(value: number): string {
  if (value >= 1_000_000) {
    return `${Number((value / 1_000_000).toFixed(value >= 10_000_000 ? 0 : 2))}m`;
  }

  if (value >= 1_000) {
    const thousands = Number((value / 1_000).toFixed(value >= 100_000 ? 0 : 1));

    return thousands >= 1_000 ? "1m" : `${thousands}k`;
  }

  return String(value);
}

/** Normalizes persisted legacy placeholders without changing real chat titles. */
export function chatTitleForDisplay(title: string | null | undefined): string {
  const normalized = title?.trim() ?? "";
  return !normalized || /^(?:new chat|untitled qsa)$/iu.test(normalized)
    ? "New chat"
    : normalized;
}

/**
 * Deterministic export base name: a unicode-aware slug of the chat title plus
 * the ISO date, e.g. `release-checklist-032-2026-08-13`. The extension is
 * appended by the caller per export format.
 */
export function exportFileBaseName(title: string, date: Date = new Date()): string {
  const slug = title
    .normalize("NFKC")
    .toLocaleLowerCase()
    .replace(/[^\p{Letter}\p{Number}]+/gu, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64)
    .replace(/-+$/g, "");
  return `${slug || "chat"}-${date.toISOString().slice(0, 10)}`;
}

export function errorMessage(error: unknown): string {
  return humanizeErrorCode(error instanceof Error ? error.message : "Request failed");
}

export function humanizeErrorCode(code: string): string {
  const raw = code.trim();
  if (!raw) {
    return "Request failed";
  }

  if (!/^[a-z][a-z0-9_:-]*$/i.test(raw)) {
    return raw;
  }

  if (raw === "artifact_version_conflict") {
    return "A newer version exists. Open the current version and choose Edit with AI again.";
  }
  if (raw === "artifact_edit_unavailable") {
    return "This artifact is no longer available for editing. Remove the artifact edit to send your message, or choose an available artifact in Artifacts.";
  }
  if (raw === "artifact_edit_invalid") {
    return "The artifact edit could not be started. Remove the artifact edit, reopen the artifact, and choose Edit with AI again.";
  }

  if (raw === "active_run_in_progress") {
    return "Another response is still running. Stop it or wait for it to finish before sending. (active_run_in_progress)";
  }

  const httpFailure = /^(.*)_failed_(\d{3})$/.exec(raw);
  if (httpFailure) {
    const action = actionLabel(httpFailure[1]);

    return `${action} failed with HTTP ${httpFailure[2]} (${raw})`;
  }

  const labels: Record<string, string> = {
    instruction_selection_conflict: "Instructions changed before send. Retry to use the current preset",
    instruction_presets_unavailable: "Instructions are unavailable right now. Try again",
    active_leaf_changed: "The active branch changed before send. Review the selected branch and retry",
    attachment_not_found: "Attachment not found",
    branch_checkout_failed: "Opening this version failed",
    catalog_malformed: "Catalog response was malformed",
    chat_detail_malformed: "Chat detail response was malformed",
    edit_malformed: "Message edit response was malformed",
    mcp_background_not_supported: "Turn off background mode to use MCP with this model",
    mcp_background_streaming_not_supported:
      "Turn off streaming or background mode to use MCP with this model",
    mcp_auto_discovery_unavailable:
      "Automatic tool discovery is unavailable. Retry in Auto or use Load all",
    mcp_auto_discovery_request_rejected:
      "The System Model rejected automatic tool selection. Ask an administrator to check its routing compatibility, or use Load all to bypass automatic selection",
    mcp_not_ready:
      "An enabled MCP server or tool is no longer ready. Review MCP settings and try again",
    mcp_tool_access_denied:
      "You no longer have access to a required MCP tool. Review the selected tools or ask an administrator for access",
    mcp_plan_too_large:
      "The enabled MCP tools exceed the per-run limit. Disable some servers and try again",
    mcp_selection_invalid: "Choose Auto, Load all, or Off for MCP tools and try again",
    mcp_tool_calling_not_supported: "Choose a model with tool calling to use MCP",
    knowledge_answer_contract_failed:
      "The Knowledge answer could not be safely accepted. Try again or choose another model",
    knowledge_answer_failed:
      "The model could not complete the Knowledge answer. Try again",
    knowledge_citation_contract_failed:
      "The Knowledge answer cited evidence that was not supplied. Try again or choose another model",
    knowledge_retrieval_failed:
      "The selected documents could not be retrieved. Try again",
    no_retrieval_candidates:
      "No matching passages were found in the ready documents. Rephrase the question or change the selection",
    provider_not_available: "Provider is not available",
    provider_unavailable: "Provider is unavailable. Try again",
    openrouter_required_parameters_unavailable:
      "OpenRouter could not route the answer request with its required parameters. Ask an administrator to review the selected model's routing and tool support before retrying",
    openrouter_routing_unavailable:
      "OpenRouter could not route the answer request. Ask an administrator to review the selected model's routing settings before retrying",
    project_default_model_unavailable:
      "The Project default model is unavailable. Review Project resources and choose an available default",
    project_setup_required:
      "Choose an available Project default model before starting a shared chat",
    run_malformed: "Run response was malformed",
    search_provider_not_available: "Search provider is not available",
    settings_malformed: "Settings response was malformed",
    skill_not_available:
      "A selected Skill is no longer available. Review Skills and try again",
    skills_invalid: "Choose distinct Skills and try again",
    skills_count_exceeded: "Pin up to 32 Skills, including Assistant Skills, and try again",
    skills_budget_exceeded: "Pinned Skills exceed the model context budget. Unpin Skills or choose a model with a larger context window",
    sources_processing:
      "The selected documents are still processing. Try again when they are ready",
    structured_output_not_supported:
      "The selected System Model does not have verified structured output",
    unsupported_attachment_type: "Attachment is not supported by this model",
    unsupported_search_strategy: "Search is not supported for this model",
    agent_selection_invalid: "Refresh the Agent selection and try again",
    agent_workspace_required: "Turn on Workspace to use Agent",
    agent_personal_chat_required: "Agent is available in personal chats without an Assistant",
    agent_knowledge_unsupported: "Turn Knowledge off to use Agent",
    agent_model_unsupported: "Choose an Agent-compatible model",
    agent_unavailable: "Agent is unavailable. Ask an administrator to check the Workspace runner and model gateway",
    agent_internet_required: "Agent requires Workspace Internet access enabled by the administrator",
    agent_context_too_large: "This conversation is too large to start Agent. Continue in a new chat",
    agent_execution_interrupted: "Agent was interrupted. Start a new turn to continue with the available Workspace files",
    upload_malformed: "Upload response was malformed",
    workspace_archive_in_progress: "A Workspace archive is already being prepared. Try again shortly",
    workspace_archive_limit_exceeded: "This Workspace is too large to archive. Remove files and try again",
    workspace_attachment_unavailable: "A Workspace attachment is unavailable. Re-upload it and try again",
    workspace_secrets_prepare_failed: "Workspace could not prepare your saved secrets. Check Secrets and try again",
    workspace_busy: "Another Workspace operation is still running. Stop it or wait, then try again",
    workspace_disabled: "Workspace is disabled by the administrator. Turn it off to continue in normal chat",
    workspace_intent_invalid: "Workspace settings were not accepted. Refresh the chat and try again",
    workspace_lifecycle_action_failed: "The Workspace action could not be completed. Try again",
    workspace_malformed: "Workspace response was malformed",
    workspace_model_tools_required: "Choose a model with tool support to use Workspace",
    workspace_not_started: "Workspace has not started yet",
    workspace_output_export_failed: "Generated files could not be saved. Check the Workspace output and try again",
    workspace_output_limit_exceeded: "Workspace generated files exceed the output limit. Remove files and try again",
    workspace_reset_conflict: "Stop the active response before resetting Workspace",
    workspace_runtime_incompatible: "Workspace runtime is incompatible with this installation. Ask an administrator to check it",
    workspace_runtime_unavailable: "Workspace runtime is unavailable. Turn Workspace off or try again later",
    workspace_session_create_failed: "Workspace could not be created. Try again",
    workspace_session_lost: "The previous Workspace was lost. A clean environment will be created from original attachments",
    workspace_tool_cancelled: "The Workspace command was stopped",
    workspace_tool_timeout: "The Workspace command exceeded its time limit and was stopped"
  };

  return `${labels[raw] ?? raw.replace(/_/g, " ")} (${raw})`;
}

function actionLabel(action: string): string {
  const labels: Record<string, string> = {
    branch_chat: "Branch creation",
    branch_checkout: "Open version",
    chat_create: "Chat creation",
    chat_delete: "Chat deletion",
    chat_detail: "Chat detail load",
    chat_update: "Chat update",
    default_knowledge: "Default Knowledge",
    edit: "Message edit",
    folder_create: "Folder creation",
    folder_delete: "Folder deletion",
    folder_move: "Folder move",
    folder_rename: "Folder rename",
    message_delete: "Message deletion",
    prompt_create: "Prompt creation",
    prompt_default: "Default prompt update",
    prompt_delete: "Prompt deletion",
    prompt_duplicate: "Prompt duplication",
    prompt_update: "Prompt update",
    regenerate: "Regeneration",
    send: "Send",
    settings_update: "Settings update",
    share: "Share",
    workspace: "Workspace load"
  };

  return labels[action] ?? action.replace(/_/g, " ");
}

export type ResponseErrorMessageDetails = {
  code?: string;
  message: string;
  preserveForComposer: boolean;
};

export async function responseErrorMessageDetails(
  response: Response,
  fallback: string
): Promise<ResponseErrorMessageDetails> {
  const text = await response.text().catch(() => "");
  if (!text) {
    return {
      message: humanizeErrorCode(fallback),
      preserveForComposer: false
    };
  }

  try {
    const body = JSON.parse(text) as unknown;
    if (isRecord(body) && typeof body.error === "string") {
      const boundedCount = (value: unknown): value is number => typeof value === "number" &&
        Number.isSafeInteger(value) && value >= 0 && value <= 1_000_000_000;
      if (body.error === "skills_count_exceeded" && boundedCount(body.actual) && boundedCount(body.limit)) {
        return { code: body.error, preserveForComposer: true,
          message: `${body.actual} Skills are pinned; the limit is ${body.limit}, including Assistant Skills. Unpin Skills and try again.` };
      }
      if (body.error === "skills_budget_exceeded" &&
        [body.pinnedTokens, body.catalogTokens, body.budgetTokens].every(boundedCount)) {
        return { code: body.error, preserveForComposer: true,
          message: `Skills use approximately ${formatTokenCount(Number(body.pinnedTokens) + Number(body.catalogTokens))} tokens; the model input budget is ${formatTokenCount(Number(body.budgetTokens))}. Unpin Skills or choose a model with a larger context window.` };
      }
      const attachmentLimitErrors = new Set([
        "attachment_count_limit_exceeded",
        "attachment_encoded_size_limit_exceeded",
        "attachment_materialization_limit_exceeded",
        "attachment_object_size_mismatch"
      ]);
      if (
        attachmentLimitErrors.has(body.error) &&
        typeof body.message === "string" &&
        body.message.length > 0 &&
        body.message.length <= 240 &&
        !/[\u0000-\u001f\u007f]/u.test(body.message)
      ) {
        return {
          code: body.error,
          message: body.message,
          preserveForComposer: true
        };
      }

      return {
        code: body.error,
        message: humanizeErrorCode(body.error),
        preserveForComposer: false
      };
    }
  } catch {
    return {
      message: text.slice(0, 240),
      preserveForComposer: false
    };
  }

  return {
    message: humanizeErrorCode(fallback),
    preserveForComposer: false
  };
}

export async function responseErrorMessage(
  response: Response,
  fallback: string
): Promise<string> {
  return (await responseErrorMessageDetails(response, fallback)).message;
}

const modelCapabilityDefinitions = [
  {
    alias: "reasoning",
    label: "Reasoning",
    supported: (model: CatalogModel) => model.capabilities.reasoning
  },
  {
    alias: "vision",
    label: "Images",
    supported: (model: CatalogModel) => model.capabilities.imageInput
  },
  {
    alias: "pdf",
    label: "PDF and documents",
    supported: (model: CatalogModel) => model.capabilities.documentInputMode !== "none"
  },
  {
    alias: "search",
    label: "Web search",
    supported: (model: CatalogModel) =>
      model.capabilities.nativeWebSearch || model.capabilities.openRouterPerplexitySearch
  },
  {
    alias: "stream",
    label: "Streaming",
    supported: (model: CatalogModel) => model.capabilities.streaming
  }
] as const;

export function modelCapabilityLabels(model: CatalogModel): string[] {
  const labels = modelCapabilityDefinitions
    .filter((definition) => definition.supported(model))
    .map((definition) => definition.label);

  return labels.length > 0 ? labels : ["Text conversations"];
}

export function modelCapabilityLabel(model: CatalogModel): string {
  const aliases = modelCapabilityDefinitions
    .filter((definition) => definition.supported(model))
    .map((definition) => definition.alias);

  return aliases.length > 0 ? aliases.join(" / ") : "text";
}

export function modelCapabilityDescription(model: CatalogModel): string {
  return modelCapabilityLabels(model).join(" · ");
}
