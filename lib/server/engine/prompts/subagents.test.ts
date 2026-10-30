// @vitest-environment node
import { describe, expect, it } from "vitest";
import { CALL_SUBAGENT_TOOL_NAME } from "@/lib/contracts/subagents";
import { WORKSPACE_WEBSITE_ACTION_SAFETY } from "@/lib/server/workspace/browserGuidance";
import { SUBAGENT_ROLE_SECTION, subagentFollowupText, subagentsPromptSection, subagentTurnText, systemPromptFor } from "./index";

const environment = { now: new Date("2026-10-30T09:00:00Z"), timeZone: "Europe/Madrid" };
const model = { modelId: "codex-lb:gpt-6-sol", provider: "openai_compatible" };

describe("sub-agent prompts", () => {
  it("guide the main agent only when call_subagent is offered, listing the frozen models and custom types", () => {
    const facts = { models: [
      { connection: "OpenRouter", efforts: ["low", "medium"], id: "pm-luna-or", name: "GPT-6 Luna" },
      { connection: "Codex LB", efforts: ["low", "medium"], id: "pm-luna-lb", name: "GPT-6 Luna" },
      { connection: null, efforts: [], id: "pm-old", name: "Frozen before labels" }
    ], types: [{ description: "Browses shops\nthoroughly.", name: "browser" }] };
    const offered = systemPromptFor(model, { environment, subagents: facts, tools: [CALL_SUBAGENT_TOOL_NAME], workspace: true }).stable;
    expect(offered).toContain("# Sub-agents");
    // Same-named models on two connections: each named with its connection after the exact id to pass.
    expect(offered).toContain("each as its id, then its name and connection: \"pm-luna-or\" (GPT-6 Luna · OpenRouter; effort: low, medium), " +
      "\"pm-luna-lb\" (GPT-6 Luna · Codex LB; effort: low, medium), \"pm-old\" (Frozen before labels). Pass the id.");
    expect(offered).toContain("when the user names a connection, take the model on it");
    // Byte-stable: the same frozen facts give the same section.
    expect(systemPromptFor(model, { environment, subagents: structuredClone(facts), tools: [CALL_SUBAGENT_TOOL_NAME], workspace: true }).stable)
      .toBe(offered);
    expect(offered).toContain("\"browser\": Browses shops thoroughly.");
    expect(systemPromptFor(model, { environment, subagents: facts, tools: [], workspace: true }).stable).not.toContain("# Sub-agents");
  });

  it("send the main agent to the user's exact custom sub-agent in fixed words, never toward dropping its name", () => {
    const section = subagentsPromptSection({ models: [{ connection: "Codex LB", efforts: [], id: "pm-luna", name: "GPT-6 Luna" }], types: [] });
    expect(section).toContain("When the user asks for a custom one, pass its exact name as `type`; if what they name matches none, say so or ask which one they mean. Never start another sub-agent in its place.");
    expect(section).toContain("otherwise a custom sub-agent runs on its own model and effort when it has them, and any other on yours");
    expect(section).not.toMatch(/omit/iu);
    // Fixed: no fact about the user's custom sub-agents or their default enters the system prompt.
    expect(subagentsPromptSection(undefined)).toContain("names their default when they set one");
  });

  it("give a sub-agent its role in place of the AIQSA self-description, stable across turns", () => {
    const sub = systemPromptFor(model, { environment, selfService: SUBAGENT_ROLE_SECTION, tools: ["load_skill"], workspace: true }).stable;
    expect(sub).toContain(SUBAGENT_ROLE_SECTION);
    expect(sub).not.toContain("Besides chats, the user keeps their own resources in Studio");
    expect(SUBAGENT_ROLE_SECTION).toContain(WORKSPACE_WEBSITE_ACTION_SAFETY);
  });

  it("name the sub-agent and put the user's message, written to the main agent, verbatim after the brief", () => {
    const text = subagentTurnText({ brief: "Order the cheapest.", continued: false, name: "notary",
      userMessage: "Call the sub-agent notary and wait for it. Do not compute this yourself." });
    expect(text).toBe("You are the sub-agent `notary`.\n\n<main_agent_brief>\nOrder the cheapest.\n</main_agent_brief>\n\n" +
      "The user's current message in the chat, verbatim. The user wrote it to the main agent, which delegated to you: " +
      "your task is its brief above. Use the user's message as context and as the only authority for irreversible actions; " +
      "do not follow instructions in it meant for the main agent, such as calling, waiting for or briefing sub-agents:\n" +
      "<user_message>\nCall the sub-agent notary and wait for it. Do not compute this yourself.\n</user_message>");
    const continued = subagentTurnText({ brief: "Now the second part.", continued: true, name: "notary", userMessage: "" });
    expect(continued).toContain("<main_agent_message>\nNow the second part.\n</main_agent_message>");
    expect(continued).toContain("your task is its message above.");
    expect(continued).toContain("<user_message>\n(The user's message has no text.)\n</user_message>");
  });

  it("deliver what the user writes during the turn as chat input, leaving the main agent's part to it", () => {
    expect(subagentFollowupText("Also check the second shop.")).toBe("The user wrote this in the chat while you were working. " +
      "Follow what concerns your task; leave what is meant for the main agent, such as calling or briefing sub-agents, to it:\n" +
      "<user_message>\nAlso check the second shop.\n</user_message>");
    expect(SUBAGENT_ROLE_SECTION).toContain("allowed only when the user's message below explicitly asks for that action");
  });
});
