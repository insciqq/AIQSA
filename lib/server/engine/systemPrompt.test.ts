// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import { VISIBLE_ANSWER_CONTRACT, resolveAssistantChatBaseline, resolveStandardChatBaseline } from "@/lib/domain/promptTemplates";
import type { ProviderRunRequest } from "../providers/types";
import type { RunSecretSource } from "../workspace/secrets/runSecrets";
import { GPT_FAMILY_PROMPT } from "./prompts/gpt";
import { environmentPromptSection } from "./prompts/harness";
import { NEUTRAL_FAMILY_PROMPT } from "./prompts/neutral";
import { admittedRunGuidance, splitTurnGuidance, withNativeSystemPrompt } from "./systemPrompt";

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

  it("takes out each part recorded as the turn's where it stands whole, in order, and only those", () => {
    const output = "This turn's output directory: /workspace/outputs/run-1.";
    const intent = "The user explicitly asked for an artifact: call create_artifact for this message.";
    // First, between others, and last, with the separators around them.
    expect(splitTurnGuidance(`${output}\n\n${guidance}\n\n${intent}\n\n${mcpIndex}\n\nLast.`, [output, intent, "Last."]))
      .toEqual({ chat: `${guidance}\n\n${mcpIndex}`, turn: [output, intent, "Last."] });
    expect(splitTurnGuidance(output, [output])).toEqual({ chat: "", turn: [output] });
    // A part that is no whole paragraph there, or not there at all (a system prompt replaced since), is neither cut nor sent twice.
    expect(splitTurnGuidance(`${guidance}\n\nNote: ${output}`, [output, "Gone."]))
      .toEqual({ chat: `${guidance}\n\nNote: ${output}`, turn: [] });
    // A part appears where admission appended it: after the one before.
    expect(splitTurnGuidance(`Same.\n\n${guidance}\n\nSame.`, [guidance, "Same."])).toEqual({ chat: "Same.", turn: [guidance, "Same."] });
    expect(splitTurnGuidance(guidance, undefined)).toEqual({ chat: guidance, turn: [] });
  });
});

describe("native system prompt", () => {
  it("puts the family prompt and harness first, the run's guidance next and the environment last", async () => {
    const secrets = source(async () => [{ byteSize: 40, description: "", envNames: [], kind: "text", name: "GitLab", valueId: "v1" }]);
    const admitted = request(`${standard.renderedSystemPrompt}\n\n${guidance}\n\n${mcpIndex}`,
      { workspace: { enabled: true } as ProviderRunRequest["workspace"] });
    const native = await withNativeSystemPrompt({ now, request: admitted, scope, secrets, snapshot: gpt,
      tools: tools("read_tool_result", "update_plan", "read_secret", "manage_secret") });
    const system = native.request.prompt.system!;
    const environment = environmentPromptSection({ now, secrets: [{ kind: "text", name: "GitLab", variables: [] }], timeZone: zone });
    expect(system.startsWith(`${GPT_FAMILY_PROMPT}\n\n# AIQSA`)).toBe(true);
    expect(system.endsWith(`${guidance}\n\n${mcpIndex}\n\n${environment}`)).toBe(true);
    expect(system).toContain("# Workspace");
    expect(system).toContain("`update_plan`");
    expect(system).toContain("`manage_secret`");
    expect(system).not.toContain("You are a helpful AI assistant.");
    expect(system.indexOf("# Environment")).toBeGreaterThan(system.indexOf(mcpIndex));
    expect(environment).toBe(`# Environment\nToday is October 23, 2026 in the user's time zone (${zone}).\nSaved secrets: "GitLab" (text).`);
    expect(secrets.list).toHaveBeenCalledWith(scope);
    // Presets, answer rules and the baseline evidence keep their places.
    expect(native.request.prompt).toMatchObject({ baseline: admitted.prompt.baseline, developer: VISIBLE_ANSWER_CONTRACT,
      personalInstructions: "Answer like a pirate." });
    expect(native.request).toMatchObject({ modelId: admitted.modelId, workspace: admitted.workspace });
    expect(native.turnContext).toBe(`<turn_context>\nCurrent local time: 12:05 PM GMT+3 (${zone}).\n</turn_context>`);
  });

  it("stays the same across a day's turns of a chat; the time and each turn's own guidance go with the turn", async () => {
    const secrets = source(async () => [{ byteSize: 40, description: "", envNames: [], kind: "text", name: "GitLab", valueId: "v1" }]);
    const offered = tools("read_tool_result", "update_plan", "read_secret");
    // Two runs of one chat: admitted at different times, each with its own output directory, the second editing an artifact.
    const turn = async (at: string, parts: readonly string[]) => {
      const started = new Date(at);
      const baseline = resolveStandardChatBaseline({ now: started, timeZone: zone }).renderedSystemPrompt;
      const system = [baseline, guidance, parts[0], mcpIndex, ...parts.slice(1)].join("\n\n");
      const admitted = request(null, { prompt: { ...request(null).prompt, system, turnGuidance: parts } });
      return await withNativeSystemPrompt({ now: started, request: admitted, scope, secrets, snapshot: gpt, tools: offered });
    };
    const morning = await turn("2026-10-23T06:05:00Z", ["This turn's output directory: /workspace/outputs/run-1."]);
    const evening = await turn("2026-10-23T17:40:00Z", ["This turn's output directory: /workspace/outputs/run-2.",
      "The user's current message edits artifact_id=\"a-1\" from base_version_id=\"v-3\"."]);

    expect(evening.request.prompt.system).toBe(morning.request.prompt.system);
    expect(morning.request.prompt.system).toContain(`Today is October 23, 2026 in the user's time zone (${zone}).`);
    expect(morning.request.prompt.system).toContain(`${guidance}\n\n${mcpIndex}`);
    expect(morning.request.prompt.system).not.toMatch(/9:05|8:40|outputs\/run-|artifact_id/u);
    expect(morning.request.prompt).not.toHaveProperty("turnGuidance");
    expect(morning.turnContext).toBe(`<turn_context>\nCurrent local time: 09:05 AM GMT+3 (${zone}).\n\n` +
      "This turn's output directory: /workspace/outputs/run-1.\n</turn_context>");
    expect(evening.turnContext).toBe(`<turn_context>\nCurrent local time: 08:40 PM GMT+3 (${zone}).\n\n` +
      "This turn's output directory: /workspace/outputs/run-2.\n\n" +
      "The user's current message edits artifact_id=\"a-1\" from base_version_id=\"v-3\".\n</turn_context>");
    // A new day changes only the date.
    const tomorrow = await turn("2026-10-24T06:05:00Z", ["This turn's output directory: /workspace/outputs/run-3."]);
    expect(tomorrow.request.prompt.system).toBe(morning.request.prompt.system!.replace("October 23, 2026", "October 24, 2026"));
  });

  it("keeps a request admitted before turn guidance was recorded as it was", async () => {
    const output = "This turn's output directory: /workspace/outputs/run-1.";
    const native = await withNativeSystemPrompt({ now, request: request(`${standard.renderedSystemPrompt}\n\n${guidance}\n\n${output}`),
      scope, snapshot: gpt, tools: [] });
    expect(native.request.prompt.system).toContain(`${guidance}\n\n${output}`);
    expect(native.turnContext).toBe(`<turn_context>\nCurrent local time: 12:05 PM GMT+3 (${zone}).\n</turn_context>`);
  });

  it("is the same text on every request of a run, so provider caches reuse it", async () => {
    const admitted = request(`${standard.renderedSystemPrompt}\n\n${guidance}`);
    const secrets = source(async () => []);
    const first = await withNativeSystemPrompt({ now, request: admitted, scope, secrets, snapshot: gpt, tools: tools("read_secret") });
    const again = await withNativeSystemPrompt({ now, request: admitted, scope, secrets, snapshot: gpt, tools: tools("read_secret") });
    expect(again.request.prompt.system).toBe(first.request.prompt.system);
    expect(first.request.prompt.system).toContain("The user has no saved secrets.");
  });

  it("names the variables each secret gives Workspace commands, as the guest derives them, only in a run with a Workspace", async () => {
    // The run's admitted revisions: an env secret, a text secret named like a variable, a text secret that is not one,
    // and a text secret whose variable the env secret already sets.
    const secrets = source(async () => [
      { byteSize: 120, description: "", envNames: ["GITLAB_TOKEN", "GITLAB_HOST"], kind: "env", name: "GitLab", valueId: "v1" },
      { byteSize: 48, description: "", envNames: [], kind: "text", name: "DEMO_API_TOKEN", valueId: "v2" },
      { byteSize: 30, description: "", envNames: [], kind: "text", name: "Notes", valueId: "v3" },
      { byteSize: 48, description: "", envNames: [], kind: "text", name: "GITLAB_TOKEN", valueId: "v4" }
    ]);
    const withWorkspace = await withNativeSystemPrompt({ now, request: request(null, { workspace: { enabled: true } as ProviderRunRequest["workspace"] }),
      scope, secrets, snapshot: gpt, tools: tools("read_secret") });
    expect(withWorkspace.request.prompt.system).toContain('Saved secrets: "GitLab" (env: GITLAB_TOKEN, GITLAB_HOST), "DEMO_API_TOKEN" (text: DEMO_API_TOKEN), ' +
      '"Notes" (text), "GITLAB_TOKEN" (text).\nAfter a secret\'s kind come the environment variables every Workspace command gets from it.');
    expect(withWorkspace.request.prompt.system).toContain("a text secret named like a variable (capitals, digits and underscores) under that name");
    const without = await withNativeSystemPrompt({ now, request: request(null), scope, secrets, snapshot: gpt, tools: tools("read_secret") });
    expect(without.request.prompt.system).toContain('Saved secrets: "GitLab" (env), "DEMO_API_TOKEN" (text), "Notes" (text), "GITLAB_TOKEN" (text).');
    expect(without.request.prompt.system).not.toMatch(/environment variables every Workspace command|# Workspace/u);
  });

  it("names saved secrets only where read_secret is offered, and goes without them when they cannot be read", async () => {
    const admitted = request(standard.renderedSystemPrompt);
    const unused = source(async () => [{ byteSize: 40, description: "", envNames: [], kind: "text", name: "GitLab", valueId: "v1" }]);
    const without = await withNativeSystemPrompt({ now, request: admitted, scope, secrets: unused, snapshot: gpt, tools: tools("update_plan") });
    expect(unused.list).not.toHaveBeenCalled();
    expect(without.request.prompt.system).not.toMatch(/saved secrets/iu);
    const failing = source(async () => { throw new Error("database unavailable"); });
    const degraded = await withNativeSystemPrompt({ now, request: admitted, scope, secrets: failing, snapshot: gpt, tools: tools("read_secret") });
    expect(degraded.request.prompt.system).toContain("# Environment");
    expect(degraded.request.prompt.system).not.toMatch(/Saved secrets|no saved secrets/u);
  });

  it("follows the admitted route's model family and zone", async () => {
    const neutral = await withNativeSystemPrompt({ now, request: request(null, { modelId: "gemini-3-pro", prompt: { developer: null, system: null } }), scope,
      snapshot: { model: { upstreamModelId: "gemini-3-pro" }, providerFamily: "gemini" }, tools: [] });
    expect(neutral.request.prompt.system!.startsWith(NEUTRAL_FAMILY_PROMPT)).toBe(true);
    // A request without baseline evidence reads the date and the time in the recorded fallback zone.
    expect(neutral.request.prompt.system).toContain("(UTC)");
    expect(neutral.turnContext).toContain("Current local time: 09:05 AM UTC (UTC).");
    expect(neutral.request.prompt.system).not.toContain("# Workspace");
  });
});
