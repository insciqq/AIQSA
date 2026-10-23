import type { Prisma } from "@prisma/client";
import {
  ASSISTANT_ROW_KEYS,
  decodeAssistantAvatarRecipe,
  type AssistantAvailability,
  type AssistantAvailabilityDependency,
  type AssistantAvatarRecipe,
  type AssistantRowDeviation,
  type AssistantRowDeviationKey,
  type AssistantRowKey,
  type AssistantRows
} from "../../contracts/assistants";
import type { ModelParameterControls } from "../../contracts/catalog";
import {
  decodeStoredChatAssistantOverrides,
  type ChatAssistantOverrides,
  type ChatAssistantProjection,
  type ChatAssistantRow,
  type ChatAssistantRowValues,
  type ChatAssistantRows
} from "../../contracts/chats";
import { isAssistantArchivedFor, isAssistantAvailable } from "../assistants/bindingAccess";
import {
  loadPersonalAssistantRowInputs,
  storedOverridesInEffect,
  type AssistantRowContext,
  type AssistantRowContextClient,
  type AssistantRowResourceIds
} from "../assistants/rowContext";
import {
  assistantValueAvailability,
  materializeAssistantRowControls,
  resolveAssistantRows,
  type AssistantRowAvailableResources,
  type AssistantRowResolution
} from "../assistants/rowResolution";
import { visibleAssistantRows } from "../assistants/rowRedaction";
import { assistantRowsFromStoredColumns } from "../assistants/storedContent";
import { resolveCurrentUserCatalogSelection, type CatalogData } from "../catalog/currentUserCatalog";
import { parameterDialect } from "../runs/runPreparation";

/*
 * The chat detail's Assistant projection (PRD 5.5, 10.6, 10.7): per row the
 * policy, the effective value and where it came from, computed with the same
 * loader, stored-override rule and priority chain as run admission, so the
 * projection and the next run cannot disagree. A read never writes: a stored
 * override that admission would ignore is ignored here and stays stored until
 * the next admission or chat update clears it.
 */

/** What controls materialization needs of a model, as run admission derives it. */
export type ChatAssistantModelParameters = Readonly<{
  baseParams: Record<string, unknown>;
  controls: ModelParameterControls;
  displayName: string;
  parameterProvider: string;
}>;

/** The chain inputs of the chat's context and the parameters of each model it can run. */
export type ChatAssistantChainContext = AssistantRowContext & Readonly<{
  /** Null for a model outside the context's catalog. */
  modelParameters(modelId: string): ChatAssistantModelParameters | null;
}>;

/** The bound definition, once the viewer is known to resolve it. */
export type ChatAssistantDefinition = Readonly<{
  archived: boolean;
  avatar: AssistantAvatarRecipe;
  id: string;
  /** The stored model's name, for the owner's missing-dependency copy only. */
  modelDisplayName: string | null;
  name: string;
  owned: boolean;
  ownerDisplayName: string;
  /** The complete, unredacted rows. */
  rows: AssistantRows;
}>;

export type ChatAssistantSource = Readonly<{
  context: ChatAssistantChainContext;
  definition: ChatAssistantDefinition;
}>;

type BlockingKey = "model" | "search" | "skills" | "tools";

/** A fixed row or the Skill links the viewer cannot use, with the ids missing from the context. */
type BlockedRow = Readonly<{ key: BlockingKey; missing: readonly string[] }>;

export type ChatAssistantRowsResolution = Readonly<{
  /** Fixed rows and Skill links admission refuses the Assistant for, in canonical row order. */
  blocked: readonly BlockedRow[];
  /** A control the Assistant applies does not fit the effective model; admission refuses it. */
  controlsUnavailable: boolean;
  /** Every row as the next message runs it; a blocked row keeps the Assistant's value. */
  resolution: AssistantRowResolution;
}>;

function blockedRows(assistant: AssistantRows, available: AssistantRowAvailableResources): BlockedRow[] {
  const blocked: BlockedRow[] = [];
  for (const key of ["model", "search", "tools"] as const) {
    if (assistant[key].policy !== "fixed") continue;
    const own = assistantValueAvailability(key, assistant, available);
    if (!own.available) blocked.push({ key, missing: own.missing });
  }
  // Every Skill link is required whatever the policy (Skills v2 5.2).
  const missingSkills = assistant.skills.value.links
    .map((link) => link.skillId)
    .filter((skillId) => !available.skillIds.has(skillId));
  if (missingSkills.length > 0) blocked.push({ key: "skills", missing: missingSkills });
  return blocked;
}

function withBlockedResources(
  available: AssistantRowAvailableResources,
  blocked: readonly BlockedRow[]
): AssistantRowAvailableResources {
  const add = (set: ReadonlySet<string>, key: BlockingKey) => {
    const ids = blocked.filter((row) => row.key === key).flatMap((row) => row.missing);
    return ids.length > 0 ? new Set([...set, ...ids]) : set;
  };
  return {
    ...available,
    mcpServerIds: add(available.mcpServerIds, "tools"),
    modelIds: add(available.modelIds, "model"),
    searchOptionIds: add(available.searchOptionIds, "search"),
    skillIds: add(available.skillIds, "skills")
  };
}

/**
 * Resolves every row of a bound chat as admission would with no request
 * values: the stored overrides admission keeps, the chain, and the
 * controls materialized for the effective model. Where admission refuses the
 * Assistant, the refused resources count as usable so that the other rows
 * still show what the chat would run once the Assistant is usable again.
 */
export function resolveChatAssistantRows(input: Readonly<{
  assistant: AssistantRows;
  context: ChatAssistantChainContext;
  stored: ChatAssistantOverrides;
}>): ChatAssistantRowsResolution {
  const { assistant, context } = input;
  const stored = storedOverridesInEffect({
    assistant,
    available: context.available,
    requested: {},
    stored: input.stored
  });
  const blocked = blockedRows(assistant, context.available);
  const resolved = resolveAssistantRows({
    assistant,
    available: blocked.length > 0 ? withBlockedResources(context.available, blocked) : context.available,
    defaults: context.defaults,
    requested: {},
    stored
  });
  if (!resolved.ok) throw new Error("assistant_row_resolution_inconsistent");
  const model = context.modelParameters(resolved.rows.model.value.modelId);
  if (!model) return { blocked, controlsUnavailable: false, resolution: resolved };
  const materialized = materializeAssistantRowControls(resolved, {
    baseParams: model.baseParams,
    controls: model.controls,
    parameterProvider: model.parameterProvider
  });
  return materialized.ok
    ? { blocked, controlsUnavailable: false, resolution: materialized.resolution }
    : { blocked, controlsUnavailable: true, resolution: resolved };
}

const unavailableReasons: Readonly<Record<BlockingKey, Exclude<AssistantAvailability, { ok: true }>["reason"]>> = {
  model: "model_access",
  search: "search_access",
  skills: "skills_access",
  tools: "tools_access"
};

/** Names for the owner, in the copy of the Assistant detail; Skills name none. */
function missingDependencies(key: BlockingKey, definition: ChatAssistantDefinition): AssistantAvailabilityDependency[] {
  if (key === "model") return [{ kind: "model", name: definition.modelDisplayName ?? "Saved model" }];
  if (key === "search") return [{ kind: "search", name: "Web search" }];
  if (key === "tools") return [{ kind: "mcp", name: "Required MCP tools" }];
  return [];
}

function withDependencies<T extends object>(
  value: T,
  owned: boolean,
  dependencies: AssistantAvailabilityDependency[]
): T & { dependencies?: AssistantAvailabilityDependency[] } {
  return owned && dependencies.length > 0 ? { ...value, dependencies } : value;
}

/**
 * Archived first; then, like the Assistant detail, a fixed model, Search or
 * Tools row, the Skill links, and finally a control of the Assistant that the
 * effective model does not support.
 */
function projectionAvailability(
  definition: ChatAssistantDefinition,
  resolved: ChatAssistantRowsResolution,
  context: ChatAssistantChainContext
): AssistantAvailability {
  if (definition.archived) return { ok: false, reason: "archived" };
  const first = (["model", "search", "tools", "skills"] as const)
    .map((key) => resolved.blocked.find((row) => row.key === key))
    .find((row) => row !== undefined);
  if (first) {
    return withDependencies({ ok: false as const, reason: unavailableReasons[first.key] }, definition.owned,
      missingDependencies(first.key, definition));
  }
  if (resolved.controlsUnavailable) {
    const name = context.modelParameters(resolved.resolution.rows.model.value.modelId)?.displayName;
    return withDependencies({ ok: false as const, reason: "model_access" as const }, definition.owned,
      name ? [{ kind: "model", name }] : []);
  }
  return { ok: true };
}

function effectiveValue<Key extends AssistantRowKey>(
  key: Key,
  resolved: AssistantRowResolution,
  visible: AssistantRows
): ChatAssistantRowValues[Key] {
  const row = resolved.rows[key];
  let value: ChatAssistantRowValues[AssistantRowKey];
  if (key === "skills") {
    // Links always come from the Assistant; only the mode can be the chat's.
    value = { ...visible.skills.value, mode: resolved.rows.skills.value.mode };
  } else if (key !== "controls" && row.provenance === "assistant") {
    // The Assistant's own value, identified exactly as far as its own value is.
    value = visible[key].value as ChatAssistantRowValues[AssistantRowKey];
  } else if (key === "model") {
    // An empty id is a user without a usable default model.
    value = { mode: "model", modelId: resolved.rows.model.value.modelId || null };
  } else {
    value = row.value as ChatAssistantRowValues[AssistantRowKey];
  }
  return value as ChatAssistantRowValues[Key];
}

function rowDeviation(
  key: AssistantRowKey,
  definition: ChatAssistantDefinition,
  resolved: AssistantRowResolution
): AssistantRowDeviation | null {
  if (key === "controls" || key === "skills") return null;
  if (definition.rows[key].policy !== "adjustable" || resolved.rows[key].assistantValueAvailable) return null;
  const reason = unavailableReasons[key as AssistantRowDeviationKey] as AssistantRowDeviation["reason"];
  return withDependencies({ reason }, definition.owned, missingDependencies(key as AssistantRowDeviationKey, definition));
}

/**
 * The `bound` projection of a definition the viewer resolves, in the chat's
 * chain context. It never carries instructions, answer rules or the reminder.
 */
export function buildChatAssistantProjection(input: ChatAssistantSource & Readonly<{
  stored: ChatAssistantOverrides;
}>): ChatAssistantProjection {
  const { context, definition } = input;
  const resolved = resolveChatAssistantRows({ assistant: definition.rows, context, stored: input.stored });
  const visible = visibleAssistantRows(definition.rows, context.available);
  const rows = Object.fromEntries(ASSISTANT_ROW_KEYS.map((key) => [key, {
    assistantValue: visible[key].value,
    deviation: rowDeviation(key, definition, resolved.resolution),
    policy: definition.rows[key].policy,
    provenance: resolved.resolution.rows[key].provenance,
    value: effectiveValue(key, resolved.resolution, visible)
  } satisfies ChatAssistantRow<typeof key>])) as ChatAssistantRows;
  return {
    availability: projectionAvailability(definition, resolved, context),
    avatar: definition.avatar,
    id: definition.id,
    name: definition.name,
    owned: definition.owned,
    ownerDisplayName: definition.ownerDisplayName,
    rows,
    state: "bound"
  };
}

const definitionSelect = {
  archivedAt: true,
  avatar: true,
  controlsPolicy: true,
  id: true,
  mcpMode: true,
  mcpServerIds: true,
  modelPolicy: true,
  name: true,
  owner: { select: { displayName: true } },
  ownerUserId: true,
  providerModel: { select: { displayName: true } },
  providerModelId: true,
  runControls: true,
  searchPlan: true,
  searchPolicy: true,
  skillLinks: { orderBy: { ordinal: "asc" }, select: { mode: true, skillId: true } },
  skillsMode: true,
  skillsPolicy: true,
  toolsPolicy: true
} satisfies Prisma.AssistantDefinitionSelect;

/**
 * The definition bound to a personal chat, when the viewer resolves it as run
 * admission does: their own (archived included, so the owner can restore it)
 * or published to them. A consumer also resolves one its owner archived while
 * it is still published to them, which projects as archived and nothing
 * more. An unreadable definition resolves like a missing one.
 */
export async function loadPersonalChatAssistantDefinition(
  client: AssistantRowContextClient,
  input: Readonly<{ assistantId: string; userId: string }>
): Promise<ChatAssistantDefinition | null> {
  const definition = await client.assistantDefinition.findUnique({
    select: definitionSelect,
    where: { id: input.assistantId }
  });
  if (!definition) return null;
  const owned = definition.ownerUserId === input.userId;
  if (!owned) {
    const access = { assistantId: definition.id, scope: { kind: "personal", userId: input.userId } } as const;
    const resolves = definition.archivedAt === null
      ? await isAssistantAvailable(client, access)
      : await isAssistantArchivedFor(client, access);
    if (!resolves) return null;
  }
  const rows = assistantRowsFromStoredColumns(definition);
  const avatar = decodeAssistantAvatarRecipe(definition.avatar);
  if (!rows || !avatar) return null;
  return {
    archived: definition.archivedAt !== null,
    avatar,
    id: definition.id,
    modelDisplayName: definition.providerModel?.displayName ?? null,
    name: definition.name,
    owned,
    ownerDisplayName: definition.owner.displayName,
    rows
  };
}

/** The Skill ids the chain checks, as admission collects them. */
function chainResourceIds(rows: AssistantRows): AssistantRowResourceIds {
  return { skillIds: rows.skills.value.links.map((link) => link.skillId) };
}

function catalogModelParameters(data: CatalogData): ChatAssistantChainContext["modelParameters"] {
  const models = new Map(resolveCurrentUserCatalogSelection(data).models.map((model) => [model.modelId, model]));
  return (modelId) => {
    const model = models.get(modelId);
    const entry = model && data.models.find((candidate) =>
      candidate.modelId === model.modelId && candidate.provider === model.provider);
    return model && entry
      ? {
          baseParams: model.defaultParams,
          controls: model.parameterControls,
          displayName: model.displayName,
          parameterProvider: parameterDialect(entry.adapterKind, entry.providerFamily)
        }
      : null;
  };
}

export type ChatAssistantCatalogLoader = (userId: string) => Promise<CatalogData | null>;

/**
 * The personal chain context: the loader run admission uses, plus the
 * parameters of the user's catalog models from the same catalog read. Null
 * when the user has no settings row, which admission refuses too.
 */
export async function loadPersonalChatAssistantContext(
  client: AssistantRowContextClient,
  input: Readonly<{ rows: AssistantRows; userId: string }>,
  options: Readonly<{ loadCatalogData?: ChatAssistantCatalogLoader }> = {}
): Promise<ChatAssistantChainContext | null> {
  const inputs = await loadPersonalAssistantRowInputs(client, {
    ids: chainResourceIds(input.rows),
    userId: input.userId
  }, options);
  return inputs ? { ...inputs.context, modelParameters: catalogModelParameters(inputs.data) } : null;
}

export type ChatAssistantBinding = Readonly<{
  assistantId: string | null;
  assistantOverrides: unknown;
}>;

/**
 * The chat detail's `assistant`. A chat without a binding reads nothing more:
 * no binding is null and the deletion marker is `deleted`. A bound chat whose
 * Assistant the viewer cannot resolve is `unavailable`, whether it is missing
 * or no longer published to them; one its owner archived while the viewer
 * still has it is `unavailable` with the reason `archived`, and discloses
 * nothing else. A chat open holds at most the connections of the chain
 * context's one parallel group.
 */
export async function loadChatAssistantProjection(
  client: AssistantRowContextClient,
  input: Readonly<{ chat: ChatAssistantBinding; userId: string }>,
  options: Readonly<{ loadCatalogData?: ChatAssistantCatalogLoader }> = {}
): Promise<ChatAssistantProjection | null> {
  const { chat, userId } = input;
  const decoded = decodeStoredChatAssistantOverrides(chat.assistantOverrides);
  if (decoded?.kind === "deleted") return { state: "deleted" };
  if (chat.assistantId === null) return null;
  // An undecodable value counts as no overrides, as admission reads it.
  const stored = decoded?.kind === "overrides" ? decoded.overrides : {};
  const definition = await loadPersonalChatAssistantDefinition(client, { assistantId: chat.assistantId, userId });
  if (definition && archivedForConsumer(definition)) return ARCHIVED_FOR_CONSUMER;
  const context = definition
    ? await loadPersonalChatAssistantContext(client, { rows: definition.rows, userId }, options)
    : null;
  return definition && context
    ? buildChatAssistantProjection({ context, definition, stored })
    : { state: "unavailable" };
}

const ARCHIVED_FOR_CONSUMER: ChatAssistantProjection = { reason: "archived", state: "unavailable" };

/** The owner keeps the archived Assistant bound, to restore it; a consumer learns only that it is archived. */
function archivedForConsumer(definition: ChatAssistantDefinition): boolean {
  return definition.archived && !definition.owned;
}
