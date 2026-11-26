import { describe, expect, it } from "vitest";
import {
  buildTelegramSendBody, resolveTelegramModel, telegramRunControls, telegramSearchEnabled, type TelegramSendSettings
} from "./body";
import { fakeCatalog, fakeCatalogModel, SEARCH_OPTION } from "@/tests/support/telegramChatBridge";

const SETTINGS: TelegramSendSettings = { searchEnabled: true };
const TEXT = [{ text: "Compare X and Y as a table", type: "text" as const }];

describe("Telegram send body", () => {
  it("names every catalog value of an ordinary first message explicitly", () => {
    const catalog = fakeCatalog({ defaults: { mcpMode: "load_all", skillsMode: "off" } });
    const body = buildTelegramSendBody({
      admissionId: "tg-1-77", catalog, content: TEXT, model: catalog.models[0]!, settings: SETTINGS,
      target: { assistantId: null, kind: "new" }, workspaceOffered: true
    });
    expect(body).toEqual({
      admissionId: "tg-1-77",
      content: { blocks: TEXT },
      controlDefaults: {},
      expectedActiveLeafId: null,
      mcp: { mode: "load_all" },
      modelId: "model-fake",
      params: { maxOutputTokens: 1_024, reasoning: { effort: "none" }, temperature: 0.7 },
      personalDraft: { folderId: null, memoryMode: "NORMAL" },
      provider: "connection-fake",
      searchEnabled: true,
      skills: { mode: "off" },
      workspace: { enabled: true }
    });
  });

  it("continues an existing chat at its leaf and carries a server continuation turn", () => {
    const catalog = fakeCatalog();
    const body = buildTelegramSendBody({
      admissionId: "tg-1-78", catalog, content: [], model: catalog.models[0]!, settings: SETTINGS,
      systemTurn: { approvalId: "approval-1", kind: "mcp_approval_continuation" },
      target: { activeLeafMessageId: "answer-9", assistantBound: false, kind: "existing" }, workspaceOffered: true
    });
    expect(body).toMatchObject({ expectedActiveLeafId: "answer-9", systemTurn: { approvalId: "approval-1", kind: "mcp_approval_continuation" } });
    expect(body).not.toHaveProperty("personalDraft");
  });

  it("uses the saved controls the model supports as params and keeps the model's default for the rest", () => {
    const catalog = fakeCatalog({
      defaults: { controlValues: { "connection-fake:model-fake": { maxOutputTokens: "2048", reasoningEffort: "high", temperature: "1.2" } } }
    });
    expect(telegramRunControls(catalog, catalog.models[0]!)).toEqual({
      controlDefaults: { maxOutputTokens: "2048", temperature: "1.2" },
      params: { maxOutputTokens: 2_048, reasoning: { effort: "none" }, temperature: 1.2 }
    });
    // A dialect the controls cannot be materialized for leaves the model's own defaults to the server.
    const odd = fakeCatalogModel({ parameterDialect: "unknown-dialect" });
    expect(telegramRunControls(fakeCatalog({ models: [odd] }), odd)).toBeNull();
    const body = buildTelegramSendBody({
      admissionId: "tg-1-79", catalog: fakeCatalog({ models: [odd] }), content: TEXT, model: odd, settings: SETTINGS,
      target: { assistantId: null, kind: "new" }, workspaceOffered: true
    });
    expect(body).not.toHaveProperty("params");
    expect(body).toMatchObject({ modelId: odd.modelId, searchEnabled: true });
  });

  it("sends Search on while the link and the user's Chat defaults keep it on, whatever the model", () => {
    const turnedOff = fakeCatalog({ defaults: { searchPlan: { mode: "all_selected", optionIds: [] } } });
    const on = fakeCatalog({ defaults: { searchPlan: { mode: "all_selected", optionIds: [SEARCH_OPTION.strategyId] } } });
    expect(telegramSearchEnabled(on, false)).toBe(false);
    // A default turned off in Chat defaults stays off.
    expect(telegramSearchEnabled(turnedOff, true)).toBe(false);
    expect(telegramSearchEnabled(on, true)).toBe(true);
    // A model the catalog lists without Search still asks for it: the server names why it cannot search.
    const modelWithout = fakeCatalogModel({ searchStrategyIds: [] });
    expect(buildTelegramSendBody({
      admissionId: "tg-1-82", catalog: on, content: TEXT, model: modelWithout, settings: SETTINGS,
      target: { assistantId: null, kind: "new" }, workspaceOffered: true
    })).toMatchObject({ searchEnabled: true });
    const off = buildTelegramSendBody({
      admissionId: "tg-1-80", catalog: on, content: TEXT, model: on.models[0]!, settings: { ...SETTINGS, searchEnabled: false },
      target: { assistantId: null, kind: "new" }, workspaceOffered: true
    });
    expect(off.searchEnabled).toBe(false);
    expect(off).not.toHaveProperty("searchPlan");
  });

  it("asks for the Workspace as the web composer does: always, except where it is not offered or the model calls no tools", () => {
    const plain = fakeCatalogModel({ capabilities: { ...fakeCatalogModel().capabilities, toolCalling: false } });
    expect(buildTelegramSendBody({
      admissionId: "a", catalog: fakeCatalog({ models: [plain] }), content: TEXT, model: plain,
      settings: SETTINGS, target: { assistantId: null, kind: "new" }, workspaceOffered: true
    })).toMatchObject({ tools: "none", workspace: { enabled: false, reason: "model_no_tools" } });

    const tooling = buildTelegramSendBody({
      admissionId: "c", catalog: fakeCatalog(), content: TEXT, model: fakeCatalogModel(),
      settings: SETTINGS, target: { assistantId: null, kind: "new" }, workspaceOffered: true
    });
    expect(tooling).not.toHaveProperty("agentEnabled");
    expect(tooling).not.toHaveProperty("tools");
    expect(tooling.workspace).toEqual({ enabled: true });

    // An installation that does not offer it names that first, as the composer does.
    for (const model of [plain, fakeCatalogModel()]) {
      expect(buildTelegramSendBody({
        admissionId: "d", catalog: fakeCatalog({ models: [model] }), content: TEXT, model,
        settings: SETTINGS, target: { assistantId: null, kind: "new" }, workspaceOffered: false
      }).workspace).toEqual({ enabled: false, reason: "installation_disabled" });
    }
  });

  it("lets an Assistant govern its rows: only the binding, the Workspace and the turn travel", () => {
    const catalog = fakeCatalog();
    const first = buildTelegramSendBody({
      admissionId: "tg-1-81", catalog, content: TEXT, model: null, settings: SETTINGS,
      target: { assistantId: "assistant-1", kind: "new" }, workspaceOffered: true
    });
    expect(first).toEqual({
      admissionId: "tg-1-81", assistantId: "assistant-1", content: { blocks: TEXT }, expectedActiveLeafId: null,
      personalDraft: { folderId: null, memoryMode: "NORMAL" }, workspace: { enabled: true }
    });
    const bound = buildTelegramSendBody({
      admissionId: "tg-1-82", catalog, content: TEXT, model: catalog.models[0]!, settings: SETTINGS,
      target: { activeLeafMessageId: "answer-3", assistantBound: true, kind: "existing" }, workspaceOffered: false
    });
    expect(Object.keys(bound).sort()).toEqual(["admissionId", "content", "expectedActiveLeafId", "workspace"]);
    expect(bound.workspace).toEqual({ enabled: false, reason: "installation_disabled" });
  });
});

describe("Telegram send body time zone", () => {
  it("sends the user's browser zone in ordinary and Assistant chats, and omits it when none is known", () => {
    const catalog = fakeCatalog();
    const ordinary = { admissionId: "tg-1-90", catalog, content: TEXT, model: catalog.models[0]!, settings: SETTINGS,
      target: { assistantId: null, kind: "new" }, workspaceOffered: true } as const;
    expect(buildTelegramSendBody({ ...ordinary, timeZone: "Europe/Moscow" })).toMatchObject({ timeZone: "Europe/Moscow" });
    expect(buildTelegramSendBody({ ...ordinary, timeZone: null })).not.toHaveProperty("timeZone");
    expect(buildTelegramSendBody(ordinary)).not.toHaveProperty("timeZone");

    const assistant = { ...ordinary, model: null, target: { activeLeafMessageId: "answer-3", assistantBound: true, kind: "existing" } } as const;
    const bound = buildTelegramSendBody({ ...assistant, timeZone: "Asia/Tokyo" });
    expect(Object.keys(bound).sort()).toEqual(["admissionId", "content", "expectedActiveLeafId", "timeZone", "workspace"]);
    expect(bound.timeZone).toBe("Asia/Tokyo");
    expect(buildTelegramSendBody(assistant)).not.toHaveProperty("timeZone");
  });
});

describe("Telegram model choice", () => {
  const second = fakeCatalogModel({ displayName: "Second", modelId: "model-second", provider: "connection-second" });
  const catalog = fakeCatalog({ models: [fakeCatalogModel(), second] });

  it("prefers the link's choice, then the chat's model, then the catalog default", () => {
    expect(resolveTelegramModel(catalog, { chatModel: null, selected: { modelId: "model-second", provider: "connection-second" } }))
      .toEqual({ model: second, ok: true });
    expect(resolveTelegramModel(catalog, { chatModel: { modelId: "model-second", provider: "connection-second" }, selected: null }))
      .toEqual({ model: second, ok: true });
    expect(resolveTelegramModel(catalog, { chatModel: { modelId: "", provider: "" }, selected: null }))
      .toEqual({ model: catalog.models[0], ok: true });
  });

  it("refuses a chosen model that left the catalog instead of substituting another", () => {
    expect(resolveTelegramModel(catalog, { chatModel: null, selected: { modelId: "model-gone", provider: "connection-fake" } }))
      .toEqual({ code: "model_unavailable", ok: false });
    expect(resolveTelegramModel(catalog, { chatModel: { modelId: "model-gone", provider: "connection-fake" }, selected: null }))
      .toEqual({ code: "model_unavailable", ok: false });
    expect(resolveTelegramModel(fakeCatalog({ defaults: { modelId: "", provider: "" }, models: [] }), { chatModel: null, selected: null }))
      .toEqual({ code: "no_model", ok: false });
  });

  it("without a default starts where a new web chat does: the first non-test model, then the first", () => {
    const test = fakeCatalogModel({ modelId: "model-test", provider: "fake" });
    const undefaulted = (models: ReturnType<typeof fakeCatalogModel>[]) => fakeCatalog({ defaults: { modelId: "", provider: "" }, models });
    expect(resolveTelegramModel(undefaulted([test, second]), { chatModel: null, selected: null })).toEqual({ model: second, ok: true });
    expect(resolveTelegramModel(undefaulted([test]), { chatModel: null, selected: null })).toEqual({ model: test, ok: true });
  });
});
