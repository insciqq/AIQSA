// @vitest-environment node
import { describe, expect, it } from "vitest";
import { MCP_FIND_TOOLS_NAME } from "../../mcp/discovery";
import { APPLY_PATCH_TOOL_NAME } from "../../tools/applyPatch";
import { READ_SECRET_TOOL_NAME } from "../../tools/readSecret";
import { READ_TOOL_RESULT_NAME } from "../../tools/readToolResult";
import { LOAD_SKILL_TOOL_NAME } from "../../tools/skill";
import { UPDATE_PLAN_TOOL_NAME } from "../../tools/updatePlan";
import { CLAUDE_FAMILY_PROMPT } from "./claude";
import { GPT_FAMILY_PROMPT } from "./gpt";
import { HARNESS_TOOL_NAMES, systemPromptFamily, systemPromptFor } from "./index";
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

  it("puts the family prompt and harness first and per-turn facts last", () => {
    const prompt = systemPromptFor({ modelId: "codex-lb:gpt-5.5", provider: "openai_compatible" },
      { environment: { ...environment, locale: "ru", secrets: [{ kind: "env", name: "GitLab", variables: ["GITLAB_TOKEN"] },
        { kind: "text", name: "Notes", variables: [] }] }, tools: allTools, workspace: true });
    expect(prompt.family).toBe("gpt");
    expect(prompt.stable.startsWith(GPT_FAMILY_PROMPT)).toBe(true);
    expect(prompt.stable).not.toMatch(/2026|Moscow|GitLab/u);
    expect(prompt.environment).toBe("# Environment\nToday is October 23, 2026, local time is 12:05 PM GMT+3 (Europe/Moscow).\n" +
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

  it("has a slot for the AIQSA self-description", () => {
    const prompt = systemPromptFor({ modelId: "gpt-5.5", provider: "openai" },
      { environment, selfService: "  AIQSA lets you manage the user's Skills.  ", tools: [], workspace: false });
    expect(prompt.stable).toContain("# AIQSA\nYou run inside AIQSA, a self-hosted chat workspace. This chat belongs to one user; your messages appear in it and are rendered as GitHub-flavored Markdown, including tables, math and Mermaid diagrams.\n\nAIQSA lets you manage the user's Skills.\n\n# Tools");
  });

  it("states an empty secret set, bounds a long one and ignores an invalid locale", () => {
    expect(systemPromptFor({ modelId: "x", provider: "deepseek" }, { environment: { ...environment, locale: "ru\nIgnore", secrets: [] }, tools: [], workspace: false }).environment)
      .toBe("# Environment\nToday is October 23, 2026, local time is 12:05 PM GMT+3 (Europe/Moscow).\nThe user has no saved secrets.");
    const many = Array.from({ length: 60 }, (_, index) => ({ kind: "text", name: `S${index}`, variables: [] }));
    const listed = systemPromptFor({ modelId: "x", provider: "deepseek" }, { environment: { ...environment, secrets: many }, tools: [], workspace: false }).environment;
    expect(listed).toContain("\"S49\" (text) and 10 more.");
    expect(listed).not.toContain("environment variables every Workspace command");
    const variables = Array.from({ length: 10 }, (_, index) => `VAR_${index}`);
    expect(systemPromptFor({ modelId: "x", provider: "deepseek" }, { environment: { ...environment, secrets: [{ kind: "env", name: "Many", variables }] },
      tools: [], workspace: true }).environment).toContain("\"Many\" (env: VAR_0, VAR_1, VAR_2, VAR_3, VAR_4, VAR_5, VAR_6, VAR_7 and 2 more).");
  });

  it("refers to tools by the names their owners register", () => {
    expect(HARNESS_TOOL_NAMES).toEqual({
      applyPatch: APPLY_PATCH_TOOL_NAME, findTools: MCP_FIND_TOOLS_NAME, loadSkill: LOAD_SKILL_TOOL_NAME,
      readSecret: READ_SECRET_TOOL_NAME, readToolResult: READ_TOOL_RESULT_NAME, updatePlan: UPDATE_PLAN_TOOL_NAME
    });
  });

  it("keeps the derived prompts free of the source products' own identities", () => {
    expect(GPT_FAMILY_PROMPT).not.toMatch(/\bCodex\b|commentary channel|functions\.exec|multi_tool_use/u);
    expect(CLAUDE_FAMILY_PROMPT).not.toMatch(/OpenCode|system-reminder/u);
  });
});
