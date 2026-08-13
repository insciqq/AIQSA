import {
  decodeAssistantSummary,
  type AssistantSummary
} from "./assistants";
import {
  decodeCatalogResponse,
  type Catalog,
  type CurrentUserCatalogWire
} from "./catalog";
import type { McpReadiness } from "./mcp";

export type ComposerConfigKnowledgeBase = Readonly<{
  archived: boolean;
  description: string;
  id: string;
  name: string;
  owned: boolean;
}>;

export type ComposerConfigMcpServer = Readonly<{
  description: string;
  enabled: boolean;
  id: string;
  knownToolCount: number;
  name: string;
  readiness: McpReadiness;
}>;

export type ComposerConfigWire = Readonly<{
  assistants: AssistantSummary[];
  catalog: CurrentUserCatalogWire;
  knowledgeBases: ComposerConfigKnowledgeBase[];
  mcpServers: ComposerConfigMcpServer[];
}>;

export type ComposerConfigResponse = Readonly<{
  composerConfig: ComposerConfigWire;
}>;

export type ComposerConfig = Readonly<{
  assistants: AssistantSummary[];
  catalog: Catalog;
  knowledgeBases: ComposerConfigKnowledgeBase[];
  mcpServers: ComposerConfigMcpServer[];
}>;

const readinessValues = new Set<McpReadiness>([
  "authorizing",
  "disabled",
  "idle",
  "needs_authorization",
  "needs_setup",
  "queued",
  "ready",
  "reauthorization_required",
  "restarting",
  "starting",
  "unavailable"
]);

const composerConfigKeys = new Set([
  "assistants",
  "catalog",
  "knowledgeBases",
  "mcpServers"
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasOnlyKeys(value: Record<string, unknown>, expected: ReadonlySet<string>): boolean {
  const keys = Object.keys(value);
  return keys.length === expected.size && keys.every((key) => expected.has(key));
}

function boundedText(value: unknown, maximum: number, allowEmpty = false): value is string {
  return typeof value === "string" &&
    value.length <= maximum &&
    (allowEmpty || value.length > 0) &&
    !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(value);
}

function decodeKnowledgeBase(value: unknown): ComposerConfigKnowledgeBase | null {
  if (
    !isRecord(value) ||
    !hasOnlyKeys(value, new Set(["archived", "description", "id", "name", "owned"])) ||
    typeof value.archived !== "boolean" ||
    !boundedText(value.description, 2_000, true) ||
    !boundedText(value.id, 256) ||
    !boundedText(value.name, 80) ||
    typeof value.owned !== "boolean"
  ) {
    return null;
  }
  return {
    archived: value.archived,
    description: value.description,
    id: value.id,
    name: value.name,
    owned: value.owned
  };
}

function decodeMcpServer(value: unknown): ComposerConfigMcpServer | null {
  if (
    !isRecord(value) ||
    !hasOnlyKeys(
      value,
      new Set(["description", "enabled", "id", "knownToolCount", "name", "readiness"])
    ) ||
    !boundedText(value.description, 2_000, true) ||
    typeof value.enabled !== "boolean" ||
    !boundedText(value.id, 256) ||
    !Number.isSafeInteger(value.knownToolCount) ||
    Number(value.knownToolCount) < 0 ||
    Number(value.knownToolCount) > 512 ||
    !boundedText(value.name, 120) ||
    !readinessValues.has(value.readiness as McpReadiness)
  ) {
    return null;
  }
  return {
    description: value.description,
    enabled: value.enabled,
    id: value.id,
    knownToolCount: Number(value.knownToolCount),
    name: value.name,
    readiness: value.readiness as McpReadiness
  };
}

/**
 * Fail-closed decoder for the additive one-request Composer bootstrap. The
 * aggregate accepts exactly its four safe projections so a future repository
 * field cannot become browser-visible by object spreading.
 */
export function decodeComposerConfigResponse(value: unknown): ComposerConfig | null {
  if (!isRecord(value) || !isRecord(value.composerConfig)) return null;
  const config = value.composerConfig;
  if (
    !hasOnlyKeys(config, composerConfigKeys) ||
    !Array.isArray(config.assistants) ||
    !Array.isArray(config.knowledgeBases) ||
    !Array.isArray(config.mcpServers)
  ) {
    return null;
  }

  const catalog = decodeCatalogResponse({ catalog: config.catalog });
  const assistants = config.assistants.map(decodeAssistantSummary);
  const knowledgeBases = config.knowledgeBases.map(decodeKnowledgeBase);
  const mcpServers = config.mcpServers.map(decodeMcpServer);
  if (
    !catalog ||
    assistants.some((entry) => entry === null) ||
    knowledgeBases.some((entry) => entry === null) ||
    mcpServers.some((entry) => entry === null) ||
    new Set(assistants.map((entry) => entry?.id)).size !== assistants.length ||
    new Set(knowledgeBases.map((entry) => entry?.id)).size !== knowledgeBases.length ||
    new Set(mcpServers.map((entry) => entry?.id)).size !== mcpServers.length
  ) {
    return null;
  }

  return {
    assistants: assistants as AssistantSummary[],
    catalog,
    knowledgeBases: knowledgeBases as ComposerConfigKnowledgeBase[],
    mcpServers: mcpServers as ComposerConfigMcpServer[]
  };
}
