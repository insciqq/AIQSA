import type { Prisma } from "@prisma/client";
import type { AssistantRows } from "../../contracts/assistants";
import type { ChatAssistantOverrides } from "../../contracts/chats";
import { loadActiveGroupMemberships, loadEntitlementsForMemberships } from "../auth/dbEntitlements";
import {
  buildCurrentUserCatalog,
  resolveChatDefaults,
  resolveCurrentUserCatalogSelection,
  type CatalogData
} from "../catalog/currentUserCatalog";
import { createPrismaCatalogDataLoader } from "../catalog/prismaCatalogData";
import { loadUserAccessibleMcpServerIdsWith, usableSkillIds } from "./prismaRepository";
import type {
  AssistantRowAvailableResources,
  AssistantRowContextDefaults
} from "./rowResolution";
import { runControlsFromSavedValues } from "./runControlMaterialization";

/*
 * Inputs of the Assistant row chain: what inherit means and which resources
 * the runner may use, from the user's Chat defaults and catalog. Run
 * admission and the chat projection load them the same way, so a row the
 * projection shows as usable is the row a run admits.
 */

/** Resources named by the rows that need a database check. */
export type AssistantRowResourceIds = Readonly<{
  skillIds: readonly string[];
}>;

export type AssistantRowContext = Readonly<{
  available: AssistantRowAvailableResources;
  defaults: AssistantRowContextDefaults;
  /** The connection each available model runs through, by model id. */
  modelConnections: ReadonlyMap<string, string>;
}>;

/** A client or transaction; a transaction reads everything from one snapshot. */
export type AssistantRowContextClient = Prisma.TransactionClient;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * The stored overrides that take part in resolution. Stored controls
 * belong to the stored model override they were set with: when the request
 * carries no new controls and that model will not be in effect (the request
 * sets a model, the Model row is now fixed, or the stored model left the
 * runner's catalog), the controls are left out, exactly as the admission
 * write (`nextChatAssistantOverrides`) then removes them. Controls stored
 * without a model override apply to whichever model the chain resolves.
 */
export function storedOverridesInEffect(input: Readonly<{
  assistant: AssistantRows;
  available: Pick<AssistantRowAvailableResources, "modelIds">;
  requested: ChatAssistantOverrides;
  stored: ChatAssistantOverrides;
}>): ChatAssistantOverrides {
  const { assistant, available, requested, stored } = input;
  if (stored.controls === undefined || requested.controls !== undefined) return stored;
  const storedModelLost = stored.model !== undefined && (
    assistant.model.policy === "fixed" || !available.modelIds.has(stored.model.modelId)
  );
  if (requested.model === undefined && !storedModelLost) return stored;
  const { controls: _controls, ...withoutControls } = stored;
  return withoutControls;
}

/**
 * The user's Chat defaults in chain vocabulary, from the same catalog the
 * composer is seeded from: the default model with the organization fallback
 * (empty when none is usable, which fails admission as an ordinary chat
 * would), the default Search plan and MCP mode, and the saved per-model
 * control values including the organization reasoning default.
 * Saved values that no longer decode read as none.
 */
export function personalAssistantRowDefaults(data: CatalogData): Readonly<{
  defaults: AssistantRowContextDefaults;
  modelConnections: ReadonlyMap<string, string>;
  modelIds: ReadonlySet<string>;
  searchOptionIds: ReadonlySet<string>;
}> {
  const catalog = buildCurrentUserCatalog(data);
  const selection = resolveCurrentUserCatalogSelection(data);
  const modelConnections = new Map(catalog.models.map((model) => [model.modelId, model.provider]));
  const controlValues = catalog.defaults.controlValues;
  const search = catalog.defaults.searchPlan;
  const chatDefaults = resolveChatDefaults(data.settings);
  return {
    defaults: {
      controlsForModel: (modelId) => {
        const provider = modelConnections.get(modelId);
        const saved = provider ? controlValues[`${provider}:${modelId}`] : undefined;
        return isRecord(saved) ? runControlsFromSavedValues(saved) ?? {} : {};
      },
      modelId: catalog.defaults.modelId,
      search: search.optionIds.length > 0
        ? { mode: search.mode, optionIds: [...search.optionIds] }
        : { mode: "off" },
      tools: { mode: chatDefaults.mcpMode }
    },
    modelConnections,
    modelIds: new Set(modelConnections.keys()),
    searchOptionIds: new Set(selection.entitledStrategies.map((strategy) => strategy.strategyId))
  };
}

export type PersonalAssistantRowContextOptions = Readonly<{
  /** Replaces the catalog read, which otherwise reuses the group memberships read here. */
  loadCatalogData?: (userId: string) => Promise<CatalogData | null>;
}>;

/**
 * Loads the chain inputs of a personal chat for `userId` together with the
 * catalog they come from. The Skills set covers only `ids`; models, Search
 * sources and MCP servers are the user's complete usable sets. The user's
 * groups are read once, for the catalog, the entitlements and MCP alike.
 * After that read, the catalog, MCP and Skills reads run in parallel and each
 * reads one statement group at a time, so a load holds at most three
 * connections. Null when the user has no settings row.
 */
export async function loadPersonalAssistantRowInputs(
  client: AssistantRowContextClient,
  input: Readonly<{ ids: AssistantRowResourceIds; userId: string }>,
  options: PersonalAssistantRowContextOptions = {}
): Promise<Readonly<{ context: AssistantRowContext; data: CatalogData }> | null> {
  const { userId } = input;
  const memberships = await loadActiveGroupMemberships(client, userId);
  const activeGroupIds = memberships.map((membership) => membership.groupId);
  const loadCatalogData = options.loadCatalogData ?? createPrismaCatalogDataLoader({
    // The chain never reads the catalog's default Assistant.
    checkDefaultAssistant: false,
    concurrentReads: false,
    loadActiveGroupIds: async () => activeGroupIds,
    loadEntitlements: () => loadEntitlementsForMemberships(client, userId, memberships),
    prisma: client
  });
  const [data, mcpServerIds, skillIds] = await Promise.all([
    loadCatalogData(userId),
    loadUserAccessibleMcpServerIdsWith(client, userId, { activeGroupIds }),
    usableSkillIds(client, userId, [...new Set(input.ids.skillIds)])
  ]);
  if (!data) return null;
  const { defaults, modelConnections, modelIds, searchOptionIds } = personalAssistantRowDefaults(data);
  return {
    context: {
      available: {
        mcpServerIds,
        modelIds,
        searchOptionIds,
        skillIds
      },
      defaults,
      modelConnections
    },
    data
  };
}

/** The chain inputs of a personal chat: see `loadPersonalAssistantRowInputs`. */
export async function loadPersonalAssistantRowContext(
  client: AssistantRowContextClient,
  input: Readonly<{ ids: AssistantRowResourceIds; userId: string }>,
  options: PersonalAssistantRowContextOptions = {}
): Promise<AssistantRowContext | null> {
  return (await loadPersonalAssistantRowInputs(client, input, options))?.context ?? null;
}
