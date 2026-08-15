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

export function safeDownloadName(value: string): string {
  const normalized = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");

  return normalized || "aiqsa-chat";
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

  if (raw === "active_run_in_progress") {
    return "Another response is still running. Stop it or wait for it to finish before sending. (active_run_in_progress)";
  }

  const httpFailure = /^(.*)_failed_(\d{3})$/.exec(raw);
  if (httpFailure) {
    const action = actionLabel(httpFailure[1]);

    return `${action} failed with HTTP ${httpFailure[2]} (${raw})`;
  }

  const labels: Record<string, string> = {
    active_leaf_changed: "The active branch changed before send. Review the selected branch and retry",
    attachment_not_found: "Attachment not found",
    branch_checkout_failed: "Opening this version failed",
    catalog_malformed: "Catalog response was malformed",
    chat_detail_malformed: "Chat detail response was malformed",
    edit_malformed: "Message edit response was malformed",
    provider_not_available: "Provider is not available",
    run_malformed: "Run response was malformed",
    search_provider_not_available: "Search provider is not available",
    settings_malformed: "Settings response was malformed",
    unsupported_attachment_type: "Attachment is not supported by this model",
    unsupported_search_strategy: "Search is not supported for this model",
    upload_malformed: "Upload response was malformed",
    workspace_malformed: "Workspace response was malformed"
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
    edit: "Message edit",
    folder_create: "Folder creation",
    folder_delete: "Folder deletion",
    folder_move: "Folder move",
    folder_rename: "Folder rename",
    message_delete: "Message deletion",
    project_settings: "Project settings",
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

export function modelDifferentiatingCapabilityLabels(
  model: CatalogModel,
  providerModels: readonly CatalogModel[]
): string[] {
  if (providerModels.length < 2) {
    return [];
  }

  const supportedLabels = modelCapabilityDefinitions
    .filter((definition) => definition.supported(model))
    .map((definition) => definition.label);

  return supportedLabels.filter((label) =>
    providerModels.some((candidate) => !modelCapabilityLabels(candidate).includes(label))
  );
}

export function searchStrategyDescription(strategyId: string): string {
  if (strategyId === "search-disabled") {
    return "No Search";
  }

  if (strategyId === "openai-native-web-search") {
    return "OpenAI Search";
  }

  if (strategyId === "perplexity-tool-search") {
    return "Perplexity Search";
  }

  if (strategyId === "gemini-google-search") {
    return "Google Search";
  }

  return "Search";
}
