import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { composerGalleryConfig } from "@/features/composer-v2/ComposerV2Gallery";
import {
  RunSetupV2,
  TemporaryChatIndicatorV2,
  type RunSetupComposerV2
} from "./PowerAppShellV2View";

const galleryModels = composerGalleryConfig.catalog.models;

function runSetupComposer(overrides: Partial<RunSetupComposerV2> = {}): RunSetupComposerV2 {
  return {
    backgroundMode: false,
    changeBackgroundMode: vi.fn(),
    changeMaxOutputTokens: vi.fn(),
    changeReasoningEffort: vi.fn(),
    changeReasoningMode: vi.fn(),
    changeStreamMode: vi.fn(),
    changeTemperature: vi.fn(),
    currentModel: galleryModels[0],
    currentParameterControls: galleryModels[0]!.parameterControls,
    maxOutputTokens: "8192",
    notificationSoundEnabled: false,
    reasoningEffort: "medium",
    reasoningMode: "",
    searchPlanMode: "all_selected",
    selectSearchPlan: vi.fn(),
    selectedSearchOptionIds: [],
    showCitations: true,
    showReasoningBlocks: false,
    showToolActivity: true,
    streamMode: true,
    temperature: "0.7",
    toggleCitationsVisibility: vi.fn(),
    toggleNotificationSound: vi.fn(),
    toggleReasoningBlockVisibility: vi.fn(),
    toggleToolActivityVisibility: vi.fn(),
    useOrganizationModelDefault: vi.fn(),
    useOrganizationSearchDefault: vi.fn(),
    ...overrides
  };
}

describe("Run setup v2", () => {
  it("names the current model and confirms organization-default resets visibly", () => {
    const composer = runSetupComposer();
    const { rerender } = render(<RunSetupV2 composer={composer} onClose={vi.fn()} />);

    expect(screen.getByTestId("run-setup-current-model")).toHaveTextContent(
      "Текущая модель: GPT-5.2"
    );

    fireEvent.click(screen.getByRole("button", { name: "Использовать модель организации" }));
    expect(composer.useOrganizationModelDefault).toHaveBeenCalledOnce();
    expect(screen.getByTestId("run-setup-defaults-feedback")).toHaveTextContent(
      "Теперь используется модель организации."
    );

    rerender(
      <RunSetupV2
        composer={runSetupComposer({ currentModel: galleryModels[2] })}
        onClose={vi.fn()}
      />
    );
    expect(screen.getByTestId("run-setup-current-model")).toHaveTextContent(
      "Текущая модель: Gemini 3 Pro"
    );

    fireEvent.click(screen.getByRole("button", { name: "Использовать Search организации" }));
    expect(screen.getByTestId("run-setup-defaults-feedback")).toHaveTextContent(
      "Теперь используется Search организации."
    );
  });

  it("renders display toggles as real switches with visible on/off state", () => {
    const composer = runSetupComposer();
    render(<RunSetupV2 composer={composer} onClose={vi.fn()} />);

    const citations = screen.getByRole("switch", { name: /Citations/ });
    expect(citations).toHaveAttribute("aria-checked", "true");
    expect(citations).toHaveTextContent("Shown");
    fireEvent.click(citations);
    expect(composer.toggleCitationsVisibility).toHaveBeenCalledOnce();

    const reasoning = screen.getByRole("switch", { name: /Reasoning blocks/ });
    expect(reasoning).toHaveAttribute("aria-checked", "false");
    expect(reasoning).toHaveTextContent("Hidden");

    const streaming = screen.getByRole("switch", { name: /Streaming/ });
    expect(streaming).toHaveAttribute("aria-checked", "true");
    fireEvent.click(streaming);
    expect(composer.changeStreamMode).toHaveBeenCalledWith(false);
  });
});

describe("Temporary chat indicator v2", () => {
  const memory = {
    explanation: "Временный чат не читает и не записывает личную Память.",
    externalRetention: "Внешние провайдеры могут хранить данные по раскрытым правилам.",
    label: "Временный чат",
    retention: "Полный агрегат чата удаляется через 24 часа.",
    retentionDeadline: "14 августа, 12:00"
  };

  it("stays quiet until clicked, then disclosing the retention explainer", () => {
    render(<TemporaryChatIndicatorV2 memory={memory} />);

    const trigger = screen.getByTestId("header-temporary-indicator");
    expect(trigger).toHaveTextContent("Временный чат");
    expect(screen.queryByRole("dialog")).toBeNull();

    fireEvent.click(trigger);
    const dialog = screen.getByRole("dialog", { name: "Временный чат" });
    expect(dialog).toHaveTextContent("удаляется через 24 часа");
    expect(dialog).toHaveTextContent("Внешние провайдеры");
    expect(screen.getByTestId("temporary-retention-deadline")).toHaveTextContent(
      "14 августа, 12:00"
    );

    fireEvent.keyDown(dialog, { key: "Escape" });
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(trigger).toHaveFocus();
  });
});
