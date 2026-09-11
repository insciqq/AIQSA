import type { ErrorResponse } from "./http";

/**
 * Control Center "Needs attention" list: the server aggregates every item that
 * needs an administrator decision or action from data it already serves
 * (dashboard, providers, Search, system roles, Knowledge operations, Memory
 * status, MCP servers, email health). Nothing is persisted; every item carries
 * human copy plus one jump target inside the Control Center.
 */
export type AdminAttentionSeverity = "bad" | "neutral" | "warn";

export type AdminAttentionCode =
  | "email_delivery_failing"
  | "email_not_configured"
  | "knowledge_needs_attention"
  | "knowledge_reindexing"
  | "mcp_server_needs_attention"
  | "memory_index_rebuild_required"
  | "memory_processing_blocked"
  | "memory_worker_not_running"
  | "provider_key_check_failed"
  | "provider_catalog_models_available"
  | "provider_key_rejected"
  | "search_source_model_off"
  | "system_role_not_assigned"
  | "system_role_unavailable"
  | "users_pending_approval"
  | "users_without_model_access";

export const adminAttentionSections = [
  "email",
  "groups",
  "mcp",
  "providers",
  "retrieval",
  "roles",
  "search",
  "users"
] as const;

export type AdminAttentionSection = (typeof adminAttentionSections)[number];

/** A jump inside the Control Center: a section plus an optional resource or list filter. */
export type AdminAttentionTarget = {
  filter?: string;
  resource?: string;
  section: AdminAttentionSection;
};

export type AdminAttentionItem = {
  action: string;
  code: AdminAttentionCode;
  /** Number shown in the severity pill; `null` renders as a dash. */
  count: number | null;
  detail: string;
  /** Stable per resource so the list can key rows and later slices can dismiss/track. */
  id: string;
  severity: AdminAttentionSeverity;
  target: AdminAttentionTarget;
  title: string;
};

export const adminAttentionSources = [
  "dashboard",
  "email",
  "knowledge",
  "mcp",
  "memory",
  "providers",
  "search",
  "system_roles"
] as const;

export type AdminAttentionSource = (typeof adminAttentionSources)[number];

export type AdminAttention = {
  checkedAt: string;
  items: AdminAttentionItem[];
  /** Sources that could not be read this time; their items may be missing. */
  unavailable: AdminAttentionSource[];
};

export type AdminAttentionResponse = {
  attention: AdminAttention;
};

export type AdminAttentionErrorResponse = ErrorResponse<
  "admin_attention_failed" | "forbidden" | "unauthorized"
>;

const ATTENTION_CODES = new Set<AdminAttentionCode>([
  "email_delivery_failing",
  "email_not_configured",
  "knowledge_needs_attention",
  "knowledge_reindexing",
  "mcp_server_needs_attention",
  "memory_index_rebuild_required",
  "memory_processing_blocked",
  "memory_worker_not_running",
  "provider_key_check_failed",
  "provider_catalog_models_available",
  "provider_key_rejected",
  "search_source_model_off",
  "system_role_not_assigned",
  "system_role_unavailable",
  "users_pending_approval",
  "users_without_model_access"
]);
const ATTENTION_SECTIONS = new Set<string>(adminAttentionSections);
const ATTENTION_SOURCES = new Set<string>(adminAttentionSources);
const MAX_ITEMS = 200;

/** The source owns freshness even when an item jumps to a different section. */
export function adminAttentionItemSource(item: AdminAttentionItem): AdminAttentionSource {
  if (item.code.startsWith("memory_")) return "memory";
  if (item.code.startsWith("system_role_")) return "system_roles";
  if (item.code.startsWith("provider_")) return "providers";
  if (item.code.startsWith("users_")) return "dashboard";
  if (item.code.startsWith("knowledge_")) return "knowledge";
  if (item.code.startsWith("mcp_")) return "mcp";
  if (item.code.startsWith("search_")) return "search";
  return "email";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function boundedText(value: unknown, maxLength: number): value is string {
  return typeof value === "string" && value.trim().length > 0 && value.length <= maxLength &&
    !/[\u0000-\u001f\u007f]/u.test(value);
}

function optionalBoundedText(value: unknown, maxLength: number): value is string | undefined {
  return value === undefined || boundedText(value, maxLength);
}

function decodeTarget(value: unknown): AdminAttentionTarget | null {
  if (!isRecord(value) || typeof value.section !== "string" ||
    !ATTENTION_SECTIONS.has(value.section) ||
    !optionalBoundedText(value.filter, 64) || !optionalBoundedText(value.resource, 256)) {
    return null;
  }
  return {
    section: value.section as AdminAttentionSection,
    ...(value.filter === undefined ? {} : { filter: value.filter }),
    ...(value.resource === undefined ? {} : { resource: value.resource })
  };
}

function decodeItem(value: unknown): AdminAttentionItem | null {
  if (!isRecord(value) || !boundedText(value.action, 64) ||
    typeof value.code !== "string" || !ATTENTION_CODES.has(value.code as AdminAttentionCode) ||
    !(value.count === null || (Number.isSafeInteger(value.count) && Number(value.count) >= 0)) ||
    !boundedText(value.detail, 400) || !boundedText(value.id, 320) ||
    !(value.severity === "bad" || value.severity === "neutral" || value.severity === "warn") ||
    !boundedText(value.title, 160)) {
    return null;
  }
  const target = decodeTarget(value.target);
  if (!target) return null;
  return {
    action: value.action,
    code: value.code as AdminAttentionCode,
    count: value.count === null ? null : Number(value.count),
    detail: value.detail,
    id: value.id,
    severity: value.severity,
    target,
    title: value.title
  };
}

export function decodeAdminAttentionResponse(value: unknown): AdminAttentionResponse | null {
  if (!isRecord(value) || !isRecord(value.attention)) return null;
  const attention = value.attention;
  if (typeof attention.checkedAt !== "string" || !Number.isFinite(Date.parse(attention.checkedAt)) ||
    !Array.isArray(attention.items) || attention.items.length > MAX_ITEMS ||
    !Array.isArray(attention.unavailable) ||
    !attention.unavailable.every((source) => typeof source === "string" && ATTENTION_SOURCES.has(source))) {
    return null;
  }
  const items = attention.items.map(decodeItem);
  if (items.some((item) => item === null)) return null;
  const ids = new Set(items.map((item) => item!.id));
  if (ids.size !== items.length) return null;
  return {
    attention: {
      checkedAt: attention.checkedAt,
      items: items as AdminAttentionItem[],
      unavailable: [...new Set(attention.unavailable as AdminAttentionSource[])]
    }
  };
}
