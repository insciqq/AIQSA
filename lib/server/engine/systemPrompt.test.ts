// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import { VISIBLE_ANSWER_CONTRACT, resolveAssistantChatBaseline, resolveStandardChatBaseline } from "@/lib/domain/promptTemplates";
import type { ProviderRunRequest } from "../providers/types";
import type { RunSecretSource } from "../workspace/secrets/runSecrets";
import { GPT_FAMILY_PROMPT } from "./prompts/gpt";
import { environmentPromptSection } from "./prompts/harness";
import { NEUTRAL_FAMILY_PROMPT } from "./prompts/neutral";
import { admittedRunGuidance, withNativeSystemPrompt } from "./systemPrompt";

const admittedAt = new Date("2026-10-23T06:00:00Z");
const now = new Date("2026-10-23T09:05:00Z");
const zone = "Europe/Moscow";
const standard = resolveStandardChatBaseline({ now: admittedAt, timeZone: zone });
const guidance = "A Workspace is available in this chat.\nWorking directory: /workspace/project";
const mcpIndex = "MCP servers you can search with find_tools:\n- Jira";

function request(system: string | null, extra: Partial<ProviderRunRequest> = {}): ProviderRunRequest {
  return {
    attachmentIds: [], attachments: [], chatId: "chat-1", content: { blocks: [] },
    knowledgePlan: { baseIds: [], mode: "none", sourceIds: [], version: 1 },
    modelCapabilities: { nativePdfInput: false, nativeSearch: false, pdf: false, reasoning: true, toolCalling: true, vision: false },
    modelId: "codex-lb:gpt-6-sol", params: {},
    prompt: { baseline: { source: "standard_chat", timeZone: zone, timeZoneSource: "client" }, developer: VISIBLE_ANSWER_CONTRACT,
      personalInstructions: "Answer like a pirate.", system },
    provider: "openai_compatible", searchPlan: { mode: "all_selected", options: [] }, toolMode: "auto", ...extra
  };
}

const gpt = { model: { upstreamModelId: "gpt-6-sol" }, providerFamily: "openai_compatible" };
const source = (list: RunSecretSource["list"]): RunSecretSource => ({ list: vi.fn(list), read: vi.fn() });
const scope = { runId: "run-1", userId: "user-1" };
const tools = (...names: string[]) => names.map((name) => ({ name }));

describe("admitted run guidance", () => {
  it("drops only the old core's baseline sentence and keeps everything admission added after it", () => {
    expect(admittedRunGuidance(request(`${standard.renderedSystemPrompt}\n\n${guidance}\n\n${mcpIndex}`).prompt)).toBe(`${guidance}\n\n${mcpIndex}`);
    expect(admittedRunGuidance(request(standard.renderedSystemPrompt).prompt)).toBe("");
    // An Assistant's own instructions follow its date sentence, and stay.
    const assistant = resolveAssistantChatBaseline({ now: admittedAt, timeZone: zone });
    expect(admittedRunGuidance({ ...request(`${assistant.renderedSystemPrompt}\n\nYou are Ada, a travel planner.`).prompt,
      baseline: { source: "assistant_chat", timeZone: zone, timeZoneSource: "client" } })).toBe("You are Ada, a travel planner.");
    // Anything else is the run's own and stays whole.
    expect(admittedRunGuidance(request(`${guidance}\n\n${mcpIndex}`).prompt)).toBe(`${guidance}\n\n${mcpIndex}`);
    expect(admittedRunGuidance({ ...request(`${standard.renderedSystemPrompt}\n\n${guidance}`).prompt, baseline: undefined }))
      .toBe(`${standard.renderedSystemPrompt}\n\n${guidance}`);
    expect(admittedRunGuidance(request(null).prompt)).toBe("");
  });
});

describe("native system prompt", () => {
  it("puts the family prompt and harness first, the run's guidance next and the environment last", async () => {
    const secrets = source(async () => [{ description: "", envNames: [], kind: "text", name: "GitLab", valueId: "v1" }]);
    const admitted = request(`${standard.renderedSystemPrompt}\n\n${guidance}\n\n${mcpIndex}`,
      { workspace: { enabled: true } as ProviderRunRequest["workspace"] });
    const native = await withNativeSystemPrompt({ now, request: admitted, scope, secrets, snapshot: gpt,
      tools: tools("read_tool_result", "update_plan", "read_secret", "manage_secret") });
    const system = native.prompt.system!;
    const environment = environmentPromptSection({ now, secretNames: ["GitLab"], timeZone: zone });
    expect(system.startsWith(`${GPT_FAMILY_PROMPT}\n\n# AIQSA`)).toBe(true);
    expect(system.endsWith(`${guidance}\n\n${mcpIndex}\n\n${environment}`)).toBe(true);
    expect(system).toContain("# Workspace");
    expect(system).toContain("`update_plan`");
    expect(system).toContain("`manage_secret`");
    expect(system).not.toContain("You are a helpful AI assistant.");
    expect(system.indexOf("# Environment")).toBeGreaterThan(system.indexOf(mcpIndex));
    expect(environment).toContain(`(${zone})`);
    expect(environment).toContain('Saved secrets: "GitLab".');
    expect(secrets.list).toHaveBeenCalledWith(scope);
    // Presets, answer rules and the baseline evidence keep their places.
    expect(native.prompt).toMatchObject({ baseline: admitted.prompt.baseline, developer: VISIBLE_ANSWER_CONTRACT,
      personalInstructions: "Answer like a pirate." });
    expect(native).toMatchObject({ modelId: admitted.modelId, workspace: admitted.workspace });
  });

  it("is the same text on every request of a run, so provider caches reuse it", async () => {
    const admitted = request(`${standard.renderedSystemPrompt}\n\n${guidance}`);
    const secrets = source(async () => []);
    const first = await withNativeSystemPrompt({ now, request: admitted, scope, secrets, snapshot: gpt, tools: tools("read_secret") });
    const again = await withNativeSystemPrompt({ now, request: admitted, scope, secrets, snapshot: gpt, tools: tools("read_secret") });
    expect(again.prompt.system).toBe(first.prompt.system);
    expect(first.prompt.system).toContain("The user has no saved secrets.");
  });

  it("names saved secrets only where read_secret is offered, and goes without them when they cannot be read", async () => {
    const admitted = request(standard.renderedSystemPrompt);
    const unused = source(async () => [{ description: "", envNames: [], kind: "text", name: "GitLab", valueId: "v1" }]);
    const without = await withNativeSystemPrompt({ now, request: admitted, scope, secrets: unused, snapshot: gpt, tools: tools("update_plan") });
    expect(unused.list).not.toHaveBeenCalled();
    expect(without.prompt.system).not.toMatch(/saved secrets/iu);
    const failing = source(async () => { throw new Error("database unavailable"); });
    const degraded = await withNativeSystemPrompt({ now, request: admitted, scope, secrets: failing, snapshot: gpt, tools: tools("read_secret") });
    expect(degraded.prompt.system).toContain("# Environment");
    expect(degraded.prompt.system).not.toMatch(/Saved secrets|no saved secrets/u);
  });

  it("follows the admitted route's model family and zone", async () => {
    const neutral = await withNativeSystemPrompt({ now, request: request(null, { modelId: "gemini-3-pro", prompt: { developer: null, system: null } }), scope,
      snapshot: { model: { upstreamModelId: "gemini-3-pro" }, providerFamily: "gemini" }, tools: [] });
    expect(neutral.prompt.system!.startsWith(NEUTRAL_FAMILY_PROMPT)).toBe(true);
    // A request without baseline evidence reads the date in the recorded fallback zone.
    expect(neutral.prompt.system).toContain("(UTC)");
    expect(neutral.prompt.system).not.toContain("# Workspace");
  });
});
