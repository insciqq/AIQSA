import type { Prisma } from "@prisma/client";
import type { AssistantRows } from "../../contracts/assistants";
import type { ChatAssistantOverrides, ChatAssistantOverrideValues } from "../../contracts/chats";
import type { KnowledgeSelection } from "../../contracts/knowledge";
import type { ProjectDefaultsWire } from "../../contracts/projects";
import { loadActiveGroupMemberships, loadEntitlementsForMemberships } from "../auth/dbEntitlements";
import {
  buildCurrentUserCatalog,
  resolveChatDefaults,
  resolveCurrentUserCatalogSelection,
  type CatalogData
} from "../catalog/currentUserCatalog";
import { createPrismaCatalogDataLoader } from "../catalog/prismaCatalogData";
import { loadProjectAssistantAuthority, type ProjectAssistantAuthority } from "../projects/prismaRepository";
import {
  accessibleKnowledgeResources,
  loadUserAccessibleMcpServerIdsWith,
  usableSkillIds
} from "./prismaRepository";
import type {
  AssistantRowAvailableResources,
  AssistantRowContextDefaults
} from "./rowResolution";
import { runControlsFromSavedValues } from "./runControlMaterialization";

/*
 * Inputs of the Assistant row chain: what inherit means and which resources
 * the runner may use. In a personal chat these are the user's Chat defaults
 * and catalog; in a Project chat the Project's defaults and resources only,
 * never the runner's personal ones. Run admission and the chat projection
 * load them the same way, so a row the projection shows as usable is the row
 * a run admits.
 */

/** Resources named by the rows, stored overrides and request values that need a database check. */
export type AssistantRowResourceIds = Readonly<{
  knowledgeBaseIds: readonly string[];
  knowledgeSourceIds: readonly string[];
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

function knowledgeDefault(plan: KnowledgeSelection | null): ChatAssistantOverrideValues["knowledge"] {
  if (plan?.mode === "all_my_knowledge") return { mode: "all_my_knowledge" };
  if (plan?.mode === "explicit") return { baseIds: [...plan.baseIds], mode: "explicit", sourceIds: [...plan.sourceIds] };
  return { mode: "none" };
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
 * would), the default Search plan, MCP mode and Knowledge, and the saved
 * per-model control values including the organization reasoning default.
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
      knowledge: knowledgeDefault(chatDefaults.knowledgePlan),
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
 * catalog they come from. The Knowledge and Skills sets cover only `ids`;
 * models, Search sources and MCP servers are the user's complete usable
 * sets. The user's groups are read once, for the catalog, the entitlements,
 * MCP and Knowledge alike. After that read, the catalog, MCP, Knowledge and
 * Skills reads run in parallel and each reads one statement group at a time,
 * so a load holds at most four connections. Null when the user has no
 * settings row.
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
  const [data, mcpServerIds, knowledge, skillIds] = await Promise.all([
    loadCatalogData(userId),
    loadUserAccessibleMcpServerIdsWith(client, userId, { activeGroupIds }),
    accessibleKnowledgeResources(client, userId, {
      baseIds: [...new Set(input.ids.knowledgeBaseIds)],
      sourceIds: [...new Set(input.ids.knowledgeSourceIds)]
    }, { activeGroupIds }),
    usableSkillIds(client, userId, [...new Set(input.ids.skillIds)])
  ]);
  if (!data) return null;
  const { defaults, modelConnections, modelIds, searchOptionIds } = personalAssistantRowDefaults(data);
  return {
    context: {
      available: {
        allMyKnowledge: true,
        knowledgeBaseIds: new Set(knowledge.baseIds),
        knowledgeSourceIds: new Set(knowledge.sourceIds),
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

/**
 * The Project's defaults in chain vocabulary: its default model (empty when
 * none is set, which fails admission as an ordinary Project chat would), its
 * default Search plan, MCP mode and Knowledge, and its saved control values,
 * which apply to whichever model runs, as in an ordinary Project chat. Saved
 * values that no longer decode read as none.
 */
export function projectAssistantRowDefaults(defaults: ProjectDefaultsWire): AssistantRowContextDefaults {
  const controls = runControlsFromSavedValues(defaults.controlValues) ?? {};
  return {
    controlsForModel: () => ({ ...controls }),
    knowledge: knowledgeDefault(defaults.knowledgePlan),
    modelId: defaults.providerModelId ?? "",
    search: defaults.searchPlan.optionIds.length > 0
      ? { mode: defaults.searchPlan.mode, optionIds: [...defaults.searchPlan.optionIds] }
      : { mode: "off" },
    tools: { mode: defaults.mcpMode }
  };
}

/**
 * Loads the chain inputs of a Project chat from the Project alone: its stored
 * defaults and the models, Search sources, MCP servers, Knowledge and Skills
 * it provides. `allMyKnowledge` is false. Null for a missing or inactive
 * Project.
 */
export async function loadProjectAssistantRowContext(
  client: AssistantRowContextClient,
  input: Readonly<{ projectId: string }>
): Promise<AssistantRowContext | null> {
  const authority = await loadProjectAssistantAuthority(client, input.projectId);
  return authority ? projectAssistantRowContext(authority) : null;
}

/** The chain inputs of a Project chat from an already loaded Project authority. */
export function projectAssistantRowContext(authority: ProjectAssistantAuthority): AssistantRowContext {
  return {
    available: authority.available,
    defaults: projectAssistantRowDefaults(authority.defaults),
    modelConnections: authority.modelConnections
  };
}
