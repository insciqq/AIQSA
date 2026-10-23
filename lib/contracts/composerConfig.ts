import type { AssistantSummary } from "./assistants";
import type { Catalog } from "./catalog";
import type { McpReadiness, McpRuntimeErrorCode } from "./mcp";
import type { SkillSummary } from "./skills";

export type ComposerConfigMcpServer = Readonly<{
  runtimeErrorCode?: McpRuntimeErrorCode | null;
  /**
   * Personal rows are the account's own connections, managed in Settings →
   * Connections; installation rows (the default) are managed in Studio.
   */
  source?: "installation" | "personal";
  attention?: "needs_setup" | "needs_authorization" | "reauthorization_required" | "unavailable" | null;
  description: string;
  enabled: boolean;
  id: string;
  knownToolCount: number;
  name: string;
  readiness: McpReadiness;
}>;

export type ComposerConfig = Readonly<{
  assistants: readonly AssistantSummary[];
  catalog: Catalog;
  mcpServers: readonly ComposerConfigMcpServer[];
  skills?: readonly SkillSummary[];
}>;
