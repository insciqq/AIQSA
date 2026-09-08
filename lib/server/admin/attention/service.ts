import type { AdminDashboard } from "../../../contracts/admin";
import type {
  AdminAttention,
  AdminAttentionItem,
  AdminAttentionSource
} from "../../../contracts/adminAttention";
import type { AdminKnowledgeSettings } from "../../../contracts/adminKnowledge";
import type { AdminMemoryStatus } from "../../../contracts/adminMemory";
import type { AdminProviderConnection } from "../../../contracts/adminProviders";
import type { AdminSearchCatalog } from "../../../contracts/adminSearch";
import type { AdminSystemModelPolicyCatalog } from "../../../contracts/adminSystemModelPolicy";
import type { AdminEmailState } from "../../../contracts/email";
import { adminMcpAttention, type AdminMcpServer } from "../../../contracts/mcp";

export type AdminAttentionDashboardInput = Pick<AdminDashboard, "users">;

/**
 * Narrow read-only loaders over data the Control Center already serves. Each
 * loader may fail independently; the aggregator reports the failed source
 * instead of failing the whole list.
 */
export type AdminAttentionSources = Readonly<{
  dashboard(actingAdminUserId: string): Promise<AdminAttentionDashboardInput>;
  email(): Promise<AdminEmailState | null>;
  knowledge(): Promise<AdminKnowledgeSettings>;
  mcp(actingAdminUserId: string): Promise<readonly AdminMcpServer[]>;
  memory(): Promise<AdminMemoryStatus>;
  providers(): Promise<readonly AdminProviderConnection[]>;
  search(actingAdminUserId: string): Promise<AdminSearchCatalog>;
  systemRoles(): Promise<AdminSystemModelPolicyCatalog>;
}>;

export type AdminAttentionInputs = Readonly<{
  actingAdminUserId: string;
  dashboard: AdminAttentionDashboardInput | null;
  email: AdminEmailState | null;
  knowledge: AdminKnowledgeSettings | null;
  mcp: readonly AdminMcpServer[] | null;
  memory: AdminMemoryStatus | null;
  providers: readonly AdminProviderConnection[] | null;
  search: AdminSearchCatalog | null;
  systemRoles: AdminSystemModelPolicyCatalog | null;
}>;

export type AdminAttentionService = Readonly<{
  list(actingAdminUserId: string): Promise<AdminAttention>;
}>;

function listNames(names: readonly string[], shown = 2): string {
  const visible = names.slice(0, shown);
  const rest = names.length - visible.length;
  if (rest <= 0) return visible.join(", ");
  return `${visible.join(", ")} and ${rest} more`;
}

function plural(count: number, singular: string, pluralForm = `${singular}s`): string {
  return `${count} ${count === 1 ? singular : pluralForm}`;
}

function userLabel(user: AdminDashboard["users"][number]): string {
  return user.email ?? user.displayName;
}

function dashboardItems(
  dashboard: AdminAttentionDashboardInput,
  actingAdminUserId: string
): AdminAttentionItem[] {
  const items: AdminAttentionItem[] = [];
  const pending = dashboard.users.filter((user) => user.status === "pending");
  if (pending.length > 0) {
    items.push({
      action: "Review users",
      code: "users_pending_approval",
      count: pending.length,
      detail: listNames(pending.map(userLabel)),
      id: "users_pending_approval",
      severity: "warn",
      target: { filter: "pending", section: "users" },
      title: "Users are waiting for approval"
    });
  }
  const withoutAccess = dashboard.users.filter((user) =>
    user.id !== actingAdminUserId &&
    user.status === "active" &&
    user.effectiveEntitlements.models.length === 0 &&
    user.effectiveEntitlements.providers.length === 0
  );
  if (withoutAccess.length > 0) {
    items.push({
      action: "Review users",
      code: "users_without_model_access",
      count: withoutAccess.length,
      detail: `${listNames(withoutAccess.map((user) => user.displayName))} · not in any group with model grants`,
      id: "users_without_model_access",
      severity: "warn",
      target: { filter: "no-model-access", section: "users" },
      title: "Active users have no model access"
    });
  }
  return items;
}

function providerItems(connections: readonly AdminProviderConnection[]): AdminAttentionItem[] {
  const items: AdminAttentionItem[] = [];
  for (const connection of connections) {
    if (!connection.enabled) continue;
    const referenced = new Set<string>([
      ...(connection.defaultCredentialId ? [connection.defaultCredentialId] : []),
      ...connection.assignments.filter((assignment) => assignment.group.archivedAt === null)
        .map((assignment) => assignment.credentialId),
      ...connection.userAssignments.filter((assignment) => assignment.user.status === "active")
        .map((assignment) => assignment.credentialId)
    ]);
    const rejected: string[] = [];
    const failed: string[] = [];
    for (const credential of connection.credentials) {
      if (!referenced.has(credential.id) || !credential.enabled) continue;
      const activeVersion = credential.activeVersion;
      if (!activeVersion || activeVersion.revokedAt) continue;
      const checks = connection.activeChecks.filter((check) =>
        check.credentialId === credential.id &&
        check.credentialVersionId === activeVersion.id &&
        check.connectionVersion === connection.activeVersion &&
        connection.models.some((model) => model.id === check.providerModelId &&
          model.activeConfig !== null && model.activeVersion > 0 && model.activeVersion === check.modelVersion)
      );
      if (checks.length === 0) continue;
      if (checks.every((check) => check.status === "unavailable")) {
        rejected.push(credential.label);
      } else if (checks.some((check) => check.refreshFailedAt !== null)) {
        failed.push(credential.label);
      }
    }
    if (rejected.length > 0) {
      items.push({
        action: "Open provider",
        code: "provider_key_rejected",
        count: rejected.length,
        detail: `${connection.displayName} · ${rejected.length === 1 ? "key" : "keys"} ${listNames(rejected)} — check the key`,
        id: `provider_key_rejected:${connection.id}`,
        severity: "bad",
        target: { resource: connection.id, section: "providers" },
        title: "Provider key rejected"
      });
    }
    if (failed.length > 0) {
      items.push({
        action: "Open provider",
        code: "provider_key_check_failed",
        count: failed.length,
        detail: `${connection.displayName} · the last check with ${failed.length === 1 ? "key" : "keys"} ${listNames(failed)} did not complete — run it again`,
        id: `provider_key_check_failed:${connection.id}`,
        severity: "warn",
        target: { resource: connection.id, section: "providers" },
        title: "Provider check did not complete"
      });
    }
  }
  return items;
}

function searchItems(catalog: AdminSearchCatalog): AdminAttentionItem[] {
  return catalog.integrations
    .filter((integration) =>
      !integration.archivedAt && integration.enabled && integration.readiness === "source_unavailable")
    .map((integration) => ({
      action: "Open Search",
      code: "search_source_model_off" as const,
      count: 1,
      detail: integration.providerModel
        ? `Its model ${integration.providerModel.displayName} on ${integration.providerModel.connectionDisplayName} is not available — turn the model on, or archive the source`
        : "Its provider connection is not available — enable the provider, or archive the source",
      id: `search_source_model_off:${integration.id}`,
      severity: "bad" as const,
      target: { resource: integration.id, section: "search" as const },
      title: `${integration.displayName} has no working source`
    }));
}

type RoleAssignment = Readonly<{
  available: boolean;
  connectionDisplayName: string;
  displayName: string;
}> | null;

function roleItem(
  role: string,
  label: string,
  assignment: RoleAssignment,
  missingDetail: string,
  missingSeverity: "neutral" | "warn"
): AdminAttentionItem | null {
  if (assignment === null) {
    return {
      action: "Open roles",
      code: "system_role_not_assigned",
      count: null,
      detail: `${label} — ${missingDetail}`,
      id: `system_role_not_assigned:${role}`,
      severity: missingSeverity,
      target: { resource: role, section: "roles" },
      title: "System role not assigned"
    };
  }
  if (assignment.available) return null;
  return {
    action: "Open roles",
    code: "system_role_unavailable",
    count: null,
    detail: `${label} uses ${assignment.displayName} on ${assignment.connectionDisplayName}, which is not available — pick another model`,
    id: `system_role_unavailable:${role}`,
    severity: "bad",
    target: { resource: role, section: "roles" },
    title: "System role unavailable"
  };
}

function systemRoleItems(catalog: AdminSystemModelPolicyCatalog): AdminAttentionItem[] {
  const policy = catalog.policy;
  return [
    roleItem(
      "memory",
      "Memory & structured helpers",
      policy.systemModel,
      "Memory and structured helpers stay off until a checked model is assigned",
      "warn"
    ),
    policy.chatPdfPreparationAllowed
      ? roleItem(
          "chat_pdf",
          "Chat PDF preparation",
          policy.chatPdfModel,
          "page preparation is on but has no model to read pages",
          "warn"
        )
      : null,
    roleItem(
      "reranker",
      "Reranking",
      policy.rerankerModel,
      "Knowledge answers use plain ranking until a reranker is assigned",
      "neutral"
    )
  ].filter((item): item is AdminAttentionItem => item !== null);
}

function knowledgeAlertLine(
  code: AdminKnowledgeSettings["operations"]["alerts"][number]["code"],
  operations: AdminKnowledgeSettings["operations"]
): string {
  switch (code) {
    case "knowledge_deletion_backlog":
      return `${plural(operations.deletion.pendingJobs, "deletion")} waiting`;
    case "knowledge_deletion_blocked":
      return `${plural(operations.deletion.blockedJobs, "deletion")} blocked`;
    case "knowledge_ingestion_failures":
      return `${plural(operations.ingestion.failedArtifacts, "document")} need reprocessing`;
    case "knowledge_ingestion_queue_stalled":
      return "document processing is stalled";
    case "knowledge_retrieval_degraded":
      return "retrieval was degraded in the last 24 hours";
    case "knowledge_search_backend_unavailable":
      return "the search backend is unavailable";
    case "knowledge_search_projection_backlog":
      return `${plural(operations.search.pendingProjections, "search projection")} waiting`;
    case "knowledge_search_projection_failures":
      return `${plural(operations.search.failedProjections, "search projection")} failed`;
    case "knowledge_search_worker_unavailable":
      return "the search worker is not running";
    case "knowledge_upload_sessions_expired":
      return `${plural(operations.ingestion.expiredUploads, "upload")} expired`;
    case "knowledge_v1_reconciliation_incomplete":
      return "an earlier data migration is incomplete";
  }
}

function knowledgeItems(knowledge: AdminKnowledgeSettings): AdminAttentionItem[] {
  const items: AdminAttentionItem[] = [];
  const { operations, profile } = knowledge;
  if (operations.alerts.length > 0) {
    const failures = operations.alerts.some((alert) => alert.code === "knowledge_ingestion_failures");
    items.push({
      action: "Open Knowledge",
      code: "knowledge_needs_attention",
      count: operations.alerts.length,
      detail: operations.alerts
        .slice(0, 3)
        .map((alert) => knowledgeAlertLine(alert.code, operations))
        .join(" · "),
      id: "knowledge_needs_attention",
      severity: operations.alerts.some((alert) => alert.severity === "critical") ? "bad" : "warn",
      target: { section: "retrieval" },
      title: failures ? "Knowledge documents failed processing" : "Knowledge needs attention"
    });
  }
  if (profile.migration.buildingProfileBases > 0) {
    items.push({
      action: "Open Knowledge",
      code: "knowledge_reindexing",
      count: profile.migration.buildingProfileBases,
      detail: `${profile.migration.buildingProfileBases} of ${plural(profile.migration.totalBases, "base")} still reindexing`,
      id: "knowledge_reindexing",
      severity: "neutral",
      target: { section: "retrieval" },
      title: "Knowledge is reindexing"
    });
  }
  return items;
}

function memoryItems(memory: AdminMemoryStatus): AdminAttentionItem[] {
  const items: AdminAttentionItem[] = [];
  if (memory.worker.state === "NOT_RUNNING") {
    items.push({
      action: "Open Memory",
      code: "memory_worker_not_running",
      count: null,
      detail: `New facts are not learned until the worker starts${
        memory.queue.length > 0 ? ` · ${plural(memory.queue.length, "job")} waiting` : ""
      }`,
      id: "memory_worker_not_running",
      severity: "bad",
      target: { section: "retrieval" },
      title: "Memory worker is not running"
    });
  }
  if (memory.index.readiness === "REBUILD_REQUIRED") {
    items.push({
      action: "Open Memory",
      code: "memory_index_rebuild_required",
      count: null,
      detail: "Semantic recall stays off until the index is rebuilt",
      id: "memory_index_rebuild_required",
      severity: "warn",
      target: { section: "retrieval" },
      title: "Memory index needs a rebuild"
    });
  }
  return items;
}

function mcpItems(servers: readonly AdminMcpServer[]): AdminAttentionItem[] {
  return servers.flatMap((server) => {
    const attention = adminMcpAttention(server);
    if (!attention) return [];
    return [{
      action: "Open server",
      code: "mcp_server_needs_attention" as const,
      count: 1,
      detail: `${server.name} · ${attention.label}`,
      id: `mcp_server_needs_attention:${server.id}`,
      severity: attention.task === "runtime" ? "bad" as const : "warn" as const,
      target: { resource: server.id, section: "mcp" as const },
      title: "MCP server needs attention"
    }];
  });
}

function emailItems(email: AdminEmailState): AdminAttentionItem[] {
  if (email.active.configuration === null) {
    return [{
      action: "Set up email",
      code: "email_not_configured",
      count: null,
      detail: email.draft.configuration
        ? "A saved configuration is not active yet — send a test and activate it"
        : "Invites and approvals are sent by link only until SMTP is set up",
      id: "email_not_configured",
      severity: "neutral",
      target: { section: "email" },
      title: "Email delivery is not configured"
    }];
  }
  if (email.active.enabled && email.health.degraded) {
    const reason = email.health.lastFailureCode
      ? ` (${email.health.lastFailureCode.replaceAll("_", " ")})`
      : "";
    return [{
      action: "Open email",
      code: "email_delivery_failing",
      count: null,
      detail: `The last delivery attempt failed${reason} — check the SMTP settings`,
      id: "email_delivery_failing",
      severity: "bad",
      target: { section: "email" },
      title: "Email delivery is failing"
    }];
  }
  return [];
}

/** Pure derivation over already-loaded inputs, in the PRD catalog order. */
export function deriveAdminAttentionItems(inputs: AdminAttentionInputs): AdminAttentionItem[] {
  return [
    ...(inputs.dashboard ? dashboardItems(inputs.dashboard, inputs.actingAdminUserId) : []),
    ...(inputs.providers ? providerItems(inputs.providers) : []),
    ...(inputs.search ? searchItems(inputs.search) : []),
    ...(inputs.systemRoles ? systemRoleItems(inputs.systemRoles) : []),
    ...(inputs.knowledge ? knowledgeItems(inputs.knowledge) : []),
    ...(inputs.memory ? memoryItems(inputs.memory) : []),
    ...(inputs.mcp ? mcpItems(inputs.mcp) : []),
    ...(inputs.email ? emailItems(inputs.email) : [])
  ];
}

export function createAdminAttentionService(input: Readonly<{
  now?: () => Date;
  sources: AdminAttentionSources;
}>): AdminAttentionService {
  const now = input.now ?? (() => new Date());
  const { sources } = input;

  return {
    async list(actingAdminUserId) {
      const unavailable: AdminAttentionSource[] = [];
      async function load<T>(source: AdminAttentionSource, loader: () => Promise<T>): Promise<T | null> {
        try {
          return await loader();
        } catch {
          unavailable.push(source);
          return null;
        }
      }
      const [dashboard, providers, search, systemRoles, knowledge, memory, mcp, email] = await Promise.all([
        load("dashboard", () => sources.dashboard(actingAdminUserId)),
        load("providers", () => sources.providers()),
        load("search", () => sources.search(actingAdminUserId)),
        load("system_roles", () => sources.systemRoles()),
        load("knowledge", () => sources.knowledge()),
        load("memory", () => sources.memory()),
        load("mcp", () => sources.mcp(actingAdminUserId)),
        load("email", () => sources.email())
      ]);
      return {
        checkedAt: now().toISOString(),
        items: deriveAdminAttentionItems({
          actingAdminUserId,
          dashboard,
          email,
          knowledge,
          mcp,
          memory,
          providers,
          search,
          systemRoles
        }),
        unavailable
      };
    }
  };
}
