import { act, fireEvent, renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { usePowerAppShellViewModel } from "./usePowerAppShellViewModel";
import { estimateApproxTokens } from "@/lib/domain/contextBudget";
import { STANDARD_CHAT_BASELINE_TEMPLATE } from "@/lib/domain/promptTemplates";
import { defaultParameterControls } from "./controlDefaults";
import { composerContextGauge } from "./composerContextStats";
import { composerContextConfigurationKey } from "./composerContextConfiguration";
import { initialComposerControlSnapshot, type ComposerControlSnapshot } from "./composerControlStore";
import type { SessionContextStatus } from "@/lib/contracts/sessionStatus";
import type { Catalog, FolderSummary, WorkspaceChatSummary } from "./types";
import { decodeUploadAttachmentResponse } from "@/lib/contracts/uploads";
import { boundComposerAssistantFixture } from "@/tests/support/composerAssistantFixtures";

function configurationKey(controls: Partial<ComposerControlSnapshot> = {}, workspaceEnabled = false): string {
  return composerContextConfigurationKey({ ...initialComposerControlSnapshot, maxOutputTokens: "1024", ...controls }, {
    memoryMode: "NORMAL", workspaceEnabled
  });
}

function acceptedSurface() {
  return { answerStartedAt: null, events: [], startedAt: 100,
    contextConfigurationKey: configurationKey(), contextMessageId: "answer" };
}

function chat(id: string): WorkspaceChatSummary {
  return {
    activeLeafMessageId: null,
    createdAt: "2026-06-10T00:00:00.000Z",
    defaultModelId: "gpt-5.5",
    defaultProvider: "openai",
    folderId: null,
    id,
    messageCount: 0,
    title: "Chat",
    updatedAt: "2026-06-10T00:00:00.000Z"
  };
}

function renderViewModel(overrides: Partial<Parameters<typeof usePowerAppShellViewModel>[0]> = {}) {
  return renderHook((input: typeof overrides) =>
    usePowerAppShellViewModel({
      activeChatId: "chat-a",
      activeChatStreaming: false,
      attachments: [],
      catalog: null,
      chats: [chat("chat-a")],
      draft: "",
      contextConfigurationKey: configurationKey(),
      folders: [],
      maxOutputTokens: "128000",
      pendingChatFolderId: null,
      projectSettingsFolderId: null,
      renderActiveLeafId: null,
      runSurface: { answerStartedAt: null, events: [], startedAt: null },
      selectedAssistantPromptCharacterCount: null,
      selectedModelId: "gpt-5.5",
      selectedProvider: "openai",
      visibleMessages: [],
      ...input
    }), { initialProps: overrides }
  );
}

const emptyCatalog: Catalog = {
  defaults: {
    controlValues: {},
    hasPersonalModelDefault: true,
    modelId: "gpt-5.5",
    modelPreferenceSource: "personal",
    organizationModelDefault: null,
    organizationSearchPlan: { mode: "all_selected", optionIds: [] },
    personalModelDefault: { modelId: "gpt-5.5", provider: "openai" },
    provider: "openai",
    searchPlan: { mode: "all_selected", optionIds: [] },
    searchPreferenceSource: "personal",
    showCitations: true,
    showReasoningBlocks: false,
  },
  models: [],
  providers: [],
  searchStrategies: [{ displayName: "No Search", kind: "none", strategyId: "search-disabled" }]
};

describe("usePowerAppShellViewModel", () => {
  it("counts decoded verified PDF pages rather than binary size without requiring extraction metadata", () => {
    const catalog: Catalog = { ...emptyCatalog, models: [{
      capabilities: { background: false, documentInputMode: "native_pdf", imageInput: false, nativeWebSearch: false,
        openRouterPerplexitySearch: false, reasoning: false, streaming: true, toolCalling: true },
      contextWindow: 1_050_000, defaultParams: {}, displayName: "PDF model", modelId: "gpt-5.5", provider: "openai",
      parameterControls: defaultParameterControls(), searchStrategyIds: []
    }] };
    for (const byteSize of [1024, 19_088_864]) {
      const decoded = decodeUploadAttachmentResponse({ attachment: {
        id: "pdf", kind: "pdf", fileName: "two-pages.pdf", mimeType: "application/pdf", byteSize,
        pageCount: 2, extractedText: null, status: "ready"
      } })!;
      expect(decoded.attachment.processing).toBeUndefined();
      const { result } = renderViewModel({ catalog, attachments: [decoded.attachment], maxOutputTokens: "65536" });
      expect(result.current.composerContextStats.approximateInputTokens)
        .toBe(1024 + estimateApproxTokens(STANDARD_CHAT_BASELINE_TEMPLATE));
      const legacy = { ...decoded.attachment, pageCount: undefined, processing: {
        pageCount: 2, pagesProcessed: 2, extractedCharacterCount: 0, status: "no_text" as const
      } };
      expect(renderViewModel({ catalog, attachments: [legacy] }).result.current.composerContextStats.approximateInputTokens)
        .toBe(result.current.composerContextStats.approximateInputTokens);
      const conflicting = { ...legacy, pageCount: 1 };
      expect(renderViewModel({ catalog, attachments: [conflicting] }).result.current.composerContextStats.approximateInputTokens)
        .toBe(512 + estimateApproxTokens(STANDARD_CHAT_BASELINE_TEMPLATE));
      const unknown = { ...decoded.attachment, pageCount: undefined };
      expect(renderViewModel({ catalog, attachments: [unknown] }).result.current.composerContextStats.approximateInputTokens)
        .toBe(Math.min(1_050_000, Math.max(256, Math.ceil(byteSize / 4096) * 256)) + estimateApproxTokens(STANDARD_CHAT_BASELINE_TEMPLATE));
    }
  });

  it("uses a branch-bound server snapshot and rejects an unbound measurement", () => {
    const snapshot: SessionContextStatus = {
      approximateInputTokens: 6000, contextWindow: 10000, droppedMessages: 0, loadedTools: 4,
      maxOutputTokens: 1024, modelId: "gpt-5.5", phase: "after_answer", provider: "openai",
      safetyMarginTokens: 1000, version: 1
    };
    const catalog: Catalog = { ...emptyCatalog, models: [{
      capabilities: { background: false, documentInputMode: "none", imageInput: false, nativeWebSearch: false,
        openRouterPerplexitySearch: false, reasoning: false, streaming: true, toolCalling: true },
      contextWindow: 10000, defaultParams: {}, displayName: "Model", modelId: "gpt-5.5", provider: "openai",
      parameterControls: defaultParameterControls(), searchStrategyIds: []
    }] };
    const current = renderViewModel({ catalog, maxOutputTokens: "1024",
      runSurface: acceptedSurface(),
      renderActiveLeafId: "answer", visibleMessages: [{ id: "answer", parentMessageId: null,
        role: "assistant", status: "complete", content: "Answer" }],
      activeThreadContextStats: { approximateActiveBranchInputTokens: 1000, session: snapshot, sessionMessageId: "answer" }
    });
    expect(current.result.current.composerContextStats.session).toEqual(snapshot);
    expect(current.result.current.composerContextStats.approximateInputTokens).toBe(6000);
    const stale = renderViewModel({ catalog,
      activeThreadContextStats: { approximateActiveBranchInputTokens: 1000, session: { ...snapshot, modelId: "other-model" } }
    });
    expect(stale.result.current.composerContextStats.session).toBeUndefined();
  });
  it("adds drafts and attachments while keeping measured tokens across refresh and control changes", () => {
    const snapshot: SessionContextStatus = {
      approximateInputTokens: 6000, contextWindow: 10000, droppedMessages: 2, loadedTools: 4,
      maxOutputTokens: 1024, modelId: "gpt-5.5", phase: "after_answer", provider: "openai",
      safetyMarginTokens: 1000, version: 1
    };
    const input: Partial<Parameters<typeof usePowerAppShellViewModel>[0]> = {
      catalog: { ...emptyCatalog, models: [{
        capabilities: { background: false, documentInputMode: "none", imageInput: false, nativeWebSearch: false,
          openRouterPerplexitySearch: false, reasoning: false, streaming: true, toolCalling: true },
        contextWindow: 10000, defaultParams: {}, displayName: "Model", modelId: "gpt-5.5", provider: "openai",
        parameterControls: defaultParameterControls(), searchStrategyIds: []
      }] },
      maxOutputTokens: "1024", renderActiveLeafId: "answer",
      runSurface: acceptedSurface(),
      visibleMessages: [{ id: "answer", parentMessageId: null, role: "assistant", status: "complete", content: "Answer" }],
      activeThreadContextStats: { approximateActiveBranchInputTokens: 1000, session: snapshot, sessionMessageId: "answer" }
    };
    const view = renderViewModel(input);
    const refresh = () => ({ ...input, activeThreadContextStats: structuredClone(input.activeThreadContextStats) });
    view.rerender(refresh());
    expect(view.result.current.composerContextStats.session).toEqual(snapshot);
    for (const draft of ["abcd", "界界界界", "already typed", ""]) {
      view.rerender({ ...refresh(), draft });
      expect(view.result.current.composerContextStats).toMatchObject({
        session: snapshot, approximateInputTokens: 6000 + estimateApproxTokens(draft)
      });
    }
    const attachment = { id: "text", fileName: "same.txt", kind: "document" as const, extractedText: "abcd" };
    view.rerender({ ...refresh(), attachments: [attachment], draft: "next" });
    const attachmentTokens = estimateApproxTokens("[Attached document: same.txt (unknown type)]\nabcd");
    expect(view.result.current.composerContextStats).toMatchObject({
      session: snapshot, approximateInputTokens: 6000 + 1 + attachmentTokens, draftInputTokens: 1 + attachmentTokens
    });
    view.rerender({ ...refresh(), attachments: [{ ...attachment, extractedText: "界界界界" }] });
    expect(view.result.current.composerContextStats.approximateInputTokens).toBe(6000 + attachmentTokens + 3);
    view.rerender(refresh());
    expect(view.result.current.composerContextStats.approximateInputTokens).toBe(6000);
    for (const change of [
      { contextConfigurationKey: configurationKey({ assistant: boundComposerAssistantFixture({
        id: "other", name: "Helper", promptCharacterCount: 0
      }) }) },
      { contextConfigurationKey: configurationKey({ selectedSkills: [{ id: "skill-b", name: "Skill", description: "", promptCharacterCount: 0 }] }) },
      { contextConfigurationKey: configurationKey({ mcpSelection: { mode: "off" } }) },
      { contextConfigurationKey: configurationKey({}, true) },
      { maxOutputTokens: "2048" },
      { selectedModelId: "other-model" },
      { selectedProvider: "other-provider" },
      { selectedModelId: "other-deployment", selectedProvider: "other-connection",
        contextConfigurationKey: configurationKey({ selectedModelId: "other-deployment", selectedProvider: "other-connection" }), catalog: {
        ...input.catalog!, models: [...input.catalog!.models, { ...input.catalog!.models[0]!,
          modelId: "other-deployment", provider: "other-connection", upstreamModelId: "gpt-5.5", providerFamily: "openai" as const }]
      } }
    ]) {
      view.rerender({ ...refresh(), ...change });
      expect(view.result.current.composerContextStats).toMatchObject({
        session: snapshot, approximateInputTokens: 6000, basis: "settings_changed"
      });
    }
    view.rerender({ ...refresh(), renderActiveLeafId: "another-answer", visibleMessages: [{
      id: "another-answer", parentMessageId: null, role: "assistant", status: "complete", content: "Other branch"
    }] });
    expect(view.result.current.composerContextStats.session).toBeUndefined();
    const pending = renderViewModel({ ...input, draft: "already typed" });
    expect(pending.result.current.composerContextStats).toMatchObject({
      session: snapshot, approximateInputTokens: 6000 + estimateApproxTokens("already typed")
    });
    const thresholdInput = { ...input, activeThreadContextStats: {
      ...input.activeThreadContextStats!, session: { ...snapshot, approximateInputTokens: 5000 }
    } };
    for (const [tokens, tone] of [[0, "proof"], [600, "warning"], [2976, "critical"], [20000, "critical"]] as const) {
      view.rerender({ ...thresholdInput, draft: "a".repeat(tokens * 4) });
      const stats = view.result.current.composerContextStats;
      expect(stats.approximateInputTokens).toBe(5000 + Math.min(tokens, 10000));
      expect(stats.session).toEqual(thresholdInput.activeThreadContextStats.session);
      expect(composerContextGauge(stats).tone).toBe(tone);
      expect(composerContextGauge(stats).inputBudgetFraction).toBeLessThanOrEqual(1);
    }
    view.rerender({ ...input, draft: "rejected", contextRejectionGeneration: 1 });
    expect(view.result.current.composerContextStats.session).toBeUndefined();
    view.rerender({ ...input, draft: "", contextRejectionGeneration: null });
    expect(view.result.current.composerContextStats.session).toBeUndefined();
  });

  it("describes a cold-loaded or evicted snapshot as measured until the user changes a control", () => {
    const snapshot: SessionContextStatus = {
      approximateInputTokens: 6000, contextWindow: 10000, droppedMessages: 2, loadedTools: 4,
      maxOutputTokens: 1024, modelId: "gpt-5.5", phase: "after_answer", provider: "openai",
      safetyMarginTokens: 1000, version: 1
    };
    const input: Partial<Parameters<typeof usePowerAppShellViewModel>[0]> = {
      catalog: { ...emptyCatalog, models: [{
        capabilities: { background: false, documentInputMode: "none", imageInput: false, nativeWebSearch: false,
          openRouterPerplexitySearch: false, reasoning: false, streaming: true, toolCalling: true },
        contextWindow: 10000, defaultParams: {}, displayName: "Model", modelId: "gpt-5.5", provider: "openai",
        parameterControls: defaultParameterControls(), searchStrategyIds: []
      }] }, maxOutputTokens: "1024", renderActiveLeafId: "answer",
      contextConfigurationKey: configurationKey(),
      visibleMessages: [{ id: "answer", parentMessageId: null, role: "assistant", status: "complete", content: "Answer" }],
      activeThreadContextStats: { approximateActiveBranchInputTokens: 1000, session: snapshot, sessionMessageId: "answer" }
    };
    const view = renderViewModel(input);
    expect(view.result.current.composerContextStats).toMatchObject({
      session: snapshot, approximateInputTokens: 6000, basis: "measured", snapshotSource: "persisted", requestInFlight: false
    });
    // Chat defaults and the Assistant projection land while the chat loads,
    // before the user touches anything: they are not a change.
    const loadedKey = configurationKey({ mcpSelection: { mode: "off" } });
    view.rerender({ ...input, contextConfigurationKey: loadedKey });
    expect(view.result.current.composerContextStats.basis).toBe("measured");
    act(() => { fireEvent.pointerDown(document.body); });
    view.rerender({ ...input, contextConfigurationKey: loadedKey, draft: "next" });
    expect(view.result.current.composerContextStats).toMatchObject({ approximateInputTokens: 6001, basis: "measured" });
    // The first interaction fixed the loaded controls; a change after it is reported.
    act(() => { fireEvent.keyDown(document.body, { key: "Enter" }); });
    view.rerender({ ...input, contextConfigurationKey: configurationKey({ reasoningEffort: "high" }) });
    expect(view.result.current.composerContextStats).toMatchObject({ approximateInputTokens: 6000, basis: "settings_changed" });
    view.rerender({ ...input, contextConfigurationKey: loadedKey });
    expect(view.result.current.composerContextStats.basis).toBe("measured");
    // A model with other limits is a change without any baseline.
    const wider = renderViewModel({ ...input, catalog: { ...input.catalog!, models: [{ ...input.catalog!.models[0]!, contextWindow: 20000 }] } });
    expect(wider.result.current.composerContextStats).toMatchObject({ approximateInputTokens: 6000, basis: "settings_changed" });
    // Reconnection restores live measurement priority under the same page baseline.
    const reconnected = { ...input, contextConfigurationKey: configurationKey({ reasoningEffort: "high" }), activeChatStreaming: true,
      runSurface: { answerStartedAt: null, startedAt: 100, events: [
        { type: "message_start", data: { assistantMessageId: "answer" } },
        { type: "artifact", data: { artifactType: "context_status", payload: { ...snapshot, approximateInputTokens: 6100, phase: "after_answer" } } }
      ] } };
    view.rerender(reconnected);
    expect(view.result.current.composerContextStats).toMatchObject({
      approximateInputTokens: 6100, snapshotSource: "live", basis: "settings_changed"
    });
    // Leaving the chat drops its baseline; returning is a fresh load.
    for (let index = 0; index < 3; index += 1) {
      view.rerender({ activeChatId: `other-${index}` });
      expect(view.result.current.composerContextStats.session).toBeUndefined();
    }
    view.rerender({ ...input, contextConfigurationKey: configurationKey({ reasoningEffort: "high" }) });
    expect(view.result.current.composerContextStats).toMatchObject({ approximateInputTokens: 6000, basis: "measured" });
  });

  it("describes a stopped run's request measurement as the last request and a running one as current", () => {
    const snapshot: SessionContextStatus = {
      approximateInputTokens: 6000, contextWindow: 10000, droppedMessages: 0, loadedTools: 4,
      maxOutputTokens: 1024, modelId: "gpt-5.5", phase: "request", provider: "openai",
      safetyMarginTokens: 1000, version: 1
    };
    const input: Partial<Parameters<typeof usePowerAppShellViewModel>[0]> = {
      catalog: { ...emptyCatalog, models: [{
        capabilities: { background: false, documentInputMode: "none", imageInput: false, nativeWebSearch: false,
          openRouterPerplexitySearch: false, reasoning: false, streaming: true, toolCalling: true },
        contextWindow: 10000, defaultParams: {}, displayName: "Model", modelId: "gpt-5.5", provider: "openai",
        parameterControls: defaultParameterControls(), searchStrategyIds: []
      }] }, maxOutputTokens: "1024", renderActiveLeafId: "answer",
      visibleMessages: [{ id: "answer", parentMessageId: null, role: "assistant", status: "cancelled", content: "Partial" }],
      activeThreadContextStats: { approximateActiveBranchInputTokens: 1000, session: snapshot, sessionMessageId: "answer" }
    };
    const view = renderViewModel(input);
    expect(view.result.current.composerContextStats).toMatchObject({
      session: snapshot, approximateInputTokens: 6000, basis: "measured", snapshotSource: "persisted", requestInFlight: false
    });
    // A reload during a run: the persisted request belongs to the running answer.
    view.rerender({ ...input, visibleMessages: [{ ...input.visibleMessages![0]!, status: "streaming" }] });
    expect(view.result.current.composerContextStats.requestInFlight).toBe(true);
    // A Stop in this page keeps the live request measurement of the ended run.
    const live = { ...input, runSurface: { ...acceptedSurface(), events: [
      { type: "message_start", data: { assistantMessageId: "answer" } },
      { type: "artifact", data: { artifactType: "context_status", payload: snapshot } }
    ] } };
    view.rerender({ ...live, activeChatStreaming: true, visibleMessages: [{ ...input.visibleMessages![0]!, status: "streaming" }] });
    expect(view.result.current.composerContextStats).toMatchObject({ snapshotSource: "live", requestInFlight: true });
    view.rerender(live);
    expect(view.result.current.composerContextStats).toMatchObject({ snapshotSource: "live", requestInFlight: false });
  });

  it("keeps live and persisted measurements while describing controls changed during a run", () => {
    const snapshot: SessionContextStatus = {
      approximateInputTokens: 6000, contextWindow: 10000, droppedMessages: 0, loadedTools: 4,
      maxOutputTokens: 1024, modelId: "gpt-5.5", phase: "request", provider: "openai",
      safetyMarginTokens: 1000, version: 1
    };
    const input: Partial<Parameters<typeof usePowerAppShellViewModel>[0]> = {
      catalog: { ...emptyCatalog, models: [{
        capabilities: { background: false, documentInputMode: "none", imageInput: false, nativeWebSearch: false,
          openRouterPerplexitySearch: false, reasoning: false, streaming: true, toolCalling: true },
        contextWindow: 10000, defaultParams: {}, displayName: "Model", modelId: "gpt-5.5", provider: "openai",
        parameterControls: defaultParameterControls(), searchStrategyIds: []
      }] }, maxOutputTokens: "1024", renderActiveLeafId: "answer", activeChatStreaming: true,
      visibleMessages: [{ id: "answer", parentMessageId: null, role: "assistant", status: "streaming", content: "" }],
      runSurface: { ...acceptedSurface(), events: [
        { type: "message_start", data: { assistantMessageId: "answer" } },
        { type: "artifact", data: { artifactType: "context_status", payload: snapshot } }
      ] }
    };
    const view = renderViewModel(input);
    expect(view.result.current.composerContextStats.session).toEqual(snapshot);
    // The browser misses the final context event; polling reloads the durable
    // answer while the old live request event remains in the surface store.
    view.rerender({ ...input, activeChatStreaming: false, activeThreadContextStats: {
      approximateActiveBranchInputTokens: 1000, sessionMessageId: "answer", sessionBranchLeafId: "answer",
      session: { ...snapshot, phase: "after_answer", approximateInputTokens: 6500 }
    } });
    expect(view.result.current.composerContextStats).toMatchObject({
      approximateInputTokens: 6500, snapshotSource: "persisted", session: { phase: "after_answer" }
    });
    view.rerender({ ...input, activeThreadContextStats: {
      approximateActiveBranchInputTokens: 1000, sessionMessageId: "another-answer", sessionBranchLeafId: "another-answer",
      session: { ...snapshot, phase: "after_answer", approximateInputTokens: 9000 }
    } });
    expect(view.result.current.composerContextStats).toMatchObject({
      approximateInputTokens: 6000, snapshotSource: "live", session: { phase: "request" }
    });
    const completed = { ...input, activeChatStreaming: false, runSurface: { ...input.runSurface!, events: [
      input.runSurface!.events[0]!, { type: "artifact" as const, data: { artifactType: "context_status", payload: { ...snapshot, phase: "after_answer" } } }
    ] } };
    view.rerender(completed);
    expect(view.result.current.composerContextStats.session?.phase).toBe("after_answer");
    view.rerender({ ...completed, contextConfigurationKey: configurationKey({ reasoningEffort: "high" }) });
    expect(view.result.current.composerContextStats.basis).toBe("settings_changed");
    expect(view.result.current.composerContextStats.session?.phase).toBe("after_answer");
    view.rerender({ ...completed, contextConfigurationKey: configurationKey({ reasoningEffort: "high" }),
      activeThreadContextStats: { approximateActiveBranchInputTokens: 1000, session: { ...snapshot, phase: "after_answer" }, sessionMessageId: "answer" } });
    expect(view.result.current.composerContextStats.basis).toBe("settings_changed");
    expect(view.result.current.composerContextStats.session?.phase).toBe("after_answer");

    const preparing = { ...input, contextConfigurationKey: "accepted-controls",
      renderActiveLeafId: "optimistic-answer",
      visibleMessages: [{ ...input.visibleMessages![0]!, id: "optimistic-answer" }],
      runSurface: { ...input.runSurface!, contextConfigurationKey: "accepted-controls", contextMessageId: "optimistic-answer", events: [] }
    };
    const preparingView = renderViewModel(preparing);
    expect(preparingView.result.current.composerContextStats.session).toBeUndefined();
    preparingView.rerender({ ...preparing, contextConfigurationKey: "changed-during-preparation" });
    const admitted = { ...input, contextConfigurationKey: "changed-during-preparation",
      runSurface: { ...input.runSurface!, contextConfigurationKey: "accepted-controls", contextMessageId: "answer" }
    };
    preparingView.rerender(admitted);
    expect(preparingView.result.current.composerContextStats).toMatchObject({ session: snapshot, basis: "settings_changed" });
    preparingView.rerender({ ...admitted, contextConfigurationKey: "accepted-controls", draft: "next" });
    expect(preparingView.result.current.composerContextStats).toMatchObject({
      session: snapshot, approximateInputTokens: 6001
    });
    preparingView.rerender({ ...admitted, contextConfigurationKey: "accepted-controls", runSurface: {
      ...admitted.runSurface, events: [input.runSurface!.events[1]!, input.runSurface!.events[0]!]
    } });
    expect(preparingView.result.current.composerContextStats.session).toBeUndefined();
  });

  it("recalculates current model limits without losing the measurement or off-page branch fallback", () => {
    const snapshot: SessionContextStatus = {
      approximateInputTokens: 6000, contextWindow: 10000, droppedMessages: 0, loadedTools: 4,
      maxOutputTokens: 1024, modelId: "gpt-5.5", phase: "after_answer", provider: "openai",
      safetyMarginTokens: 1000, version: 1
    };
    const model = {
      capabilities: { background: false, documentInputMode: "none" as const, imageInput: false, nativeWebSearch: false,
        openRouterPerplexitySearch: false, reasoning: false, streaming: true, toolCalling: true },
      contextWindow: 10000, defaultParams: {}, displayName: "Model", modelId: "gpt-5.5", provider: "openai",
      parameterControls: defaultParameterControls(), searchStrategyIds: []
    };
    const input: Partial<Parameters<typeof usePowerAppShellViewModel>[0]> = {
      maxOutputTokens: "1024", renderActiveLeafId: "answer", runSurface: acceptedSurface(),
      catalog: { ...emptyCatalog, models: [model] },
      visibleMessages: [{ id: "answer", parentMessageId: null, role: "assistant", status: "complete", content: "Answer" }],
      activeThreadContextStats: { approximateActiveBranchInputTokens: 1000,
        session: snapshot, sessionMessageId: "answer", sessionBranchLeafId: "answer", approximateInputTokensAfterSession: 0 }
    };
    const view = renderViewModel(input);
    expect(view.result.current.composerContextStats.basis).toBe("measured");
    for (const [contextWindow, percent, tone, budget] of [
      [20000, 30, "proof", 16976], [7000, 86, "critical", 5276], [0, null, "neutral", null]
    ] as const) {
      view.rerender({ ...input, catalog: { ...emptyCatalog, models: [{ ...model, contextWindow }] } });
      expect(view.result.current.composerContextStats).toMatchObject({
        approximateInputTokens: 6000, safeInputBudgetTokens: budget,
        totalContextTokens: contextWindow || null, basis: "settings_changed", session: snapshot
      });
      expect(composerContextGauge(view.result.current.composerContextStats)).toMatchObject({ percent, tone });
    }
    view.rerender({ ...input, draft: "next", activeThreadContextStats: {
      ...input.activeThreadContextStats!, sessionMessageId: "off-page-answer", approximateInputTokensAfterSession: 321
    } });
    expect(view.result.current.composerContextStats).toMatchObject({
      session: snapshot, approximateInputTokens: 6322, basis: "preliminary", snapshotSource: "persisted"
    });
    view.rerender({ ...input, renderActiveLeafId: "edited-branch" });
    expect(view.result.current.composerContextStats.session).toBeUndefined();
  });

  it("retains a rejected-request state only for the exact rejected inputs", () => {
    const view = renderViewModel({ draft: "rejected", contextRejectionGeneration: 1 });
    expect(view.result.current.composerContextStats.requestRejected).toBe(true);
    view.rerender({ draft: "rejected", contextRejectionGeneration: 1, contextConfigurationKey: configurationKey({ mcpSelection: { mode: "off" } }) });
    expect(view.result.current.composerContextStats.requestRejected).toBe(false);
    view.rerender({ draft: "rejected", contextRejectionGeneration: 2, contextConfigurationKey: configurationKey({ mcpSelection: { mode: "off" } }) });
    expect(view.result.current.composerContextStats.requestRejected).toBe(true);
  });

  it("does not mark a blank workspace as streaming while another chat runs", () => {
    const { result } = renderViewModel({
      activeChatId: null,
      activeChatStreaming: false
    });

    expect(result.current.activeChatStreaming).toBe(false);
  });

  it("marks only the owning chat as streaming", () => {
    const { result } = renderViewModel({
      activeChatStreaming: true
    });

    expect(result.current.activeChatStreaming).toBe(true);
  });

  it("uses the user message as the reading anchor for a streaming turn", () => {
    const { result } = renderViewModel({
      visibleMessages: [
        {
          content: "Previous answer",
          id: "assistant-previous",
          parentMessageId: null,
          role: "assistant",
          status: "complete"
        },
        {
          content: "New question",
          id: "user-current",
          parentMessageId: "assistant-previous",
          role: "user",
          status: "complete"
        },
        {
          content: "",
          id: "assistant-current",
          parentMessageId: "user-current",
          role: "assistant",
          status: "streaming"
        }
      ]
    });

    expect(result.current.threadReadingAnchorKey).toBe("user-current");
  });

  it("shows an entitlement hint when the current user has no catalog models", () => {
    const { result } = renderViewModel({
      catalog: emptyCatalog,
      selectedModelId: "",
      selectedProvider: ""
    });

    expect(result.current.currentModel).toBeUndefined();
    expect(result.current.composerDisabledHint).toBe("No model access. Ask an admin to grant model access.");
  });

  it("swaps the baseline estimate for the assistant prompt size when an assistant is selected", () => {
    // The baseline estimate must come from the raw template, never a live
    // clock/zone/locale render: SSR and hydration would disagree otherwise.
    const withoutAssistant = renderViewModel();
    const baselineTokens = estimateApproxTokens(STANDARD_CHAT_BASELINE_TEMPLATE);
    expect(baselineTokens).toBe(21);
    expect(withoutAssistant.result.current.composerContextStats.approximateInputTokens).toBe(
      baselineTokens
    );

    const withAssistant = renderViewModel({ selectedAssistantPromptCharacterCount: 8001 });
    expect(withAssistant.result.current.composerContextStats.approximateInputTokens).toBe(
      Math.ceil(8001 / 4)
    );
  });

  it("uses the server-owned full active-branch estimate when the browser holds only a page", () => {
    const { result } = renderViewModel({
      activeThreadContextStats: { approximateActiveBranchInputTokens: 12_345 },
      visibleMessages: [{
        content: "only the loaded tail",
        id: "tail",
        parentMessageId: "unloaded-parent",
        role: "assistant",
        status: "complete"
      }]
    });

    expect(result.current.composerContextStats.approximateInputTokens).toBe(
      estimateApproxTokens(STANDARD_CHAT_BASELINE_TEMPLATE) + 12_345
    );
  });

  it("does not include a legacy folder Project Memory value in the client estimate", () => {
    const folder: FolderSummary = {
      id: "folder-1",
      name: "Research",
      parentId: null,
      projectMemory: "Legacy text must stay dormant",
      sortOrder: 0
    };
    const { result } = renderViewModel({
      chats: [{ ...chat("chat-a"), folderId: folder.id }],
      folders: [folder]
    });

    expect(result.current.composerContextStats.approximateInputTokens).toBe(
      estimateApproxTokens(STANDARD_CHAT_BASELINE_TEMPLATE)
    );
  });
});
