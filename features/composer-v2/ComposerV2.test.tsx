import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { ComposerConfig } from "@/lib/contracts/composerConfig";
import { ComposerV2 } from "./ComposerV2";
import { composerGalleryConfig } from "@/app/ui-v2-fixture/_fixtures/ComposerV2Gallery";

function props(overrides: Partial<Parameters<typeof ComposerV2>[0]> = {}) {
  return {
    config: composerGalleryConfig,
    draft: "Проверь источники",
    onDraftChange: vi.fn(),
    onSelectKnowledgeBaseIds: vi.fn(),
    onSelectModel: vi.fn(),
    onSelectSearchOptionIds: vi.fn(),
    onSend: vi.fn(),
    selectedKnowledgeBaseIds: ["kb-finance"],
    selectedModelId: "gpt-5.2",
    selectedProvider: "openai-work",
    selectedSearchOptionIds: ["web-primary"],
    ...overrides
  } satisfies Parameters<typeof ComposerV2>[0];
}

describe("Composer v2", () => {
  it("keeps the editable draft beside an explicit branch consequence", () => {
    render(
      <ComposerV2
        {...props({
          editStatusSlot: <div>Sending creates a new branch; history stays unchanged.</div>
        })}
      />
    );

    expect(screen.getByText("Sending creates a new branch; history stays unchanged."))
      .toBeVisible();
    expect(screen.getByRole("textbox", { name: "Message" })).toBeEnabled();
  });

  it("renders no memory disclaimer while keeping truthful context/provider usage", () => {
    const { container } = render(<ComposerV2 {...props({
      contextStats: {
        approximateInputTokens: 8_000,
        safeInputBudgetTokens: 10_000,
        totalContextTokens: 12_000
      },
      usageStats: {
        activeBranchMessageCount: 4,
        cachedInputTokens: 300,
        cacheWriteInputTokens: 50,
        totalTokens: 2_400
      }
    })} />);

    expect(screen.queryByTestId("composer-memory-mode")).toBeNull();
    expect(container.textContent).not.toContain("Normal chat");
    expect(container.textContent).not.toContain("Temporary chat");
    expect(container.textContent).not.toContain("Temporary");

    const context = screen.getByRole("button", {
      name: /80% of the 10k safe input budget/u
    });
    expect(context).toHaveAttribute("data-context-tone", "warning");
    fireEvent.click(context);

    const dialog = screen.getByRole("dialog", { name: "Context and usage statistics" });
    expect(dialog).toHaveTextContent("Provider-reported tokens2.4k");
    expect(dialog).toHaveTextContent("Total messages4");
  });

  it("shows the context gauge only from 70% of the safe budget", () => {
    const { unmount } = render(<ComposerV2 {...props({
      contextStats: {
        approximateInputTokens: 800,
        safeInputBudgetTokens: 10_000,
        totalContextTokens: 12_000
      }
    })} />);
    expect(screen.queryByRole("button", { name: /Context estimate/ })).toBeNull();
    unmount();
  });

  it("labels the context gauge in human units and reveals it on hover too", () => {
    render(<ComposerV2 {...props({
      contextStats: {
        approximateInputTokens: 7_200,
        safeInputBudgetTokens: 10_000,
        totalContextTokens: 12_000
      }
    })} />);

    const context = screen.getByRole("button", { name: /Context estimate/ });
    expect(context).toHaveAttribute("title", "~72% of context");
    expect(screen.queryByRole("dialog", { name: "Context and usage statistics" })).toBeNull();

    fireEvent.mouseOver(context);
    expect(screen.getByRole("dialog", { name: "Context and usage statistics" })).toBeVisible();
    fireEvent.mouseOut(context);
    expect(screen.queryByRole("dialog", { name: "Context and usage statistics" })).toBeNull();

    fireEvent.click(context);
    fireEvent.mouseOut(context);
    const pinned = screen.getByRole("dialog", { name: "Context and usage statistics" });
    fireEvent.keyDown(pinned, { key: "Escape" });
    expect(screen.queryByRole("dialog", { name: "Context and usage statistics" })).toBeNull();
    expect(context).toHaveFocus();
  });

  it("sends on Enter, preserves Shift+Enter, and ignores every IME fallback", () => {
    const onSend = vi.fn();
    render(<ComposerV2 {...props({ onSend })} />);
    const input = screen.getByRole("textbox", { name: "Message" });

    fireEvent.keyDown(input, { key: "Enter", shiftKey: true });
    fireEvent.keyDown(input, { isComposing: true, key: "Enter" });
    fireEvent.keyDown(input, { key: "Process" });
    fireEvent.keyDown(input, { key: "Enter", keyCode: 229 });
    expect(onSend).not.toHaveBeenCalled();

    fireEvent.keyDown(input, { key: "Enter" });
    expect(onSend).toHaveBeenCalledOnce();
  });

  it("searches grouped models, wraps keyboard navigation, and restores trigger focus", async () => {
    const onSelectModel = vi.fn();
    render(<ComposerV2 {...props({ onSelectModel })} />);
    const trigger = screen.getByRole("button", { name: "GPT-5.2" });
    fireEvent.click(trigger);
    const search = screen.getByRole("searchbox", { name: "Search models" });
    await waitFor(() => expect(search).toHaveFocus());

    fireEvent.change(search, { target: { value: "Gemini" } });
    expect(screen.getByRole("option", { name: /Gemini 3 Pro/ })).toBeVisible();
    expect(screen.queryByRole("option", { name: /GPT-5.2 mini/ })).toBeNull();

    fireEvent.change(search, { target: { value: "" } });
    fireEvent.keyDown(search, { key: "ArrowUp" });
    expect(screen.getByRole("option", { name: /Gemini 3 Pro/ })).toHaveFocus();
    fireEvent.keyDown(document.activeElement!, { key: "ArrowDown" });
    expect(screen.getByRole("option", { name: /^GPT-5\.2Reasoning/ })).toHaveFocus();
    fireEvent.click(screen.getByRole("option", { name: /GPT-5.2 mini/ }));
    expect(onSelectModel).toHaveBeenCalledWith(expect.objectContaining({
      displayName: "GPT-5.2 mini",
      provider: "openai-work"
    }));
    await waitFor(() => expect(trigger).toHaveFocus());

    fireEvent.click(trigger);
    await waitFor(() => expect(screen.getByRole("searchbox", { name: "Search models" })).toHaveFocus());
    fireEvent.keyDown(screen.getByRole("searchbox", { name: "Search models" }), { key: "Escape" });
    expect(screen.queryByRole("dialog", { name: "Choose model" })).toBeNull();
    await waitFor(() => expect(trigger).toHaveFocus());
  });

  it("closes each layer from the sheet scrim, the sticky close control, and Escape", async () => {
    render(<ComposerV2 {...props()} />);
    const plus = screen.getByRole("button", { name: "Capabilities" });

    // Scrim tap: the backdrop button is the touch exit of the bottom sheet.
    fireEvent.click(plus);
    expect(screen.getByRole("menu", { name: "Capabilities" })).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Close menu" }));
    expect(screen.queryByRole("menu", { name: "Capabilities" })).toBeNull();
    await waitFor(() => expect(plus).toHaveFocus());

    // Always-visible close control in the sheet header.
    fireEvent.click(plus);
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(screen.queryByRole("menu", { name: "Capabilities" })).toBeNull();
    await waitFor(() => expect(plus).toHaveFocus());

    // Escape keeps closing the model sheet and restores its trigger.
    const modelTrigger = screen.getByRole("button", { name: "GPT-5.2" });
    fireEvent.click(modelTrigger);
    const modelLayer = screen.getByRole("dialog", { name: "Choose model" });
    fireEvent.keyDown(modelLayer, { key: "Escape" });
    expect(screen.queryByRole("dialog", { name: "Choose model" })).toBeNull();
    await waitFor(() => expect(modelTrigger).toHaveFocus());
  });

  it("keeps each picker open across Search, Knowledge, Skills, and MCP toggles", () => {
    const onKnowledge = vi.fn();
    const onSearch = vi.fn();
    const onSelectMcp = vi.fn();
    const onSelectSkills = vi.fn();
    const config: ComposerConfig = {
      ...composerGalleryConfig,
      mcpServers: [
        ...composerGalleryConfig.mcpServers,
        {
          description: "Issue tracking",
          enabled: true,
          id: "mcp-jira-enabled",
          knownToolCount: 4,
          name: "jira",
          readiness: "idle"
        }
      ],
      skills: [{
        archived: false,
        description: "Checks claims",
        id: "skill-editor",
        instructionCharacterCount: "Verify every factual claim.".length,
        name: "Careful editor",
        owned: true,
        ownerDisplayName: "Viewer",
        scope: { kind: "owner" },
        updatedAt: "2026-08-16T00:00:00.000Z",
        version: 1
      }]
    };
    render(<ComposerV2 {...props({
      config,
      initialLayer: "capabilities",
      onSelectKnowledgeBaseIds: onKnowledge,
      onSelectSearchOptionIds: onSearch,
      onSelectMcp,
      onSelectSkillIds: onSelectSkills,
      selectedKnowledgeBaseIds: ["kb-finance", "missing-base"]
    })} />);
    // One visit combines several selections: no toggle closes its picker, so a
    // second Search engine or Knowledge Base never needs the trigger reopened.
    const menuOpen = (name: string) =>
      expect(screen.getByRole("menu", { name })).toBeVisible();

    fireEvent.click(screen.getByRole("menuitemcheckbox", { name: /Research Search/ }));
    expect(onSearch).toHaveBeenCalledWith(["web-primary", "research-search"]);
    menuOpen("Capabilities");

    fireEvent.click(screen.getByRole("menuitemcheckbox", { name: /Careful editor/ }));
    expect(onSelectSkills).toHaveBeenCalledWith(["skill-editor"]);
    menuOpen("Capabilities");
    // The "+" menu no longer carries Knowledge or MCP rows: each has its own chip.
    expect(screen.queryByRole("menuitemcheckbox", { name: /Финансы 2026/ })).toBeNull();
    expect(screen.queryByRole("menuitemradio", { name: /^Load all/ })).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Choose Knowledge" }));
    menuOpen("Knowledge");
    expect(screen.queryByRole("menu", { name: "Capabilities" })).toBeNull();
    fireEvent.click(screen.getByRole("menuitemcheckbox", { name: /Финансы 2026/ }));
    expect(onKnowledge).toHaveBeenCalledWith(["missing-base"]);
    menuOpen("Knowledge");

    fireEvent.click(screen.getByRole("menuitemcheckbox", { name: /Unavailable knowledge base/ }));
    expect(onKnowledge).toHaveBeenCalledWith(["kb-finance"]);
    menuOpen("Knowledge");

    fireEvent.click(screen.getByRole("button", { name: "Change MCP mode" }));
    menuOpen("MCP tools");
    expect(screen.queryByRole("menu", { name: "Knowledge" })).toBeNull();
    // Disclosure of what the modes act on; enabling stays in Settings.
    expect(screen.getByTestId("composer-v2-mcp-enabled")).toHaveTextContent("Enabled: office-compute");
    expect(screen.queryByRole("menuitemcheckbox", { name: /office-compute/ })).toBeNull();
    fireEvent.click(screen.getByRole("menuitemradio", { name: /^Load all/ }));
    expect(onSelectMcp).toHaveBeenCalledWith({ mode: "load_all" });
    menuOpen("MCP tools");
  });

  it("keeps blank-chat actions in the single composer capability rail", () => {
    render(<ComposerV2 {...props({ draft: "", onUploadFiles: vi.fn() })} />);

    expect(screen.queryByRole("group", { name: "Ways to start" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Capabilities" })).toBeVisible();
    expect(screen.getByRole("button", { name: "Turn off Search" })).toBeVisible();
    expect(screen.getByRole("button", { name: "Choose Knowledge" })).toBeVisible();
  });

  it("keeps every MCP mode visible, including Off with no enabled servers", () => {
    const onSelectMcp = vi.fn();
    const { rerender } = render(<ComposerV2 {...props({
      config: { ...composerGalleryConfig, mcpServers: [] },
      initialLayer: "tools",
      mcpSelection: { mode: "off" },
      onSelectMcp
    })} />);

    expect(screen.getByRole("button", { name: "Change MCP mode" }))
      .toHaveTextContent("MCP: Off");
    expect(screen.getByTestId("composer-v2-mcp-enabled")).toHaveTextContent("No servers enabled.");
    // Enabled servers are disclosed by name; only attention/failed states are counted.
    rerender(<ComposerV2 {...props({
      config: {
        ...composerGalleryConfig,
        mcpServers: [
          { ...composerGalleryConfig.mcpServers[0], readiness: "idle" },
          { ...composerGalleryConfig.mcpServers[1], enabled: true, readiness: "needs_authorization" }
        ]
      },
      initialLayer: "tools",
      mcpSelection: { mode: "off" },
      onSelectMcp
    })} />);
    expect(screen.getByTestId("composer-v2-mcp-enabled"))
      .toHaveTextContent("Enabled: office-compute, jira · 1 needs attention");
    expect(screen.getByRole("menuitemradio", { name: /^Auto/ })).toHaveAttribute("aria-checked", "false");
    expect(screen.getByRole("menuitemradio", { name: /^Load all/ })).toHaveAttribute("aria-checked", "false");
    expect(screen.getByRole("menuitemradio", { name: /^Off/ })).toHaveAttribute("aria-checked", "true");

    fireEvent.click(screen.getByRole("menuitemradio", { name: /^Auto/ }));
    expect(onSelectMcp).toHaveBeenCalledWith({ mode: "auto" });
  });

  it("opens the Assistant quick picker within two actions and explains manual restoration", () => {
    const onDismiss = vi.fn();
    const onOpenAssistantPicker = vi.fn();
    render(<ComposerV2 {...props({
      assistantRemovedNotice: true,
      initialLayer: "capabilities",
      onDismissAssistantRemovedNotice: onDismiss,
      onOpenAssistantPicker
    })} />);

    fireEvent.click(screen.getByRole("menuitemcheckbox", { name: /Use an Assistant/ }));
    expect(onOpenAssistantPicker).toHaveBeenCalledOnce();
    expect(screen.getByTestId("composer-assistant-removed-notice")).toHaveTextContent(
      "manual settings now apply"
    );
    fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));
    expect(onDismiss).toHaveBeenCalledOnce();
  });

  it("shows Assistant-governed controls as locked until explicit removal", () => {
    const onRemoveAssistant = vi.fn();
    const onSelectSearch = vi.fn();
    render(<ComposerV2 {...props({
      initialLayer: "capabilities",
      onRemoveAssistant,
      onSelectSearchOptionIds: onSelectSearch,
      onToggleMcpServer: vi.fn(),
      selectedAssistant: composerGalleryConfig.assistants[0]
    })} />);

    expect(screen.getByTestId("composer-v2-assistant-lock")).toHaveTextContent(
      "Assistant: Research editor"
    );
    expect(screen.getByRole("button", { name: "GPT-5.2" })).toBeDisabled();
    const searchRows = screen.getAllByRole("menuitemcheckbox", { name: /Web Search/ });
    expect(searchRows[0]).toBeDisabled();
    expect(screen.getAllByText("Managed by the Assistant").length).toBeGreaterThan(2);
    fireEvent.click(screen.getByRole("button", { name: "Remove" }));
    expect(onRemoveAssistant).toHaveBeenCalledOnce();
    expect(onSelectSearch).not.toHaveBeenCalled();
  });

  it("separates Assistant-included and manual Skills while keeping manual controls available", () => {
    const onOpenSkillLibrary = vi.fn();
    const onSelectSkillIds = vi.fn();
    const manualSkill = {
      archived: false,
      description: "Checks claims",
      id: "skill-manual",
      instructionCharacterCount: 24,
      name: "Careful editor",
      owned: true,
      ownerDisplayName: "Viewer",
      scope: { kind: "owner" as const },
      updatedAt: "2026-08-16T00:00:00.000Z",
      version: 1
    };
    render(<ComposerV2 {...props({
      config: { ...composerGalleryConfig, skills: [manualSkill] },
      initialLayer: "capabilities",
      onOpenSkillLibrary,
      onSelectSkillIds,
      selectedAssistant: {
        ...composerGalleryConfig.assistants[0]!,
        includedSkills: [
          { id: "skill-incident", name: "Incident brief" },
          { id: "skill-review", name: "Careful reviewer" }
        ]
      },
      selectedSkillIds: [manualSkill.id],
      selectedSkills: [{ id: manualSkill.id, name: manualSkill.name }]
    })} />);

    const ledger = screen.getByTestId("composer-v2-skill-ledger");
    expect(ledger).toHaveTextContent("Included by Assistant");
    expect(ledger).toHaveTextContent("1. Incident brief");
    expect(ledger).toHaveTextContent("2. Careful reviewer");
    expect(ledger).toHaveTextContent("Added manually");
    expect(ledger).toHaveTextContent("1. Careful editor");

    const manualRow = screen.getByRole("menuitemcheckbox", { name: /Careful editor/ });
    expect(manualRow).toBeEnabled();
    fireEvent.click(manualRow);
    expect(onSelectSkillIds).toHaveBeenCalledWith([]);
    fireEvent.click(within(ledger).getByRole("button", { name: "Manage" }));
    expect(onOpenSkillLibrary).toHaveBeenCalledOnce();
  });

  it("keeps loading, malformed, and zero-entitlement authority states explicit", () => {
    const retry = vi.fn();
    const { rerender } = render(<ComposerV2 {...props({ config: null, draft: "" })} />);
    expect(screen.getByRole("status")).toHaveTextContent("Loading available capabilities…");
    expect(screen.getByRole("textbox", { name: "Message" })).toBeDisabled();

    rerender(<ComposerV2 {...props({ config: null, configError: true, draft: "", onRetryConfig: retry })} />);
    expect(screen.getByRole("alert")).toHaveTextContent("Could not load available capabilities.");
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(retry).toHaveBeenCalledOnce();

    const empty: ComposerConfig = {
      ...composerGalleryConfig,
      catalog: {
        ...composerGalleryConfig.catalog,
        models: [],
        providers: []
      }
    };
    rerender(<ComposerV2 {...props({ config: empty, draft: "" })} />);
    expect(screen.getByRole("status")).toHaveTextContent(
      "No models available. Contact your administrator."
    );
    expect(screen.getByRole("button", { name: "Send message" })).toBeDisabled();
  });

  it("searches eligible Sources beyond the initially loaded library page", async () => {
    const onSelectKnowledgeSelection = vi.fn();
    const onSearchKnowledgeSources = vi.fn().mockResolvedValue([{
      description: "A remotely matched source",
      id: "source-deep",
      name: "Deep archive",
      owned: true,
      readiness: "ready"
    }]);
    render(<ComposerV2 {...props({
      initialLayer: "knowledge",
      onSearchKnowledgeSources,
      onSelectKnowledgeBaseIds: undefined,
      onSelectKnowledgeSelection,
      selectedKnowledgeBaseIds: []
    })} />);

    fireEvent.change(screen.getByRole("searchbox", { name: "Search Knowledge resources" }), {
      target: { value: "deep" }
    });
    await waitFor(() => expect(onSearchKnowledgeSources).toHaveBeenCalledWith("deep"));
    fireEvent.click(await screen.findByRole("menuitemcheckbox", { name: /Deep archive/ }));

    expect(onSelectKnowledgeSelection).toHaveBeenCalledWith({
      baseIds: [],
      mode: "explicit",
      sourceIds: ["source-deep"],
      version: 1
    });
  });

  it("never renders opaque provider, model, Knowledge, or MCP bindings", () => {
    const { container } = render(<ComposerV2 {...props() } />);
    const text = container.textContent ?? "";
    expect(text).not.toContain("openai-work");
    expect(text).not.toContain("kb-finance");
    expect(text).not.toContain("mcp-office");
  });

  it("keeps the model trigger to the display name without provider labels or hosts", () => {
    const leakyConfig: ComposerConfig = {
      ...composerGalleryConfig,
      catalog: {
        ...composerGalleryConfig.catalog,
        providers: [{
          family: "openai",
          id: "openai-work",
          models: ["gpt-5.2", "gpt-5.2-mini"],
          name: "Custom OpenAI · codex-lb.psaux.info · ref 0N0FNN"
        }, {
          family: "google",
          id: "google-work",
          models: ["gemini-3-pro"],
          name: "Google"
        }]
      }
    };
    render(<ComposerV2 {...props({ config: leakyConfig })} />);

    const trigger = screen.getByRole("button", { name: "GPT-5.2" });
    expect(trigger.querySelector("strong")?.textContent).toBe("GPT-5.2");
    // The provider glyph is a decorative one-letter family monogram.
    expect(trigger.querySelector(".v2-monogram")).toHaveAttribute("aria-hidden", "true");
    expect(trigger.querySelector(".v2-monogram")?.textContent).toBe("O");
    const surface = screen.getByTestId("composer-v2").textContent ?? "";
    expect(surface).not.toContain("codex-lb.psaux.info");
    expect(surface).not.toContain("ref 0N0FNN");
    expect(surface).not.toContain("Custom OpenAI");
  });

  it("collapses model capabilities to short tags and keeps one human footer line", () => {
    render(<ComposerV2 {...props({ initialLayer: "model", onMakeModelDefault: vi.fn() })} />);

    const option = screen.getByRole("option", { name: /^GPT-5\.2Reasoning/ });
    const tags = within(option).getByTitle(
      "Reasoning · PDF and documents · Images · Web search · Tools · Streaming"
    );
    expect(tags).toHaveTextContent("+3");
    expect(within(option).queryByText("Web search")).toBeNull();

    expect(screen.getByText("Applies to your next message.")).toBeVisible();
    expect(screen.queryByText(/Каталог отфильтрован/)).toBeNull();

    const makeDefault = screen.getByRole("button", {
      name: "Make GPT-5.2 mini your default model"
    });
    expect(makeDefault).toHaveTextContent("Make default");
    expect(makeDefault).toBeVisible();
  });

  it("accepts PDFs through picker, drop, and clipboard with one capability filter", () => {
    const onUploadFiles = vi.fn();
    const onRejectedFiles = vi.fn();
    render(<ComposerV2 {...props({ onRejectedFiles, onUploadFiles })} />);
    const pickerFile = new File(["pdf-picker"], "picker.pdf", { type: "application/pdf" });
    const droppedFile = new File(["pdf-drop"], "dropped.pdf", { type: "application/pdf" });
    const rejectedFile = new File(["binary"], "setup.exe", {
      type: "application/x-msdownload"
    });
    const pastedFile = new File(["pdf-paste"], "pasted.pdf", { type: "application/pdf" });
    const fileInput = screen.getByLabelText("Attach files") as HTMLInputElement;

    expect(fileInput.accept).toContain(".pdf");
    expect(fileInput.accept).toContain("application/pdf");

    fireEvent.change(fileInput, {
      target: { files: [pickerFile] }
    });
    fireEvent.drop(screen.getByTestId("composer-v2-surface"), {
      dataTransfer: {
        dropEffect: "copy",
        files: [droppedFile, rejectedFile],
        types: ["Files"]
      }
    });
    fireEvent.paste(screen.getByRole("textbox", { name: "Message" }), {
      clipboardData: { files: [pastedFile] }
    });

    expect(onUploadFiles).toHaveBeenNthCalledWith(1, [pickerFile]);
    expect(onUploadFiles).toHaveBeenNthCalledWith(2, [droppedFile]);
    expect(onRejectedFiles).toHaveBeenCalledWith([rejectedFile]);
    expect(onUploadFiles).toHaveBeenNthCalledWith(3, [pastedFile]);
  });

  it("keeps draft editing available while a blocking row explains disabled Send", () => {
    const onSend = vi.fn();
    const failed = [{
      fileName: "scan.pdf",
      id: "attachment-failed",
      retryable: true,
      status: "failed" as const
    }];
    const { rerender } = render(<ComposerV2 {...props({
      attachmentItems: failed,
      draft: "Продолжить анализ",
      onRemoveAttachment: vi.fn(),
      onSend
    })} />);

    expect(screen.getByRole("textbox", { name: "Message" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Send message" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Send message" }))
      .toHaveAccessibleDescription(/Retry processing or remove/);

    rerender(<ComposerV2 {...props({
      attachmentItems: [{ fileName: "sales.csv", id: "ready", status: "ready" }],
      draft: "",
      onRemoveAttachment: vi.fn(),
      onSend
    })} />);
    fireEvent.click(screen.getByRole("button", { name: "Send message" }));
    expect(onSend).toHaveBeenCalledOnce();
  });

  it("allows an attachment-only direct PDF after local parser failure", () => {
    const onSend = vi.fn();
    render(<ComposerV2 {...props({
      attachmentItems: [{
        blocksSend: false,
        detail: "Local text extraction failed. The original PDF will be sent directly to the selected provider.",
        fileName: "scan.pdf",
        id: "direct-pdf",
        status: "failed"
      }],
      draft: "",
      onSend
    })} />);

    const send = screen.getByRole("button", { name: "Send message" });
    expect(send).toBeEnabled();
    expect(screen.getByText(/The original PDF will be sent directly/u)).toBeVisible();
    fireEvent.click(send);
    expect(onSend).toHaveBeenCalledOnce();
  });

  it("reports count capacity without silently dropping an accepted selection", () => {
    const onAttachmentCountLimitExceeded = vi.fn();
    const onUploadFiles = vi.fn();
    render(<ComposerV2 {...props({
      attachmentItems: [{
        fileName: "ready.csv",
        id: "ready",
        status: "ready"
      }, {
        fileName: "rejected.exe",
        id: "rejected",
        rejection: "unsupported_format",
        status: "rejected"
      }],
      config: {
        ...composerGalleryConfig,
        catalog: {
          ...composerGalleryConfig.catalog,
          attachmentLimits: {
            ...composerGalleryConfig.catalog.attachmentLimits!,
            maxCount: 1
          }
        }
      },
      onAttachmentCountLimitExceeded,
      onUploadFiles
    })} />);

    fireEvent.change(screen.getByLabelText("Attach files"), {
      target: { files: [new File(["new"], "new.txt", { type: "text/plain" })] }
    });

    expect(onUploadFiles).not.toHaveBeenCalled();
    expect(onAttachmentCountLimitExceeded).toHaveBeenCalledWith({
      attemptedCount: 2,
      currentCount: 1,
      maxCount: 1
    });
  });
});
