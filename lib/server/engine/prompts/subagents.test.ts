// @vitest-environment node
import { describe, expect, it } from "vitest";
import { CALL_SUBAGENT_TOOL_NAME } from "@/lib/contracts/subagents";
import { WORKSPACE_WEBSITE_ACTION_SAFETY } from "@/lib/server/workspace/browserGuidance";
import { SUBAGENT_ROLE_SECTION, subagentTurnText, systemPromptFor } from "./index";

const environment = { now: new Date("2026-10-30T09:00:00Z"), timeZone: "Europe/Madrid" };
const model = { modelId: "codex-lb:gpt-6-sol", provider: "openai_compatible" };

describe("sub-agent prompts", () => {
  it("guide the main agent only when call_subagent is offered, listing the frozen models and custom types", () => {
    const facts = { models: [{ efforts: ["low", "medium"], id: "gpt-6-luna", name: "GPT-6 Luna" }],
      types: [{ description: "Browses shops\nthoroughly.", name: "browser" }] };
    const offered = systemPromptFor(model, { environment, subagents: facts, tools: [CALL_SUBAGENT_TOOL_NAME], workspace: true }).stable;
    expect(offered).toContain("# Sub-agents");
    expect(offered).toContain("\"gpt-6-luna\" (GPT-6 Luna; effort: low, medium)");
    expect(offered).toContain("\"browser\": Browses shops thoroughly.");
    expect(systemPromptFor(model, { environment, subagents: facts, tools: [], workspace: true }).stable).not.toContain("# Sub-agents");
  });

  it("give a sub-agent its role in place of the AIQSA self-description, stable across turns", () => {
    const sub = systemPromptFor(model, { environment, selfService: SUBAGENT_ROLE_SECTION, tools: ["load_skill"], workspace: true }).stable;
    expect(sub).toContain(SUBAGENT_ROLE_SECTION);
    expect(sub).not.toContain("Besides chats, the user keeps their own resources in Studio");
    expect(SUBAGENT_ROLE_SECTION).toContain(WORKSPACE_WEBSITE_ACTION_SAFETY);
  });

  it("put the user's message verbatim after the brief", () => {
    const text = subagentTurnText({ brief: "Order the cheapest.", continued: false, userMessage: "Compare prices only, don't buy." });
    expect(text).toBe("<main_agent_brief>\nOrder the cheapest.\n</main_agent_brief>\n\nThe user's current message in the chat, verbatim. " +
      "It is the only authority for irreversible actions:\n<user_message>\nCompare prices only, don't buy.\n</user_message>");
  });
});
