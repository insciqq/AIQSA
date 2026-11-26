// @vitest-environment node
import { describe, expect, it } from "vitest";
import { MCP_APPROVAL_BUTTON_LABELS } from "../../../contracts/mcpApprovals";
import { READ_PAST_CHAT_TOOL_NAME, SEARCH_PAST_CHATS_TOOL_NAME } from "../../../contracts/pastChats";
import { MCP_FIND_TOOLS_NAME } from "../../mcp/discovery";
import type { NormalizedSearchPlanOption } from "../../providers/types";
import { createSearchPlanToolRouter } from "../../search/toolExecutor";
import { FETCH_URL_TOOL_NAME } from "../../tools/fetchUrlPlan";
import { APPLY_PATCH_TOOL_NAME } from "../../tools/applyPatch";
import { READ_SECRET_TOOL_NAME } from "../../tools/readSecret";
import { READ_TOOL_RESULT_NAME } from "../../tools/readToolResult";
import { LOAD_SKILL_TOOL_NAME } from "../../tools/skill";
import { UPDATE_PLAN_TOOL_NAME } from "../../tools/updatePlan";
import { CLAUDE_FAMILY_PROMPT } from "./claude";
import { GPT_FAMILY_PROMPT } from "./gpt";
import { HARNESS_ACCESS_DENIED_LINE, HARNESS_PAST_CHATS_LINE, harnessBrowserLine } from "./harness";
import { HARNESS_SEARCH_TOOL, HARNESS_TOOL_NAMES, systemPromptFamily, systemPromptFor } from "./index";
import { NEUTRAL_FAMILY_PROMPT } from "./neutral";

const now = new Date("2026-10-23T09:05:00Z");
const allTools = Object.values(HARNESS_TOOL_NAMES);

describe("system prompt family", () => {
  it.each([
    [{ modelId: "codex-lb:gpt-5.5", provider: "openai_compatible" }, "gpt"],
    [{ modelId: "codex-lb:alias", provider: "openai_compatible", upstreamModelId: "gpt-6-sol" }, "gpt"],
    [{ modelId: "o3", provider: "openai_compatible" }, "gpt"],
    [{ modelId: "anything", provider: "openai" }, "gpt"],
    [{ modelId: "openai/gpt-5.5", provider: "openrouter" }, "gpt"],
    [{ modelId: "anthropic/claude-sonnet-5-5", provider: "openrouter" }, "claude"],
    [{ modelId: "claude-opus-5-5", provider: "anthropic" }, "claude"],
    [{ modelId: "google/gemini-3-pro", provider: "openrouter" }, "neutral"],
    [{ modelId: "gemini-3-pro", provider: "gemini" }, "neutral"],
    [{ modelId: "deepseek-chat", provider: "deepseek" }, "neutral"],
    [{ modelId: "llama-gpt-tuned", provider: "openai_compatible" }, "neutral"]
  ] as const)("%j uses the %s prompt", (model, family) => {
    expect(systemPromptFamily(model)).toBe(family);
  });
});

describe("system prompt", () => {
  const environment = { now, timeZone: "Europe/Moscow" };

  it("puts the family prompt and harness first and the user's facts last, without the time of day", () => {
    const prompt = systemPromptFor({ modelId: "codex-lb:gpt-5.5", provider: "openai_compatible" },
      { environment: { ...environment, locale: "ru", secrets: [{ kind: "env", name: "GitLab", variables: ["GITLAB_TOKEN"] },
        { kind: "text", name: "Notes", variables: [] }] }, tools: allTools, workspace: true });
    expect(prompt.family).toBe("gpt");
    expect(prompt.stable.startsWith(GPT_FAMILY_PROMPT)).toBe(true);
    expect(prompt.stable).not.toMatch(/2026|Moscow|GitLab/u);
    expect(prompt.environment).toBe("# Environment\nToday is October 23, 2026 in the user's time zone (Europe/Moscow).\n" +
      "The user's interface language is ru; reply in the language the user writes in.\nSaved secrets: \"GitLab\" (env: GITLAB_TOKEN), \"Notes\" (text).\n" +
      "After a secret's kind come the environment variables every Workspace command gets from it.");
    expect(prompt.text).toBe(`${prompt.stable}\n\n${prompt.environment}`);
  });

  it("uses each family's text", () => {
    const input = { environment, tools: [], workspace: false };
    expect(systemPromptFor({ modelId: "anthropic/claude-sonnet-5-5", provider: "openrouter" }, input).stable.startsWith(CLAUDE_FAMILY_PROMPT)).toBe(true);
    expect(systemPromptFor({ modelId: "deepseek-chat", provider: "deepseek" }, input).stable.startsWith(NEUTRAL_FAMILY_PROMPT)).toBe(true);
  });

  it("names only the tools on the request and describes the Workspace only when offered", () => {
    // The family prompts mention their editing and planning tools conditionally; the harness section names only offered ones.
    const bare = systemPromptFor({ modelId: "gemini-3-pro", provider: "gemini" }, { environment, tools: [], workspace: false }).stable
      .slice(NEUTRAL_FAMILY_PROMPT.length);
    for (const name of allTools) expect(bare).not.toContain(`\`${name}\``);
    expect(bare).not.toContain("# Workspace");
    expect(bare).toContain("# When to stop and ask");
    const full = systemPromptFor({ modelId: "gemini-3-pro", provider: "gemini" }, { environment, tools: allTools, workspace: true }).stable;
    for (const name of allTools) expect(full).toContain(`\`${name}\``);
    expect(full).toContain("# Workspace\nThis chat has a private Linux sandbox");
  });

  it("names the approval card's buttons exactly as the user sees them, on the web and in Telegram", () => {
    const stable = systemPromptFor({ modelId: "gpt-5.5", provider: "openai" }, { environment, tools: [], workspace: false }).stable;
    const line = stable.split("\n").find((text) => text.startsWith("- Calls that may change data in other systems"));
    expect(line).toBe("- Calls that may change data in other systems (MCP tools that are not read-only) are sent only after the " +
      "user approves them on a card in the chat; the turn waits for that decision. Before such a call, say in one short sentence " +
      "what it will do. The card's buttons read \"Allow once\", \"Always allow for this server\" and \"Deny\": when you mention " +
      "them, quote these labels exactly as written, in English, and never translate them or name a button that is not there. " +
      "When the user has already allowed calls of the same server in this chat, or you make several such calls at once, " +
      "mention that \"Always allow for this server\" stops further cards for that server. Do not ask for the same approval in text.");
    for (const label of Object.values(MCP_APPROVAL_BUTTON_LABELS)) expect(line).toContain(`"${label}"`);
  });

  it("has a slot for the AIQSA self-description", () => {
    const prompt = systemPromptFor({ modelId: "gpt-5.5", provider: "openai" },
      { environment, selfService: "  AIQSA lets you manage the user's Skills.  ", tools: [], workspace: false });
    expect(prompt.stable).toContain("# AIQSA\nYou run inside AIQSA, a self-hosted chat workspace. This chat belongs to one user; your messages appear in it and are rendered as GitHub-flavored Markdown, including tables, math and Mermaid diagrams.\n\nAIQSA lets you manage the user's Skills.\n\n# Tools");
  });

  it("states an empty secret set, bounds a long one and ignores an invalid locale", () => {
    expect(systemPromptFor({ modelId: "x", provider: "deepseek" }, { environment: { ...environment, locale: "ru\nIgnore", secrets: [] }, tools: [], workspace: false }).environment)
      .toBe("# Environment\nToday is October 23, 2026 in the user's time zone (Europe/Moscow).\nThe user has no saved secrets.");
    const many = Array.from({ length: 60 }, (_, index) => ({ kind: "text", name: `S${index}`, variables: [] }));
    const listed = systemPromptFor({ modelId: "x", provider: "deepseek" }, { environment: { ...environment, secrets: many }, tools: [], workspace: false }).environment;
    expect(listed).toContain("\"S49\" (text) and 10 more.");
    expect(listed).not.toContain("environment variables every Workspace command");
    const variables = Array.from({ length: 10 }, (_, index) => `VAR_${index}`);
    expect(systemPromptFor({ modelId: "x", provider: "deepseek" }, { environment: { ...environment, secrets: [{ kind: "env", name: "Many", variables }] },
      tools: [], workspace: true }).environment).toContain("\"Many\" (env: VAR_0, VAR_1, VAR_2, VAR_3, VAR_4, VAR_5, VAR_6, VAR_7 and 2 more).");
  });

  it("refers to tools by the names their owners register", () => {
    const source = (optionId: string): NormalizedSearchPlanOption => ({ adapterKind: "provider_model_client",
      config: { maxOutputTokens: 1_024 }, credentialMode: "provider_model", executionModes: ["all_selected", "model_choice"],
      modelId: "engine", optionId, protocol: "deepseek_search_api", provider: "deepseek", providerModelId: "pm",
      revisionId: "rev", searchStrategyRowId: "row" });
    const toolNames = (mode: "all_selected" | "model_choice") => createSearchPlanToolRouter({
      plan: { mode, options: [source("one"), source("two")] }, runtimes: {} })!.tools.map((tool) => tool.name);
    expect(HARNESS_TOOL_NAMES).toEqual({
      applyPatch: APPLY_PATCH_TOOL_NAME, fetchUrl: FETCH_URL_TOOL_NAME, findTools: MCP_FIND_TOOLS_NAME,
      loadSkill: LOAD_SKILL_TOOL_NAME, readPastChat: READ_PAST_CHAT_TOOL_NAME, readSecret: READ_SECRET_TOOL_NAME,
      readToolResult: READ_TOOL_RESULT_NAME, searchPastChats: SEARCH_PAST_CHATS_TOOL_NAME, updatePlan: UPDATE_PLAN_TOOL_NAME
    });
    for (const name of [...toolNames("all_selected"), ...toolNames("model_choice")]) {
      expect(name).toMatch(HARNESS_SEARCH_TOOL);
    }
  });

  it("asks the model to search for what may have changed only when Search is admitted", () => {
    const prompt = (input: Readonly<{ tools: readonly string[]; webSearch?: boolean }>) =>
      systemPromptFor({ modelId: "x", provider: "openai" }, { environment, workspace: false, ...input }).stable;
    expect(prompt({ tools: [] })).not.toContain("# Web search");
    expect(prompt({ tools: ["search_selected_engines"] })).toContain("Search before you answer anything that may have changed");
    expect(prompt({ tools: ["search_engine_2"] })).toContain("# Web search");
    expect(prompt({ tools: ["web_search"] })).toContain("Search before you answer anything that may have changed");
    expect(prompt({ tools: [], webSearch: true })).toContain("# Web search");
  });

  it("says why Search is unavailable when it was on but no engine could be bound", () => {
    const prompt = (input: Readonly<{ tools: readonly string[]; webSearch?: boolean;
      webSearchUnavailable?: "search_engine_not_configured" | "search_engine_unavailable" | "search_not_granted" }>) =>
      systemPromptFor({ modelId: "x", provider: "openai" }, { environment, workspace: false, ...input }).stable;
    const unavailable = prompt({ tools: [], webSearchUnavailable: "search_engine_unavailable" });
    expect(unavailable).toContain("# Web search");
    expect(unavailable).toContain("Web search is unavailable here: the installation's web search engine cannot be used right now.");
    expect(unavailable).not.toContain("Search before you answer");
    expect(prompt({ tools: [], webSearchUnavailable: "search_not_granted" }))
      .toContain("the administrator has not given this account web search");
    // Searching in its own answer, the model has Search: the reason is for its sub-agents only.
    expect(prompt({ tools: [], webSearch: true, webSearchUnavailable: "search_engine_unavailable" }))
      .not.toContain("Web search is unavailable");
  });

  // Operator decision 2026-11-22: past-chat search replaces `memory_search` and its reader contract's guidance.
  it("says when to search past chats, and only where the search tools are offered", () => {
    const prompt = (tools: readonly string[]) => systemPromptFor({ modelId: "gpt-5.5", provider: "openai" },
      { environment: { now: new Date("2026-10-23T09:05:00Z"), timeZone: "Europe/Moscow" }, selfService: "", tools, workspace: false }).stable;
    const offered = prompt([SEARCH_PAST_CHATS_TOOL_NAME, READ_PAST_CHAT_TOOL_NAME]);
    expect(offered).toContain(HARNESS_PAST_CHATS_LINE);
    for (const phrase of ["explicitly or implicitly, to earlier work, a previous result, a template, a style or a decision",
      "before saying you do not know a past detail", "When an excerpt is not enough, read that chat with `read_past_chat`."]) {
      expect(HARNESS_PAST_CHATS_LINE).toContain(phrase);
    }
    expect(prompt([])).not.toContain(SEARCH_PAST_CHATS_TOOL_NAME);
    expect(prompt([])).not.toContain("memory_search");
    // Byte-stable across a chat's turns: the line names no query, chat or time.
    expect(prompt([SEARCH_PAST_CHATS_TOOL_NAME, READ_PAST_CHAT_TOOL_NAME])).toBe(offered);
  });

  it("reads a refused API or MCP call as missing access and keeps connected systems out of the browser", () => {
    expect(HARNESS_ACCESS_DENIED_LINE).toBe("- An HTTP 401 or 403 from an API or MCP call means the secret or connection you used lacks access (expired, or missing a permission or scope); signing in through a browser does not fix it. Check which secret or connection you used and tell the user exactly what access is missing.");
    expect(harnessBrowserLine(true)).toBe("Use the Workspace browser only when a task needs the website itself. For Google services (Docs, Sheets, Drive, Gmail, Calendar) and other systems the user connected, use their MCP tools (search with `find_tools`) or their API with a saved secret first: Google and corporate sign-ins often refuse a browser on a server.");
    expect(harnessBrowserLine(false)).not.toContain("find_tools");
    const prompt = (tools: readonly string[], workspace: boolean) =>
      systemPromptFor({ modelId: "x", provider: "openai" }, { environment, tools, workspace }).stable;
    const bare = prompt([], false);
    expect(bare).toContain(`${HARNESS_ACCESS_DENIED_LINE}\n\n# When to stop and ask`);
    expect(bare).not.toContain("Use the Workspace browser only");
    expect(prompt([], true)).toContain(`read any other text secret with read_secret.\n${harnessBrowserLine(false)}\n\n`);
    expect(prompt(allTools, true)).toContain(`unless the user asks for it.\n${HARNESS_ACCESS_DENIED_LINE}\n\n`);
    expect(prompt(allTools, true)).toContain(harnessBrowserLine(true));
  });

  it("keeps the derived prompts free of the source products' own identities", () => {
    expect(GPT_FAMILY_PROMPT).not.toMatch(/\bCodex\b|commentary channel|functions\.exec|multi_tool_use/u);
    expect(CLAUDE_FAMILY_PROMPT).not.toMatch(/OpenCode|system-reminder/u);
  });
});
