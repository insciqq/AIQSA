import { adminMcpActivationStage, adminMcpActivationVerb } from "@/components/admin/mcp/adminMcpActivation";
import {
  activeInventory,
  draftInventory,
  enabledMcpToolInventory,
  sourceDisplay
} from "@/components/admin/mcp/adminMcpDraft";
import { formatCheckedAt } from "@/components/admin/providers/providerListView";
import { adminMcpAttention, type AdminMcpServer, type McpRevisionSummary } from "@/lib/contracts/mcp";

/**
 * Presentation rules for the MCP servers page (PRD 5.10, 3.3): one status
 * word per server, the header state line, and the plain-language labels for
 * earlier configurations and the administrator's authorization. Everything
 * derives from the admin catalog; nothing here talks to the server.
 */

export type McpStatusTone = "critical" | "neutral" | "ok" | "warn";

export type McpServerStatusKind =
  | "applying"
  | "archived"
  | "check_failed"
  | "disabled"
  | "needs_attention"
  | "not_applied"
  | "runtime_unavailable"
  | "setup_needed"
  | "update_ready"
  | "working";

export type McpServerStatus = Readonly<{
  /** Second half of the header line, e.g. `5 of 6 tools on · checked today 12:51`. */
  detail: string;
  kind: McpServerStatusKind;
  label: string;
  tone: McpStatusTone;
}>;

function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

/** `5 of 6 tools on` for the current configuration, or `No tools` when it exposes none. */
export function mcpToolsSummary(server: AdminMcpServer): string {
  const inventory = server.activeRevision ? activeInventory(server) : draftInventory(server);
  const disabled = server.activeRevision ? server.activeRevision.disabledToolNames : server.draft.disabledToolNames;
  if (!inventory.length) return server.draftTest || server.activeRevision ? "No tools" : "Not checked";
  const enabled = enabledMcpToolInventory(inventory, disabled).length;
  return enabled === inventory.length
    ? `${plural(inventory.length, "tool")} on`
    : `${enabled} of ${inventory.length} tools on`;
}

/** Whether the latest check differs from what is in use, so Test & Save has something to apply. */
export function mcpHasUnappliedCheck(server: AdminMcpServer): boolean {
  return Boolean(
    server.draftTested &&
    server.draftTest &&
    (!server.activeRevision || server.draftTest.identityHash !== server.activeRevision.identityHash)
  );
}

export function mcpServerStatus(server: AdminMcpServer, now = new Date()): McpServerStatus {
  if (server.archivedAt) {
    return { detail: "Kept for records only", kind: "archived", label: "Archived", tone: "neutral" };
  }
  const stage = adminMcpActivationStage(server);
  if (stage) {
    return {
      detail: `${adminMcpActivationVerb(server)} · ${stage.label} (step ${stage.step} of ${stage.total})`,
      kind: "applying",
      label: "Applying",
      tone: "neutral"
    };
  }
  if (server.activation?.stage === "failed") {
    return {
      detail: "The settings were not applied; the current configuration keeps running",
      kind: "check_failed",
      label: "Check failed",
      tone: "critical"
    };
  }
  const attention = adminMcpAttention(server);
  if (attention) {
    if (server.draft.auth.mode === "oauth" && server.validationOAuth?.state !== "ready") {
      return { detail: attention.label, kind: "setup_needed", label: "Setup needed", tone: "warn" };
    }
    if (server.activeRevision?.artifactStatus === "missing" || server.runtimeProblem === "unavailable") {
      return { detail: attention.label, kind: "runtime_unavailable", label: "Runtime unavailable", tone: "critical" };
    }
    return { detail: attention.label, kind: "needs_attention", label: "Needs attention", tone: "warn" };
  }
  if (!server.activeRevision) {
    return {
      detail: server.draftTested
        ? "Checked · use Test & Save to apply the settings"
        : "Use Test & Save to check and apply the settings",
      kind: "setup_needed",
      label: "Setup needed",
      tone: "warn"
    };
  }
  if (!server.enabled) {
    return { detail: `${mcpToolsSummary(server)} · not offered in chats`, kind: "disabled", label: "Disabled", tone: "neutral" };
  }
  if (mcpHasUnappliedCheck(server)) {
    return {
      detail: "Checked · use Test & Save to apply the update",
      kind: "update_ready",
      label: "Update ready",
      tone: "warn"
    };
  }
  if (!server.draftTested) {
    return {
      detail: "Use Test & Save to check and apply your changes",
      kind: "not_applied",
      label: "Changes not applied",
      tone: "warn"
    };
  }
  return {
    detail: `${mcpToolsSummary(server)} · checked ${formatCheckedAt(server.activeRevision.validationEvidence.testedAt, now)}`,
    kind: "working",
    label: "Working",
    tone: "ok"
  };
}

/** `Working · 5 of 6 tools on · checked today 12:51` for the page header. */
export function mcpHeaderStatus(server: AdminMcpServer, now = new Date()): string {
  const status = mcpServerStatus(server, now);
  return `${status.label} · ${status.detail}`;
}

export function mcpSourceLabel(server: AdminMcpServer): string {
  const kind = server.draft.source.kind;
  const prefix = kind === "remote" ? "Remote" : kind === "npm" ? "npm" : kind === "pypi" ? "PyPI" : "Image";
  return `${prefix} · ${sourceDisplay(server.draft.source)}`;
}

/** `2 groups · 1 user` from the direct grants, or `No access yet`. */
export function mcpAccessSummary(server: AdminMcpServer): string {
  const groups = server.grants.filter((grant) => grant.canUse && grant.groupId).length;
  const users = server.grants.filter((grant) => grant.canUse && grant.userId).length;
  if (!groups && !users) return "No access yet";
  return [groups ? plural(groups, "group") : null, users ? plural(users, "user") : null]
    .filter((part): part is string => part !== null)
    .join(" · ");
}

export type McpAuthorizationState = Readonly<{
  detail: string;
  label: "Connected" | "Disconnecting" | "Not connected" | "Reconnect needed";
  tone: McpStatusTone;
}>;

/** The administrator's own authorization used to check an OAuth server. */
export function mcpAuthorizationState(server: AdminMcpServer): McpAuthorizationState {
  const connection = server.validationOAuth;
  if (connection?.state === "ready") {
    return {
      detail: connection.accountLabel ? `Checking as ${connection.accountLabel}` : "Your account checks the settings",
      label: "Connected",
      tone: "ok"
    };
  }
  if (connection?.state === "reauthorization_required") {
    return { detail: "Reconnect your account to check changes", label: "Reconnect needed", tone: "warn" };
  }
  if (connection?.state === "disconnecting") {
    return { detail: "The saved authorization is being removed", label: "Disconnecting", tone: "neutral" };
  }
  return { detail: "Connect your account to check and apply the settings", label: "Not connected", tone: "neutral" };
}

export type McpConfigurationBuild = Readonly<{
  label: "Needs rebuild" | "Not verified" | "Ready to restore" | "Remote";
  tone: McpStatusTone;
}>;

/** Whether an earlier configuration can be restored as is or has to be rebuilt first. */
export function mcpConfigurationBuild(configuration: McpRevisionSummary): McpConfigurationBuild {
  switch (configuration.artifactStatus) {
    case "available":
      return { label: "Ready to restore", tone: "ok" };
    case "missing":
      return { label: "Needs rebuild", tone: "critical" };
    case "not_applicable":
      return { label: "Remote", tone: "neutral" };
    default:
      return { label: "Not verified", tone: "neutral" };
  }
}

export function mcpConfigurationSummary(configuration: McpRevisionSummary, now = new Date()): string {
  const inventory = configuration.validationEvidence.toolInventory;
  const enabled = enabledMcpToolInventory(inventory, configuration.disabledToolNames).length;
  const tools = inventory.length === 0
    ? "no tools"
    : enabled === inventory.length
      ? `${plural(inventory.length, "tool")} on`
      : `${enabled} of ${inventory.length} tools on`;
  return `Checked ${formatCheckedAt(configuration.validationEvidence.testedAt, now)} · ${tools}`;
}

export type AdminMcpOAuthOutcome = "cancelled" | "connected" | "failed";

export type AdminMcpOAuthReturn = Readonly<{
  outcome: AdminMcpOAuthOutcome | null;
  serverId: string | null;
}>;

/**
 * The validation OAuth callback lands on `/admin?section=mcp&oauth=…&server=…`
 * (`lib/server/mcp/oauthHandlers.ts`); the section turns it into the server
 * page plus one banner and removes only those two parameters.
 */
export function readAdminMcpOAuthReturn(href: string): AdminMcpOAuthReturn | null {
  const url = new URL(href, "http://localhost");
  if (url.searchParams.get("section") !== "mcp") return null;
  const raw = url.searchParams.get("oauth");
  const outcome = raw === "connected" || raw === "cancelled" || raw === "failed" ? raw : null;
  const serverId = url.searchParams.get("server");
  return outcome || serverId ? { outcome, serverId } : null;
}

export function withoutAdminMcpOAuthReturn(href: string): string {
  const url = new URL(href, "http://localhost");
  url.searchParams.delete("oauth");
  url.searchParams.delete("server");
  return `${url.pathname}${url.search}${url.hash}`;
}

export function mcpOAuthOutcomeCopy(outcome: AdminMcpOAuthOutcome): Readonly<{ text: string; tone: McpStatusTone }> {
  switch (outcome) {
    case "connected":
      return { text: "Your account is connected. AIQSA checked the settings and applied them.", tone: "ok" };
    case "cancelled":
      return { text: "Authorization was cancelled. Nothing changed.", tone: "warn" };
    default:
      return {
        text: "Authorization or the settings check failed. Review the settings and try again.",
        tone: "critical"
      };
  }
}
