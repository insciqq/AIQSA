import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import {
  composerGalleryAssistant,
  composerGalleryConfig
} from "@/app/ui-v2-fixture/_fixtures/ComposerV2Gallery";
import { RunSetupV2, type RunSetupComposerV2 } from "./RunSetupV2";

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
    reasoningEffort: "high",
    reasoningMode: "",
    searchPlanMode: "all_selected",
    selectSearchPlan: vi.fn(),
    selectedSearchOptionIds: [],
    streamMode: true,
    temperature: "0.7",
    useOrganizationModelDefault: vi.fn(),
    useOrganizationSearchDefault: vi.fn(),
    ...overrides
  };
}

function assistant(
  input: Parameters<typeof composerGalleryAssistant>[0] = {},
  resetRow = vi.fn()
): NonNullable<RunSetupComposerV2["assistant"]> {
  return { current: composerGalleryAssistant(input), resetRow };
}

describe("Run setup v2 with an Assistant", () => {
  it("shows fixed parameters with the effective reasoning effort and disabled fields (A-14)", () => {
    const composer = runSetupComposer({
      assistant: assistant({ policies: { controls: "fixed", model: "fixed" } })
    });
    render(<RunSetupV2 composer={composer} onClose={vi.fn()} />);

    expect(screen.getByTestId("assistant-row-provenance")).toHaveTextContent("Fixed by the Assistant");
    const effort = screen.getByRole("combobox", { name: "Reasoning effort" });
    expect(effort).toHaveValue("high");
    expect(effort).toBeDisabled();
    expect(screen.getByRole("spinbutton", { name: "Temperature" })).toBeDisabled();
    expect(screen.getByRole("spinbutton", { name: "Max output tokens" })).toBeDisabled();
    expect(screen.getByRole("switch", { name: /Streaming/ })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Reset output settings" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Use organization model default" })).toBeDisabled();
  });

  it("keeps adjustable parameters editable and resets them to the Assistant after a change", () => {
    const resetRow = vi.fn();
    const composer = runSetupComposer({ assistant: assistant({}, resetRow) });
    const { rerender } = render(<RunSetupV2 composer={composer} onClose={vi.fn()} />);

    const line = screen.getByTestId("assistant-row-provenance");
    expect(line).toHaveTextContent("From Research editor · adjustable for this chat");
    expect(line).toHaveTextContent("unchanged");
    fireEvent.change(screen.getByRole("combobox", { name: "Reasoning effort" }), { target: { value: "low" } });
    expect(composer.changeReasoningEffort).toHaveBeenCalledWith("low");

    rerender(<RunSetupV2
      composer={runSetupComposer({
        assistant: assistant({ origins: { controls: "chat" } }, resetRow),
        reasoningEffort: "low"
      })}
      onClose={vi.fn()}
    />);
    fireEvent.click(screen.getByRole("button", { name: "Reset to Assistant" }));
    expect(resetRow).toHaveBeenCalledWith("controls");
  });

  it("with a fixed model and parameters left to the user, edits them and resets after a change (A-14)", () => {
    const resetRow = vi.fn();
    const composer = runSetupComposer({
      assistant: assistant({
        assistantValues: { controls: {} },
        origins: { controls: "default" },
        policies: { model: "fixed" }
      }, resetRow)
    });
    const { rerender } = render(<RunSetupV2 composer={composer} onClose={vi.fn()} />);

    expect(screen.queryByTestId("assistant-row-provenance")).toBeNull();
    const effort = screen.getByRole("combobox", { name: "Reasoning effort" });
    expect(effort).toHaveValue("high");
    expect(effort).toBeEnabled();
    fireEvent.change(effort, { target: { value: "low" } });
    expect(composer.changeReasoningEffort).toHaveBeenCalledWith("low");
    // The model is fixed, so the organization's model cannot replace it.
    expect(screen.getByRole("button", { name: "Use organization model default" })).toBeDisabled();

    rerender(<RunSetupV2
      composer={runSetupComposer({
        assistant: assistant({
          assistantValues: { controls: {} },
          origins: { controls: "chat" },
          policies: { model: "fixed" }
        }, resetRow),
        reasoningEffort: "low"
      })}
      onClose={vi.fn()}
    />);
    expect(screen.getByTestId("assistant-row-provenance")).toHaveTextContent("Changed for this chat");
    fireEvent.click(screen.getByRole("button", { name: "Reset to Assistant" }));
    expect(resetRow).toHaveBeenCalledWith("controls");
  });

  it("uses the user's defaults for another model, editable whatever the policy", () => {
    const composer = runSetupComposer({
      assistant: assistant({
        origins: { controls: "default", model: "chat" },
        policies: { controls: "fixed" },
        values: { model: { mode: "model", modelId: "gpt-5.2-mini" } }
      }),
      currentModel: galleryModels[1],
      currentParameterControls: galleryModels[1]!.parameterControls,
      reasoningEffort: "medium"
    });
    render(<RunSetupV2 composer={composer} onClose={vi.fn()} />);

    expect(screen.getByTestId("run-setup-own-defaults"))
      .toHaveTextContent("Parameters: your defaults for GPT-5.2 mini");
    expect(screen.queryByTestId("assistant-row-provenance")).toBeNull();
    expect(screen.getByRole("combobox", { name: "Reasoning effort" })).toBeEnabled();
    expect(screen.getByRole("spinbutton", { name: "Temperature" })).toBeEnabled();
  });

  it("shows no Assistant line without an Assistant", () => {
    render(<RunSetupV2 composer={runSetupComposer()} onClose={vi.fn()} />);

    expect(screen.queryByTestId("assistant-row-provenance")).toBeNull();
    expect(screen.queryByTestId("run-setup-own-defaults")).toBeNull();
    expect(screen.getByRole("combobox", { name: "Reasoning effort" })).toBeEnabled();
  });
});

describe("Run setup v2 Max output tokens with Agent", () => {
  const agent = (enabled: boolean) => ({ enabled, setEnabled: vi.fn() });
  // The fixture model: 200,000-token context window, default 8,192, maximum 128,000.
  const field = () => screen.getByRole("spinbutton", { name: "Max output tokens" });

  it("bounds typed values by half the context window only while Agent is on", () => {
    const changeMaxOutputTokens = vi.fn();
    const { rerender } = render(<RunSetupV2 composer={runSetupComposer({ agent: agent(true), changeMaxOutputTokens })}
      onClose={vi.fn()} />);
    expect(field()).toHaveAttribute("max", "100000");
    fireEvent.change(field(), { target: { value: "120000" } });
    expect(changeMaxOutputTokens).toHaveBeenLastCalledWith("100000");
    fireEvent.change(field(), { target: { value: "90000" } });
    expect(changeMaxOutputTokens).toHaveBeenLastCalledWith("90000");
    expect(screen.queryByTestId("run-setup-agent-output-limit")).toBeNull();

    rerender(<RunSetupV2 composer={runSetupComposer({ agent: agent(false), changeMaxOutputTokens })} onClose={vi.fn()} />);
    expect(field()).toHaveAttribute("max", "128000");
    fireEvent.change(field(), { target: { value: "120000" } });
    expect(changeMaxOutputTokens).toHaveBeenLastCalledWith("120000");
  });

  it("keeps a saved value above the limit, says why it is refused and offers the limit or a reset", () => {
    const changeMaxOutputTokens = vi.fn();
    render(<RunSetupV2 composer={runSetupComposer({ agent: agent(true), changeMaxOutputTokens, maxOutputTokens: "120000" })}
      onClose={vi.fn()} />);
    expect(field()).toHaveValue(120000);
    expect(field()).toHaveAttribute("aria-invalid", "true");
    expect(changeMaxOutputTokens).not.toHaveBeenCalled();
    expect(screen.getByRole("alert")).toHaveTextContent(
      "Agent allows at most 100,000 output tokens with this model (half of its context window). Lower the value or reset output settings to send.");
    fireEvent.click(screen.getByRole("button", { name: "Use 100,000" }));
    expect(changeMaxOutputTokens).toHaveBeenLastCalledWith("100000");
    fireEvent.click(screen.getByRole("button", { name: "Reset output settings" }));
    expect(changeMaxOutputTokens).toHaveBeenLastCalledWith("8192");
  });

  it("notes, without refusing, a model default above the limit", () => {
    const model = { ...galleryModels[0]!, contextWindow: 8_000 };
    render(<RunSetupV2 composer={runSetupComposer({ agent: agent(true), currentModel: model })} onClose={vi.fn()} />);
    expect(field()).not.toHaveAttribute("aria-invalid");
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.getByTestId("run-setup-agent-output-limit"))
      .toHaveTextContent("Agent answers with this model use at most 4,000 output tokens.");
  });
});
