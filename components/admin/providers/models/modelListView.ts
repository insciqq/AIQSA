import type { ProviderUsageSources } from "@/components/admin/providers/providerListView";
import { formatCheckedAt } from "@/components/admin/providers/providerListView";
import { modelChipsFromEvidence, modelUsageMissing, type ModelChip } from "@/components/admin/providers/models/modelChips";
import type {
  AdminProviderActiveCheck,
  AdminProviderConnection,
  AdminProviderCredential,
  AdminProviderModel,
  AdminProviderModelClass
} from "@/lib/contracts/adminProviders";

/**
 * Presentation rules for the Models table (PRD 5.4): grouping, the route
 * line, `Used as` tags per model, the consequence of turning a used model
 * off, and the sentence of the expanded row. Pure; tested on its own.
 */

const collator = new Intl.Collator("en", { numeric: true, sensitivity: "base" });

export const MODEL_GROUP_ORDER: readonly AdminProviderModelClass[] = ["answer", "reranker", "embedding"];

const groupTitles: Record<AdminProviderModelClass, string> = {
  answer: "Chat models",
  embedding: "Embeddings",
  reranker: "Rerankers"
};

export type ProviderModelGroup = Readonly<{
  modelClass: AdminProviderModelClass;
  models: readonly AdminProviderModel[];
  title: string;
}>;

export function modelClassOf(model: Pick<AdminProviderModel, "draftConfig" | "modelClass">): AdminProviderModelClass {
  return model.modelClass ?? model.draftConfig.modelClass ?? "answer";
}

/** The configuration users run with; the draft only while nothing is live yet. */
export function liveConfiguration(model: Pick<AdminProviderModel, "activeConfig" | "draftConfig">) {
  return model.activeConfig ?? model.draftConfig;
}

/** Chat models, Rerankers, Embeddings in that order; empty groups are hidden. */
export function groupProviderModels(models: readonly AdminProviderModel[]): readonly ProviderModelGroup[] {
  return MODEL_GROUP_ORDER.flatMap((modelClass) => {
    const members = models
      .filter((model) => modelClassOf(model) === modelClass)
      .sort((left, right) => collator.compare(left.displayName, right.displayName) || collator.compare(left.id, right.id));
    return members.length ? [{ modelClass, models: members, title: groupTitles[modelClass] }] : [];
  });
}

/** `Qwen3 Embedding 8B · 1536d`: the only place a dimension is spoken (PRD 3.3).
 * Preset display names may already carry the suffix; it is never doubled. */
export function embeddingModelLabel(displayName: string, targetDimension: number): string {
  const suffix = `· ${targetDimension}d`;
  return displayName.endsWith(suffix) ? displayName : `${displayName} ${suffix}`;
}

export function modelTitle(model: AdminProviderModel): string {
  const embedding = liveConfiguration(model).embedding;
  return embedding ? embeddingModelLabel(model.displayName, embedding.targetDimension) : model.displayName;
}

/** `via Anthropic only` · `via 2 providers` · `automatic routing`; nothing outside OpenRouter. */
export function modelRouteLabel(
  connection: Pick<AdminProviderConnection, "family">,
  model: AdminProviderModel
): string | null {
  if (connection.family !== "openrouter") return null;
  const routing = liveConfiguration(model).openRouterRouting;
  if (!routing) return null;
  if (routing.mode === "only_selected") {
    return routing.providers.length === 1
      ? `via ${routing.providers[0]} only`
      : `via ${routing.providers.length} providers`;
  }
  return "automatic routing";
}

/** `Used as` tags per model id, in display order. */
export type ModelUsageIndex = ReadonlyMap<string, readonly string[]>;

export function deriveModelUsage(sources: ProviderUsageSources): ModelUsageIndex {
  const tags = new Map<string, string[]>();
  const add = (modelId: string | null | undefined, tag: string) => {
    if (!modelId) return;
    const list = tags.get(modelId) ?? [];
    if (!list.includes(tag)) list.push(tag);
    tags.set(modelId, list);
  };
  add(sources.modelPolicy?.policy.defaultModel?.id, "Default chat");
  const roles = sources.systemModelPolicy?.policy;
  add(roles?.systemModel?.id, "System model");
  add(roles?.chatPdfModel?.id, "Chat PDF");
  const route = roles?.rerankerRoute?.entries ?? [];
  if (route.length) {
    for (const entry of route) add(entry.id, entry.role === "primary" ? "Reranker · primary" : "Reranker · fallback");
  } else {
    add(roles?.rerankerModel?.id, "Reranker");
  }
  const revision = sources.knowledge?.profile.activeRevision;
  add(revision?.pdfProcessing.destination?.deploymentId, "Knowledge docs");
  add(revision?.destination.deploymentId, "Knowledge embeddings");
  for (const integration of sources.search?.integrations ?? []) {
    if (integration.archivedAt || !integration.enabled) continue;
    add(integration.providerModel?.id, integration.displayName);
  }
  return tags;
}

/**
 * Who takes over automatically when this model is turned off: only the
 * reranker route has an ordered fallback; every other role needs a hand.
 */
export function modelSuccessor(modelId: string, sources: ProviderUsageSources): string | null {
  const entries = [...(sources.systemModelPolicy?.policy.rerankerRoute?.entries ?? [])]
    .sort((left, right) => left.position - right.position);
  const index = entries.findIndex((entry) => entry.id === modelId);
  if (index < 0) return null;
  const next = entries.slice(index + 1).find((entry) => entry.available);
  return next?.displayName ?? null;
}

export type TurnOffConsequence = Readonly<{
  body: string;
  title: string;
}>;

function joinNames(names: readonly string[]): string {
  if (names.length <= 1) return names[0] ?? "";
  return `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`;
}

/**
 * The confirmation before turning off a model a role, a Search source or the
 * installation default relies on (PRD 5.4). Null means no confirmation.
 */
export function turnOffConsequence(input: Readonly<{
  model: Pick<AdminProviderModel, "displayName">;
  successor: string | null;
  tags: readonly string[];
}>): TurnOffConsequence | null {
  if (input.tags.length === 0) return null;
  const roles = input.tags.filter((tag) => tag.startsWith("Reranker"));
  const uses: string[] = [];
  if (input.tags.includes("Default chat")) uses.push("the default chat model for new chats");
  if (input.tags.includes("System model")) uses.push("the System model");
  if (input.tags.includes("Chat PDF")) uses.push("the chat PDF model");
  if (roles.length) {
    uses.push(roles.includes("Reranker · primary") || roles.includes("Reranker")
      ? "the primary reranker for Memory and Knowledge"
      : "a fallback reranker for Memory and Knowledge");
  }
  if (input.tags.includes("Knowledge docs")) uses.push("the Knowledge document model");
  if (input.tags.includes("Knowledge embeddings")) uses.push("the Knowledge embedding model");
  const known = new Set(["Default chat", "System model", "Chat PDF", "Knowledge docs", "Knowledge embeddings"]);
  const searchSources = input.tags.filter((tag) => !known.has(tag) && !tag.startsWith("Reranker"));
  if (searchSources.length) {
    uses.push(`the model behind ${joinNames(searchSources.map((name) => `“${name}”`))} Search`);
  }
  const first = `It is ${joinNames(uses)}.`;
  const takeover = input.successor
    ? `${input.successor} takes over automatically, and chats in progress keep using the current model until they finish.`
    : "Nothing takes over automatically — reassign it under Defaults & roles or Search. Chats in progress keep using the current model until they finish.";
  return {
    body: `${first} ${takeover}\n\nNothing is deleted. You can turn it back on at any time.`,
    title: `Turn off ${input.model.displayName}?`
  };
}

function liveVersion(credential: AdminProviderCredential | null | undefined) {
  return credential?.enabled && credential.activeVersion && credential.activeVersion.revokedAt === null
    ? credential.activeVersion
    : null;
}

/** The latest check of the exact active model × key pair, if the pair is live. */
export function activeModelCheck(
  connection: AdminProviderConnection,
  model: AdminProviderModel,
  credential: AdminProviderCredential | null | undefined
): AdminProviderActiveCheck | null {
  const version = liveVersion(credential);
  if (!version || !credential || !model.activeConfig || model.activeVersion < 1) return null;
  return connection.activeChecks
    .filter((check) =>
      check.connectionVersion === connection.activeVersion &&
      check.modelVersion === model.activeVersion &&
      check.providerModelId === model.id &&
      check.credentialId === credential.id &&
      check.credentialVersionId === version.id)
    .reduce<AdminProviderActiveCheck | null>((latest, check) =>
      !latest || Date.parse(check.checkedAt) > Date.parse(latest.checkedAt) ? check : latest, null);
}

export function defaultCredentialOf(connection: AdminProviderConnection): AdminProviderCredential | null {
  return connection.credentials.find(({ id }) => id === connection.defaultCredentialId) ?? null;
}

/** Initial diagnostic context only; this never changes credential assignments. */
export function initialDiagnosticCredentialId(connection: AdminProviderConnection): string | null {
  const credentials = checkableCredentials(connection);
  const runKey = credentials.find(({ id }) => id === connection.checkRun?.credentialId);
  if (runKey) return runKey.id;
  const defaultKey = credentials.find(({ id }) => id === connection.defaultCredentialId);
  return defaultKey?.id ?? (credentials.length === 1 ? credentials[0]!.id : null);
}

/** A replaced key or endpoint cannot inherit the preceding run's status. */
export function diagnosticCheckRun(connection: AdminProviderConnection, credentialId: string | null) {
  const run = connection.checkRun;
  const credential = connection.credentials.find(({ id }) => id === credentialId);
  const version = liveVersion(credential);
  if (!run || run.credentialId !== credentialId || !version) return null;
  const startedAt = Date.parse(run.startedAt);
  if ([connection.activatedAt, version.activatedAt].some((at) => at && Date.parse(at) > startedAt)) return null;
  return run;
}

/** Keys that can run a check right now: on, with a working saved value. */
export function checkableCredentials(connection: AdminProviderConnection): readonly AdminProviderCredential[] {
  return connection.credentials.filter((credential) => credential.enabled && liveVersion(credential) !== null);
}

export type ModelCheckSummary = Readonly<{
  chips: readonly ModelChip[];
  credentialLabel: string;
  sentence: string;
  usageMissing: boolean;
}>;

function describeChips(chips: readonly ModelChip[], modelClass: AdminProviderModelClass): string {
  if (chips.some((entry) => entry.key === "unavailable")) {
    return "the provider reports this model as not available with this key.";
  }
  if (modelClass === "embedding") return "embeddings work.";
  if (modelClass === "reranker") return "reranking works.";
  const missing = chips.filter((entry) => entry.tone !== "ok");
  const tools = chips.some((entry) => entry.key === "tools" && entry.tone === "ok");
  const json = chips.some((entry) => entry.key === "json" && entry.tone === "ok");
  if (missing.length === 0) {
    return tools && json
      ? "tools, JSON and the other checked capabilities work."
      : "everything checked works.";
  }
  const labels = missing.map((entry) => entry.key === "pdf" ? "PDF input" : entry.key === "images" ? "image input" : entry.key === "stream" ? "streaming" : entry.key === "json" ? "JSON output" : "tools");
  return `works without ${joinNames(labels)}${tools && json ? "; tools and JSON output are fine." : "."}`;
}

/** Describe only the selected key's exact current result. */
export function modelCheckSummaries(
  connection: AdminProviderConnection,
  model: AdminProviderModel,
  credential: AdminProviderCredential | null | undefined,
  now = new Date()
): readonly ModelCheckSummary[] {
  const configuration = liveConfiguration(model);
  const modelClass = modelClassOf(model);
  const check = activeModelCheck(connection, model, credential);
  const chips = modelChipsFromEvidence(configuration, check);
  if (!credential || !check || chips.length === 0) return [];
  return [{
    chips,
    credentialLabel: credential.label,
    sentence: `Checked ${formatCheckedAt(check.checkedAt, now)} with key ${credential.label} · ${describeChips(chips, modelClass)}`,
    usageMissing: modelUsageMissing(configuration, check)
  }];
}
