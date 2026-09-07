import type { AdminKnowledgeSettings } from "@/lib/contracts/adminKnowledge";
import type { AdminModelPolicyCatalog } from "@/lib/contracts/adminModelPolicy";
import type {
  AdminProviderConnection,
  AdminProviderCredential
} from "@/lib/contracts/adminProviders";
import type { AdminSearchCatalog } from "@/lib/contracts/adminSearch";
import type { AdminSystemModelPolicyCatalog } from "@/lib/contracts/adminSystemModelPolicy";

/**
 * Presentation rules for the Providers list and provider page (PRD 5.2, 5.4).
 * Everything here is derived from the admin catalog and the installation
 * policies; the browser never adds state of its own.
 */

export type ProviderStatusTone = "neutral" | "ok" | "warn";

export type ProviderListStatus = Readonly<{
  kind: "disabled" | "key_rejected" | "not_checked" | "working";
  label: "Disabled" | "Key rejected" | "Not checked" | "Working";
  tone: ProviderStatusTone;
}>;

export type ProviderKeyState = Readonly<{
  detail: string;
  kind: "disabled" | "missing" | "rejected" | "revoked" | "working";
  label: "Disabled" | "No key" | "Rejected" | "Revoked" | "Working";
  tone: ProviderStatusTone;
}>;

export type ProviderUsageSources = Readonly<{
  knowledge: AdminKnowledgeSettings | null;
  modelPolicy: AdminModelPolicyCatalog | null;
  search: AdminSearchCatalog | null;
  systemModelPolicy: AdminSystemModelPolicyCatalog | null;
}>;

/** `Used as` tags per connection id, in display order. */
export type ProviderUsageIndex = ReadonlyMap<string, readonly string[]>;

export const PROVIDER_USED_AS_LIMIT = 3;

const familyLabels: Record<AdminProviderConnection["family"], string> = {
  anthropic: "Anthropic",
  deepseek: "DeepSeek",
  fake: "Fake",
  gemini: "Gemini",
  openai: "OpenAI",
  openai_compatible: "Custom",
  openrouter: "OpenRouter"
};

export function providerFamilyLabel(family: AdminProviderConnection["family"]): string {
  return familyLabels[family];
}

export function isCustomProvider(connection: Pick<AdminProviderConnection, "family">): boolean {
  return connection.family === "openai_compatible";
}

/** Host of the configured endpoint; the only endpoint part ordinary rows show. */
export function providerHost(apiRoot: string): string {
  try {
    return new URL(apiRoot).host;
  } catch {
    return apiRoot.replace(/^[a-z]+:\/\//iu, "").split("/")[0] ?? apiRoot;
  }
}

export function effectiveEndpoint(connection: AdminProviderConnection): string {
  return (connection.activeConfig ?? connection.draftConfig).apiRoot;
}

function activeGroupAssignments(connection: AdminProviderConnection) {
  return connection.assignments.filter((assignment) => assignment.group.archivedAt === null);
}

/** Keys that resolve for someone: the default plus every current group or user override. */
export function referencedCredentialIds(connection: AdminProviderConnection): ReadonlySet<string> {
  return new Set([
    ...(connection.defaultCredentialId ? [connection.defaultCredentialId] : []),
    ...activeGroupAssignments(connection).map((assignment) => assignment.credentialId),
    ...connection.userAssignments
      .filter((assignment) => assignment.user.status === "active")
      .map((assignment) => assignment.credentialId)
  ]);
}

function liveVersion(credential: AdminProviderCredential) {
  return credential.activeVersion && credential.activeVersion.revokedAt === null
    ? credential.activeVersion
    : null;
}

function keyChecks(connection: AdminProviderConnection, credential: AdminProviderCredential) {
  const version = liveVersion(credential);
  if (!version) return [];
  return connection.activeChecks.filter((check) =>
    check.credentialId === credential.id &&
    check.credentialVersionId === version.id &&
    check.connectionVersion === connection.activeVersion
  );
}

/** A live key whose every model check with the current configuration failed. */
export function credentialRejected(
  connection: AdminProviderConnection,
  credential: AdminProviderCredential
): boolean {
  const checks = keyChecks(connection, credential);
  return checks.length > 0 && checks.every((check) => check.status === "unavailable");
}

export function credentialWorking(
  connection: AdminProviderConnection,
  credential: AdminProviderCredential
): boolean {
  return credential.enabled && liveVersion(credential) !== null && !credentialRejected(connection, credential);
}

const dateFormatter = new Intl.DateTimeFormat("en-US", { day: "numeric", month: "short" });
const dateWithYearFormatter = new Intl.DateTimeFormat("en-US", {
  day: "numeric",
  month: "short",
  year: "numeric"
});
const timeFormatter = new Intl.DateTimeFormat("en-US", {
  hour: "2-digit",
  hour12: false,
  minute: "2-digit"
});

export function formatShortDate(iso: string, now = new Date()): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  return date.getFullYear() === now.getFullYear()
    ? dateFormatter.format(date)
    : dateWithYearFormatter.format(date);
}

/** `today 12:51` or `Aug 12 12:51`, for the header's last-checked note. */
export function formatCheckedAt(iso: string, now = new Date()): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  const sameDay = date.getFullYear() === now.getFullYear() &&
    date.getMonth() === now.getMonth() && date.getDate() === now.getDate();
  return `${sameDay ? "today" : formatShortDate(iso, now)} ${timeFormatter.format(date)}`;
}

/**
 * One line per key: Working / Rejected / Revoked (PRD 5.4), plus Disabled for
 * a key the administrator turned off and No key when nothing usable is saved.
 */
export function providerKeyState(
  connection: AdminProviderConnection,
  credential: AdminProviderCredential,
  now = new Date()
): ProviderKeyState {
  const version = credential.activeVersion;
  if (version?.revokedAt) {
    return {
      detail: `Revoked · ${formatShortDate(version.revokedAt, now)}`,
      kind: "revoked",
      label: "Revoked",
      tone: "warn"
    };
  }
  if (!version) {
    return {
      detail: "No key · use Rotate to add one",
      kind: "missing",
      label: "No key",
      tone: "neutral"
    };
  }
  if (!credential.enabled) {
    return {
      detail: `Disabled · added ${formatShortDate(credential.createdAt, now)}`,
      kind: "disabled",
      label: "Disabled",
      tone: "neutral"
    };
  }
  if (credentialRejected(connection, credential)) {
    return {
      detail: "Rejected · check the key",
      kind: "rejected",
      label: "Rejected",
      tone: "warn"
    };
  }
  const groups = activeGroupAssignments(connection)
    .filter((assignment) => assignment.credentialId === credential.id)
    .map((assignment) => assignment.group.name);
  const usedBy = groups.length
    ? `used by group ${groups[0]}${groups.length > 1 ? ` +${groups.length - 1}` : ""}`
    : `added ${formatShortDate(credential.createdAt, now)}`;
  return { detail: `Working · ${usedBy}`, kind: "working", label: "Working", tone: "ok" };
}

/**
 * Status word for the list (PRD 5.2): Disabled when the connection is off;
 * Key rejected when a key someone resolves to is rejected or revoked;
 * Not checked when no resolved key has ever been saved and tested;
 * Working otherwise.
 */
export function providerListStatus(connection: AdminProviderConnection): ProviderListStatus {
  if (!connection.enabled) {
    return { kind: "disabled", label: "Disabled", tone: "neutral" };
  }
  const referenced = referencedCredentialIds(connection);
  const keys = connection.credentials.filter((credential) => referenced.has(credential.id));
  const broken = keys.some((credential) =>
    (credential.activeVersion !== null && credential.activeVersion.revokedAt !== null) ||
    credentialRejected(connection, credential)
  );
  if (broken) return { kind: "key_rejected", label: "Key rejected", tone: "warn" };
  if (!keys.some((credential) => credentialWorking(connection, credential))) {
    return { kind: "not_checked", label: "Not checked", tone: "neutral" };
  }
  return { kind: "working", label: "Working", tone: "ok" };
}

/** `4 on` · `7 on · 1 off` · `3 off` · `No models`. */
export function providerModelsSummary(connection: AdminProviderConnection): string {
  const on = connection.models.filter((model) => model.enabled).length;
  const off = connection.models.length - on;
  if (on === 0 && off === 0) return "No models";
  if (off === 0) return `${on} on`;
  if (on === 0) return `${off} off`;
  return `${on} on · ${off} off`;
}

function modelNames(connection: AdminProviderConnection): string {
  const names = connection.models.filter((model) => model.enabled).map((model) => model.displayName);
  return names.length ? names.join(", ") : "No models yet";
}

/**
 * Built-in providers show their purpose (default chat, Search sources) or
 * their model names; custom ones show `Custom · host · models` and never the
 * full endpoint (PRD 5.2, decision 11).
 */
export function providerSubtitle(
  connection: AdminProviderConnection,
  usage: ProviderUsageIndex
): string {
  const tags = usage.get(connection.id) ?? [];
  if (isCustomProvider(connection)) {
    const host = providerHost(effectiveEndpoint(connection));
    const models = connection.enabled
      ? modelNames(connection)
      : `${connection.models.length} model${connection.models.length === 1 ? "" : "s"}`;
    return `Custom · ${host} · ${models}`;
  }
  if (tags.includes("Default chat")) {
    const searchSources = tags.length - tags.filter((tag) => ROLE_TAGS.has(tag)).length;
    return searchSources > 0
      ? `Default chat provider · ${searchSources} Search source${searchSources === 1 ? "" : "s"}`
      : "Default chat provider";
  }
  return modelNames(connection);
}

const ROLE_TAGS = new Set([
  "Default chat",
  "Memory",
  "Chat PDF",
  "Reranker",
  "Knowledge docs",
  "Knowledge embeddings"
]);

/** Tags shown inline plus the `+N` overflow count. */
export function visibleUsageTags(
  tags: readonly string[],
  limit = PROVIDER_USED_AS_LIMIT
): Readonly<{ hidden: number; shown: readonly string[] }> {
  return { hidden: Math.max(0, tags.length - limit), shown: tags.slice(0, limit) };
}

/**
 * `Used as` per connection: the installation default chat model, the system
 * roles, the Knowledge processing destinations and every enabled Search
 * source that runs through the connection. Missing sources add nothing.
 */
export function deriveProviderUsage(
  connections: readonly AdminProviderConnection[],
  sources: ProviderUsageSources
): ProviderUsageIndex {
  const modelOwner = new Map<string, string>();
  for (const connection of connections) {
    for (const model of connection.models) modelOwner.set(model.id, connection.id);
  }
  const tags = new Map<string, string[]>();
  const add = (connectionId: string | null | undefined, tag: string) => {
    if (!connectionId) return;
    const list = tags.get(connectionId) ?? [];
    if (!list.includes(tag)) list.push(tag);
    tags.set(connectionId, list);
  };

  add(sources.modelPolicy?.policy.defaultModel?.connectionId, "Default chat");
  const roles = sources.systemModelPolicy?.policy;
  add(roles?.systemModel?.connectionId, "Memory");
  add(roles?.chatPdfModel?.connectionId, "Chat PDF");
  add(roles?.rerankerModel?.connectionId, "Reranker");
  for (const entry of roles?.rerankerRoute?.entries ?? []) add(entry.connectionId, "Reranker");
  const revision = sources.knowledge?.profile.activeRevision;
  add(modelOwner.get(revision?.pdfProcessing.destination?.deploymentId ?? ""), "Knowledge docs");
  add(modelOwner.get(revision?.destination.deploymentId ?? ""), "Knowledge embeddings");
  for (const integration of sources.search?.integrations ?? []) {
    if (integration.archivedAt || !integration.enabled) continue;
    add(integration.providerModel?.connectionId, integration.displayName);
    add(integration.sourceConnectionId, integration.displayName);
  }
  return tags;
}

/** `All keys working · 7 models on · last checked today 12:51`. */
export function providerHeaderStatus(connection: AdminProviderConnection, now = new Date()): string {
  const parts: string[] = [];
  if (connection.credentials.length === 0) {
    parts.push("No keys yet");
  } else {
    const problems: string[] = [];
    const count = (n: number, word: string) => `${n} ${n === 1 ? "key" : "keys"} ${word}`;
    const rejected = connection.credentials.filter((credential) =>
      providerKeyState(connection, credential, now).kind === "rejected").length;
    const revoked = connection.credentials.filter((credential) =>
      providerKeyState(connection, credential, now).kind === "revoked").length;
    const off = connection.credentials.filter((credential) =>
      providerKeyState(connection, credential, now).kind === "disabled").length;
    const missing = connection.credentials.filter((credential) =>
      providerKeyState(connection, credential, now).kind === "missing").length;
    if (rejected) problems.push(count(rejected, "rejected"));
    if (revoked) problems.push(count(revoked, "revoked"));
    if (off) problems.push(count(off, "off"));
    if (missing) problems.push(count(missing, "without a value"));
    parts.push(problems.length ? problems.join(", ") : "All keys working");
  }
  const on = connection.models.filter((model) => model.enabled).length;
  parts.push(on === 0 ? "No models on" : `${on} model${on === 1 ? "" : "s"} on`);
  if (connection.checkRun?.state === "running" && connection.checkRun.reason !== "model") {
    parts.push("checking models");
    return parts.join(" · ");
  }
  const checked = [
    ...connection.activeChecks.map((check) => check.checkedAt),
    ...connection.credentials.flatMap((credential) =>
      credential.activeVersion ? [credential.activeVersion.testedAt] : [])
  ].filter((iso) => Number.isFinite(Date.parse(iso))).sort().at(-1);
  if (checked) parts.push(`last checked ${formatCheckedAt(checked, now)}`);
  return parts.join(" · ");
}
