import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { ComposerConfig } from "@/lib/contracts/composerConfig";
import { ComposerV2 } from "./ComposerV2";
import { composerGalleryConfig } from "./ComposerV2Gallery";

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
          editStatusSlot: <div>Отправка создаст новую ветвь; история не изменится.</div>
        })}
      />
    );

    expect(screen.getByText("Отправка создаст новую ветвь; история не изменится."))
      .toBeVisible();
    expect(screen.getByRole("textbox", { name: "Сообщение" })).toBeEnabled();
  });

  it("keeps Temporary intent explicit and exposes truthful context/provider usage", () => {
    const toggleTemporary = vi.fn();
    render(<ComposerV2 {...props({
      contextStats: {
        approximateInputTokens: 8_000,
        safeInputBudgetTokens: 10_000,
        totalContextTokens: 12_000
      },
      memory: {
        canToggleTemporary: true,
        explanation: "История и память включены",
        externalRetention: "Провайдер хранит данные по своей политике",
        label: "Временный чат",
        mode: "NORMAL",
        retention: "Удалится через 24 часа",
        retentionDeadline: null,
        toggleTemporary
      },
      usageStats: {
        activeBranchMessageCount: 4,
        cachedInputTokens: 300,
        cacheWriteInputTokens: 50,
        totalTokens: 2_400
      }
    })} />);

    fireEvent.click(screen.getByRole("button", { name: "Обычный чат" }));
    expect(toggleTemporary).toHaveBeenCalledOnce();

    const context = screen.getByRole("button", {
      name: /80% of the 10k safe input budget/u
    });
    expect(context).toHaveAttribute("data-context-tone", "warning");
    fireEvent.click(context);

    const dialog = screen.getByRole("dialog", { name: "Context and usage statistics" });
    expect(dialog).toHaveTextContent("Provider-reported tokens2.4k");
    expect(dialog).toHaveTextContent("Total messages4");
  });

  it("sends on Enter, preserves Shift+Enter, and ignores every IME fallback", () => {
    const onSend = vi.fn();
    render(<ComposerV2 {...props({ onSend })} />);
    const input = screen.getByRole("textbox", { name: "Сообщение" });

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
    const trigger = screen.getByRole("button", { name: /OpenAI · рабочий.*GPT-5.2/ });
    fireEvent.click(trigger);
    const search = screen.getByRole("searchbox", { name: "Найти модель" });
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
    await waitFor(() => expect(screen.getByRole("searchbox", { name: "Найти модель" })).toHaveFocus());
    fireEvent.keyDown(screen.getByRole("searchbox", { name: "Найти модель" }), { key: "Escape" });
    expect(screen.queryByRole("dialog", { name: "Выбор модели" })).toBeNull();
    await waitFor(() => expect(trigger).toHaveFocus());
  });

  it("changes only explicit capability selections and keeps revoked choices removable", () => {
    const onKnowledge = vi.fn();
    const onSearch = vi.fn();
    const onToggleMcp = vi.fn();
    render(<ComposerV2 {...props({
      initialLayer: "capabilities",
      onSelectKnowledgeBaseIds: onKnowledge,
      onSelectSearchOptionIds: onSearch,
      onToggleMcpServer: onToggleMcp,
      selectedKnowledgeBaseIds: ["kb-finance", "missing-base"]
    })} />);

    fireEvent.click(screen.getByRole("menuitemcheckbox", { name: /Research Search/ }));
    expect(onSearch).toHaveBeenCalledWith(["web-primary", "research-search"]);
    fireEvent.click(screen.getByRole("menuitemcheckbox", { name: /Финансы 2026/ }));
    expect(onKnowledge).toHaveBeenCalledWith(["missing-base"]);
    fireEvent.click(screen.getByRole("menuitemcheckbox", { name: /Недоступная база/ }));
    expect(onKnowledge).toHaveBeenCalledWith(["kb-finance"]);
    fireEvent.click(screen.getByRole("menuitemcheckbox", { name: /office-compute/ }));
    expect(onToggleMcp).toHaveBeenCalledWith("mcp-office", false);
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

    fireEvent.click(screen.getByRole("menuitemcheckbox", { name: /Использовать Assistant/ }));
    expect(onOpenAssistantPicker).toHaveBeenCalledOnce();
    expect(screen.getByTestId("composer-assistant-removed-notice")).toHaveTextContent(
      "действуют ваши ручные настройки"
    );
    fireEvent.click(screen.getByRole("button", { name: "Закрыть" }));
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
    expect(screen.getByRole("button", { name: /OpenAI · рабочий.*GPT-5.2/ })).toBeDisabled();
    const searchRows = screen.getAllByRole("menuitemcheckbox", { name: /Web Search/ });
    expect(searchRows[0]).toBeDisabled();
    expect(screen.getAllByText("Управляется Assistant").length).toBeGreaterThan(2);
    fireEvent.click(screen.getByRole("button", { name: "Убрать" }));
    expect(onRemoveAssistant).toHaveBeenCalledOnce();
    expect(onSelectSearch).not.toHaveBeenCalled();
  });

  it("keeps loading, malformed, and zero-entitlement authority states explicit", () => {
    const retry = vi.fn();
    const { rerender } = render(<ComposerV2 {...props({ config: null, draft: "" })} />);
    expect(screen.getByRole("status")).toHaveTextContent("Загружаем доступные возможности…");
    expect(screen.getByRole("textbox", { name: "Сообщение" })).toBeDisabled();

    rerender(<ComposerV2 {...props({ config: null, configError: true, draft: "", onRetryConfig: retry })} />);
    expect(screen.getByRole("alert")).toHaveTextContent("Не удалось загрузить доступные возможности.");
    fireEvent.click(screen.getByRole("button", { name: "Повторить" }));
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
      "Нет доступных моделей. Обратитесь к администратору."
    );
    expect(screen.getByRole("button", { name: "Отправить сообщение" })).toBeDisabled();
  });

  it("never renders opaque provider, model, Knowledge, or MCP bindings", () => {
    const { container } = render(<ComposerV2 {...props() } />);
    const text = container.textContent ?? "";
    expect(text).not.toContain("openai-work");
    expect(text).not.toContain("kb-finance");
    expect(text).not.toContain("mcp-office");
  });

  it("routes picker, drop, and clipboard files through one capability filter", () => {
    const onUploadFiles = vi.fn();
    const onRejectedFiles = vi.fn();
    render(<ComposerV2 {...props({ onRejectedFiles, onUploadFiles })} />);
    const pickerFile = new File(["notes"], "notes.txt", { type: "text/plain" });
    const droppedFile = new File(["binary"], "setup.exe", {
      type: "application/x-msdownload"
    });
    const pastedFile = new File(["pdf"], "brief.pdf", { type: "application/pdf" });

    fireEvent.change(screen.getByLabelText("Прикрепить файлы"), {
      target: { files: [pickerFile] }
    });
    fireEvent.drop(screen.getByTestId("composer-v2-surface"), {
      dataTransfer: { dropEffect: "copy", files: [droppedFile], types: ["Files"] }
    });
    fireEvent.paste(screen.getByRole("textbox", { name: "Сообщение" }), {
      clipboardData: { files: [pastedFile] }
    });

    expect(onUploadFiles).toHaveBeenNthCalledWith(1, [pickerFile]);
    expect(onRejectedFiles).toHaveBeenCalledWith([droppedFile]);
    expect(onUploadFiles).toHaveBeenNthCalledWith(2, [pastedFile]);
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

    expect(screen.getByRole("textbox", { name: "Сообщение" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Отправить сообщение" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Отправить сообщение" }))
      .toHaveAccessibleDescription(/Повторите обработку или удалите файл/);

    rerender(<ComposerV2 {...props({
      attachmentItems: [{ fileName: "sales.csv", id: "ready", status: "ready" }],
      draft: "",
      onRemoveAttachment: vi.fn(),
      onSend
    })} />);
    fireEvent.click(screen.getByRole("button", { name: "Отправить сообщение" }));
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

    fireEvent.change(screen.getByLabelText("Прикрепить файлы"), {
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
