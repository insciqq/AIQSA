import type { ModelToolCall, RunTool } from "../tools/types";
import {
  KNOWLEDGE_DISCOVER_SOURCES_TOOL_NAME,
  KNOWLEDGE_EXACT_TOOL_NAME,
  KNOWLEDGE_QUERY_MAX_CHARACTERS,
  KNOWLEDGE_READ_SOURCE_TOOL_NAME,
  KNOWLEDGE_SEARCH_TOOL_NAME,
  KNOWLEDGE_TOOL_NAME
} from "./retrievalTypes";
import type { KnowledgeOperationKind } from "./knowledgeBudget";
import { validateKnowledgeToolArguments } from "./retrievalQuery";

const SOURCE_ALIAS_PATTERN = "^[BS][1-9][0-9]{0,2}$";
const SOURCE_ALIAS_LIMIT = 32;
const EXACT_TERM_LIMIT = 16;

export type KnowledgeSemanticToolRequest = Readonly<{
  operation: KnowledgeOperationKind;
  query: string;
  read?: Readonly<{
    direction: "after" | "around" | "before";
    locator: string;
    sourceAlias: string;
    window: number;
  }>;
  sourceAliases: readonly string[];
}>;

const sourceAliasesSchema = Object.freeze({
  description: "Optional admitted scope aliases (for example S1 or B2). Never pass storage IDs.",
  items: { maxLength: 4, minLength: 2, pattern: SOURCE_ALIAS_PATTERN, type: "string" },
  maxItems: SOURCE_ALIAS_LIMIT,
  type: ["array", "null"]
});

export const knowledgeRetrievalTool: RunTool = Object.freeze({
  capability: "knowledge",
  description: "Internal automatic private Knowledge retrieval.",
  inputSchema: {
    additionalProperties: false,
    properties: {
      query: {
        maxLength: KNOWLEDGE_QUERY_MAX_CHARACTERS,
        minLength: 1,
        type: "string"
      }
    },
    required: ["query"],
    type: "object"
  },
  name: KNOWLEDGE_TOOL_NAME,
  strict: true
});

export const knowledgeSearchTool: RunTool = Object.freeze({
  capability: "knowledge",
  description:
    "Search only the private Knowledge scope already admitted for this answer. " +
    "Use this after the automatic evidence pass when a focused follow-up is necessary.",
  inputSchema: {
    additionalProperties: false,
    properties: {
      coverage: {
        enum: ["focused", "diverse", "comparison", null],
        type: ["string", "null"]
      },
      exactTerms: {
        items: { maxLength: 200, minLength: 1, type: "string" },
        maxItems: EXACT_TERM_LIMIT,
        type: ["array", "null"]
      },
      purpose: { maxLength: 200, minLength: 1, type: ["string", "null"] },
      query: {
        maxLength: KNOWLEDGE_QUERY_MAX_CHARACTERS,
        minLength: 1,
        type: "string"
      },
      sourceAliases: sourceAliasesSchema
    },
    required: ["coverage", "exactTerms", "purpose", "query", "sourceAliases"],
    type: "object"
  },
  name: KNOWLEDGE_SEARCH_TOOL_NAME,
  strict: true
});

export const knowledgeExactTool: RunTool = Object.freeze({
  capability: "knowledge",
  description:
    "Find an exact phrase, token, code, date, or identifier only inside the admitted private Knowledge scope.",
  inputSchema: {
    additionalProperties: false,
    properties: {
      match: { enum: ["phrase", "token", "pattern"], type: "string" },
      sourceAliases: sourceAliasesSchema,
      value: {
        maxLength: KNOWLEDGE_QUERY_MAX_CHARACTERS,
        minLength: 1,
        type: "string"
      }
    },
    required: ["match", "sourceAliases", "value"],
    type: "object"
  },
  name: KNOWLEDGE_EXACT_TOOL_NAME,
  strict: true
});

export const knowledgeReadSourceTool: RunTool = Object.freeze({
  capability: "knowledge",
  description:
    "Read a bounded area of one source already returned under an admitted S-number alias. " +
    "The locator must be an exact displayed heading path, a labeled page number, or an evidence handle.",
  inputSchema: {
    additionalProperties: false,
    properties: {
      direction: {
        enum: ["around", "after", "before", null],
        type: ["string", "null"]
      },
      locator: {
        maxLength: KNOWLEDGE_QUERY_MAX_CHARACTERS,
        minLength: 1,
        type: "string"
      },
      sourceAlias: { maxLength: 4, minLength: 2, pattern: "^S[1-9][0-9]{0,2}$", type: "string" },
      window: { maximum: 8, minimum: 1, type: ["integer", "null"] }
    },
    required: ["direction", "locator", "sourceAlias", "window"],
    type: "object"
  },
  name: KNOWLEDGE_READ_SOURCE_TOOL_NAME,
  strict: true
});

export const knowledgeDiscoverSourcesTool: RunTool = Object.freeze({
  capability: "knowledge",
  description:
    "Discover source names and S-number aliases only within the scope admitted for this answer. " +
    "It cannot search the user's wider library.",
  inputSchema: {
    additionalProperties: false,
    properties: {
      query: {
        maxLength: KNOWLEDGE_QUERY_MAX_CHARACTERS,
        minLength: 1,
        type: "string"
      }
    },
    required: ["query"],
    type: "object"
  },
  name: KNOWLEDGE_DISCOVER_SOURCES_TOOL_NAME,
  strict: true
});

export const knowledgeFollowUpTools = Object.freeze([
  knowledgeSearchTool,
  knowledgeExactTool,
  knowledgeReadSourceTool,
  knowledgeDiscoverSourcesTool
]);

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function onlyKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  const keys = new Set(allowed);
  return Object.keys(value).every((key) => keys.has(key));
}

function boundedString(value: unknown, maximum: number): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim();
  return normalized && normalized.length <= maximum && !/\u0000/u.test(normalized)
    ? normalized
    : null;
}

function sourceAliases(value: unknown): readonly string[] | null {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.length > SOURCE_ALIAS_LIMIT ||
    value.some((alias) => typeof alias !== "string" || !/^[BS][1-9]\d{0,2}$/u.test(alias)) ||
    new Set(value).size !== value.length) return null;
  return value as string[];
}

function queryWithExactTerms(query: string, terms: readonly string[]): string {
  const missing = terms.filter((term) => !query.includes(term));
  const suffix = missing.length > 0 ? ` ${missing.join(" ")}` : "";
  return `${query.slice(0, Math.max(1, KNOWLEDGE_QUERY_MAX_CHARACTERS - suffix.length)).trimEnd()}${suffix}`
    .slice(0, KNOWLEDGE_QUERY_MAX_CHARACTERS)
    .trim();
}

export function parseKnowledgeSemanticToolRequest(
  call: Pick<ModelToolCall, "arguments" | "name">
): KnowledgeSemanticToolRequest | null {
  const value = call.arguments;
  if (call.name === KNOWLEDGE_TOOL_NAME) {
    const validated = validateKnowledgeToolArguments(value);
    return validated.ok
      ? { operation: "automatic_search", query: validated.query, sourceAliases: [] }
      : null;
  }
  if (!record(value)) return null;
  if (call.name === KNOWLEDGE_SEARCH_TOOL_NAME) {
    if (!onlyKeys(value, ["coverage", "exactTerms", "purpose", "query", "sourceAliases"])) {
      return null;
    }
    const query = boundedString(value.query, KNOWLEDGE_QUERY_MAX_CHARACTERS);
    const aliases = sourceAliases(value.sourceAliases);
    const terms = value.exactTerms === undefined || value.exactTerms === null
      ? []
      : Array.isArray(value.exactTerms) && value.exactTerms.length <= EXACT_TERM_LIMIT
        ? value.exactTerms.map((term) => boundedString(term, 200))
        : null;
    if (!query || !aliases || !terms || terms.some((term) => term === null) ||
      value.purpose !== undefined && value.purpose !== null && !boundedString(value.purpose, 200) ||
      value.coverage !== undefined && value.coverage !== null &&
        value.coverage !== "focused" && value.coverage !== "diverse" &&
        value.coverage !== "comparison") return null;
    return {
      operation: "search_knowledge",
      query: queryWithExactTerms(query, terms as string[]),
      sourceAliases: aliases
    };
  }
  if (call.name === KNOWLEDGE_EXACT_TOOL_NAME) {
    if (!onlyKeys(value, ["match", "sourceAliases", "value"]) ||
      value.match !== "phrase" && value.match !== "token" && value.match !== "pattern") return null;
    const query = boundedString(value.value, KNOWLEDGE_QUERY_MAX_CHARACTERS);
    const aliases = sourceAliases(value.sourceAliases);
    return query && aliases
      ? { operation: "find_exact", query, sourceAliases: aliases }
      : null;
  }
  if (call.name === KNOWLEDGE_READ_SOURCE_TOOL_NAME) {
    if (!onlyKeys(value, ["direction", "locator", "sourceAlias", "window"]) ||
      typeof value.sourceAlias !== "string" || !/^S[1-9]\d{0,2}$/u.test(value.sourceAlias) ||
      value.direction !== undefined && value.direction !== null && value.direction !== "around" &&
        value.direction !== "after" && value.direction !== "before" ||
      value.window !== undefined && value.window !== null && (!Number.isSafeInteger(value.window) ||
        Number(value.window) < 1 || Number(value.window) > 8)) return null;
    const query = boundedString(value.locator, KNOWLEDGE_QUERY_MAX_CHARACTERS);
    return query
      ? {
          operation: "read_source",
          query,
          read: {
            direction: value.direction ?? "around",
            locator: query,
            sourceAlias: value.sourceAlias,
            window: value.window === undefined || value.window === null
              ? 3
              : Number(value.window)
          },
          sourceAliases: [value.sourceAlias]
        }
      : null;
  }
  if (call.name === KNOWLEDGE_DISCOVER_SOURCES_TOOL_NAME) {
    if (!onlyKeys(value, ["query"])) return null;
    const query = boundedString(value.query, KNOWLEDGE_QUERY_MAX_CHARACTERS);
    return query
      ? { operation: "discover_sources", query, sourceAliases: [] }
      : null;
  }
  return null;
}
