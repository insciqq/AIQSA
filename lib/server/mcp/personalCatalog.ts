import {
  boundMcpToolDescription,
  isMcpToolName,
  MCP_SERVER_TOOL_LIMIT,
  type McpToolInventoryEntry
} from "@/lib/contracts/mcp";

/**
 * Personal MCP follows its server's live inventory with owner opt-out. This
 * module is the one owner of that source, so Settings, the Auto catalog, Load
 * all and the dispatch plan rebuild agree on which tools exist. The switched-off
 * set is a projection filter only: it never enters a runtime fingerprint, so
 * switching a tool never restarts or replaces a runtime generation.
 */
export type PersonalMcpTool = Readonly<{ description: string | null; name: string }>;

type InventoryObservation = Readonly<{
  inventory: unknown;
  oauthConnectionId: string | null;
  revisionId: string;
  state: string;
}>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

/**
 * Tool names and bounded descriptions of a generation inventory or of the
 * schema-free discovery an owner's runtime persisted. A malformed inventory is
 * no observation at all, never a partial one.
 */
export function personalMcpInventoryTools(inventory: unknown): PersonalMcpTool[] | null {
  if (!isRecord(inventory) || !Array.isArray(inventory.tools) || inventory.tools.length > MCP_SERVER_TOOL_LIMIT) {
    return null;
  }
  const names = new Set<string>();
  const tools: PersonalMcpTool[] = [];
  for (const candidate of inventory.tools) {
    if (!isRecord(candidate) || !isMcpToolName(candidate.name) || names.has(candidate.name) ||
      (candidate.description !== null && candidate.description !== undefined &&
        typeof candidate.description !== "string")) return null;
    names.add(candidate.name);
    tools.push({
      description: typeof candidate.description === "string" ? boundMcpToolDescription(candidate.description) : null,
      name: candidate.name
    });
  }
  return tools;
}

/**
 * The owner's live tools: the current ready generation's inventory, otherwise
 * the newest observation of the same revision and, for OAuth, of a connection
 * that is still ready. A restart that keeps the connection (new values, idle
 * eviction, process restart) therefore keeps the server's tools; after a
 * re-authorization nothing observed with the old account qualifies until the
 * new generation is ready. Administrator-disabled names never reappear.
 */
export function personalMcpLiveTools(input: Readonly<{
  activeRevisionId: string;
  /** The preference's current desired generation, if it still belongs to it. */
  current: InventoryObservation | null;
  discovered: Readonly<{ inventory: unknown; oauthConnectionId: string | null; revisionId: string | null }>;
  disabledByConfiguration?: readonly string[];
  oauthMode: boolean;
  readyOAuthConnectionIds: ReadonlySet<string>;
  recent: readonly InventoryObservation[];
}>): PersonalMcpTool[] {
  const sameIdentity = (revisionId: string | null, oauthConnectionId: string | null) =>
    revisionId === input.activeRevisionId && (!input.oauthMode ||
      (oauthConnectionId !== null && input.readyOAuthConnectionIds.has(oauthConnectionId)));
  const observed = (generation: InventoryObservation | null) =>
    generation?.state === "ready" && sameIdentity(generation.revisionId, generation.oauthConnectionId)
      ? personalMcpInventoryTools(generation.inventory)
      : null;
  let tools = observed(input.current);
  if (!tools && sameIdentity(input.discovered.revisionId, input.discovered.oauthConnectionId)) {
    tools = personalMcpInventoryTools(input.discovered.inventory);
  }
  for (const generation of input.recent) {
    if (tools) break;
    tools = observed(generation);
  }
  const disabled = new Set(input.disabledByConfiguration ?? []);
  return (tools ?? []).filter(({ name }) => !disabled.has(name));
}

/**
 * Auto catalog entries for the live tools the owner did not switch off. The
 * published revision only lends its argument summaries and display title to
 * tools that still carry the same name.
 */
export function personalMcpCatalogTools(
  live: readonly PersonalMcpTool[],
  revisionCatalog: readonly McpToolInventoryEntry[],
  userDisabledToolNames: readonly string[]
): McpToolInventoryEntry[] {
  const published = new Map(revisionCatalog.map((tool) => [tool.name, tool]));
  const disabled = new Set(userDisabledToolNames);
  return live.filter(({ name }) => !disabled.has(name)).map((tool) => {
    const revisionTool = published.get(tool.name);
    return {
      ...(revisionTool?.arguments ? { arguments: revisionTool.arguments } : {}),
      description: tool.description,
      name: tool.name,
      ...(revisionTool?.title ? { title: revisionTool.title } : {})
    };
  });
}

/**
 * The owner's next switched-off set. Names of tools that left the server are
 * kept, so a returning tool stays off; only when the bound is reached are the
 * names missing from the live inventory dropped.
 */
export function nextPersonalMcpDisabledToolNames(
  current: readonly string[],
  change: Readonly<{ enabled: boolean; name: string }>,
  liveToolNames: readonly string[]
): string[] {
  const next = new Set(current);
  if (change.enabled) next.delete(change.name);
  else next.add(change.name);
  if (next.size > MCP_SERVER_TOOL_LIMIT) {
    const live = new Set(liveToolNames);
    for (const name of next) if (!live.has(name)) next.delete(name);
  }
  return [...next].sort();
}
