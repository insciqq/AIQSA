import type { AssistantSummary } from "./assistants";
import type { Catalog } from "./catalog";
import type { McpReadiness } from "./mcp";
import type { SkillSummary } from "./skills";

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

export type ComposerConfig = Readonly<{
  assistants: AssistantSummary[];
  catalog: Catalog;
  knowledgeBases: ComposerConfigKnowledgeBase[];
  mcpServers: ComposerConfigMcpServer[];
  skills?: SkillSummary[];
}>;
