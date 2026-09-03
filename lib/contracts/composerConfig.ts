import type { AssistantSummary } from "./assistants";
import type { Catalog } from "./catalog";
import type { McpReadiness } from "./mcp";
import type { SkillSummary } from "./skills";

export type ComposerConfigKnowledgeBase = Readonly<{
  archived: boolean;
  attentionDocumentCount?: number;
  description: string;
  documentCount: number;
  id: string;
  name: string;
  owned: boolean;
  processingDocumentCount?: number;
  readinessState: "archived" | "empty" | "needs_attention" | "processing" | "ready" | "trashed";
  readyDocumentCount?: number;
}>;

export type ComposerConfigKnowledgeSource = Readonly<{
  description: string;
  id: string;
  name: string;
  owned: boolean;
  readiness: "needs_attention" | "processing" | "ready";
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
  assistants: readonly AssistantSummary[];
  catalog: Catalog;
  knowledgeBases: readonly ComposerConfigKnowledgeBase[];
  /** Exact server-projected catalog total; never inferred from a loaded page. */
  knowledgeDocumentTotal?: number;
  knowledgeSources?: readonly ComposerConfigKnowledgeSource[];
  mcpServers: readonly ComposerConfigMcpServer[];
  skills?: readonly SkillSummary[];
}>;
