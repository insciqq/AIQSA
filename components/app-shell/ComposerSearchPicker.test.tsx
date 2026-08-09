import { ComposerSearchPicker } from "@/components/app-shell/ComposerSearchPicker";
import type { CatalogSearchStrategy } from "@/components/app-shell/types";
import type { SearchPlanMode } from "@/lib/domain/search";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";

const options: CatalogSearchStrategy[] = [
  {
    adapterKind: "provider_model_client",
    displayName: "Alpha Search",
    executionModes: ["all_selected", "model_choice"],
    kind: "provider_model_web_search",
    privacy: "query_only",
    protocol: "openai_responses_web_search",
    revisionId: "revision-alpha",
    strategyId: "alpha"
  },
  {
    adapterKind: "provider_model_client",
    displayName: "Beta Search",
    executionModes: ["all_selected", "model_choice"],
    kind: "provider_model_web_search",
    privacy: "query_only",
    protocol: "openai_responses_web_search",
    revisionId: "revision-beta",
    strategyId: "beta"
  },
  {
    adapterKind: "answer_provider_hosted",
    displayName: "Hosted Search",
    executionModes: ["model_choice"],
    kind: "openai_native_web_search",
    privacy: "answer_provider",
    protocol: "openai_responses_web_search",
    revisionId: "revision-hosted",
    strategyId: "hosted"
  },
  {
    adapterKind: "provider_model_client",
    displayName: "Gamma Search",
    executionModes: ["all_selected", "model_choice"],
    kind: "provider_model_web_search",
    privacy: "query_only",
    protocol: "openai_responses_web_search",
    revisionId: "revision-gamma",
    strategyId: "gamma"
  },
  {
    adapterKind: "answer_provider_hosted",
    displayName: "Gemini Search",
    executionModes: ["model_choice"],
    kind: "gemini_google_search",
    privacy: "answer_provider",
    protocol: "gemini_google_search",
    revisionId: "revision-gemini",
    strategyId: "gemini"
  }
];

function ControlledPicker({ onChange = vi.fn() }: Readonly<{
  onChange?(optionIds: readonly string[], mode: SearchPlanMode): void;
}>) {
  const [selected, setSelected] = useState<string[]>([]);
  const [mode, setMode] = useState<SearchPlanMode>("all_selected");
  return (
    <ComposerSearchPicker
      disabled={false}
      id="search-test"
      mode={mode}
      onChange={(optionIds, nextMode) => {
        setSelected(optionIds);
        setMode(nextMode);
        onChange(optionIds, nextMode);
      }}
      options={options}
      selectedOptionIds={selected}
    />
  );
}

describe("ComposerSearchPicker", () => {
  it("owns nested Escape and restores focus without closing an outer dialog", async () => {
    render(
      <div aria-label="Outer setup" role="dialog">
        <ControlledPicker />
      </div>
    );
    const trigger = screen.getByRole("button", { name: "Search strategy" });
    fireEvent.click(trigger);
    const dialog = screen.getByRole("dialog", { name: "Choose Search engines" });

    await waitFor(() => expect(within(dialog).getByRole("button", { name: "Close Search picker" })).toHaveFocus());
    fireEvent.keyDown(document.activeElement!, { key: "Escape" });

    expect(screen.queryByRole("dialog", { name: "Choose Search engines" })).not.toBeInTheDocument();
    expect(screen.getByRole("dialog", { name: "Outer setup" })).toBeVisible();
    await waitFor(() => expect(trigger).toHaveFocus());
  });

  it("keeps an exact custom source name in the narrow trigger", () => {
    render(
      <ComposerSearchPicker
        disabled={false}
        id="search-custom-label"
        mode="model_choice"
        onChange={vi.fn()}
        options={options}
        selectedOptionIds={["alpha"]}
      />
    );

    const trigger = screen.getByRole("button", { name: "Search strategy" });
    const labels = within(trigger).getAllByText("Alpha Search");
    expect(labels).toHaveLength(2);
    expect(labels[0]).toHaveClass("min-[430px]:hidden");
    expect(labels[1]).toHaveClass("hidden", "min-[430px]:inline");
  });

  it("moves keyboard focus across enabled Search options", async () => {
    render(<ControlledPicker />);
    fireEvent.click(screen.getByRole("button", { name: "Search strategy" }));
    const dialog = screen.getByRole("dialog", { name: "Choose Search engines" });

    await waitFor(() => expect(within(dialog).getByRole("button", { name: "Close Search picker" })).toHaveFocus());
    fireEvent.keyDown(document.activeElement!, { key: "End" });
    expect(dialog.querySelector('[data-option-value="gemini"]')).toHaveFocus();
    fireEvent.keyDown(document.activeElement!, { key: "Home" });
    expect(dialog.querySelector('[data-option-value="search-disabled"]')).toHaveFocus();
    fireEvent.keyDown(document.activeElement!, { key: "ArrowUp" });
    expect(dialog.querySelector('[data-option-value="gemini"]')).toHaveFocus();
    fireEvent.keyDown(document.activeElement!, { key: "ArrowDown" });
    expect(dialog.querySelector('[data-option-value="search-disabled"]')).toHaveFocus();

    fireEvent.click(within(dialog).getByRole("button", { name: /Alpha Search/i }));
    fireEvent.click(within(dialog).getByRole("button", { name: /Beta Search/i }));
    const mode = within(dialog).getByRole("radio", { name: /Model chooses/i });
    mode.focus();
    fireEvent.keyDown(mode, { key: "ArrowDown" });
    expect(mode).toHaveFocus();
  });

  it("keeps non-modal outside dismissal and the compact safe-area touch recipe", async () => {
    render(
      <div>
        <ControlledPicker />
        <button type="button">Outside Search picker</button>
      </div>
    );
    const trigger = screen.getByRole("button", { name: "Search strategy" });
    trigger.focus();
    fireEvent.click(trigger);
    const dialog = screen.getByRole("dialog", { name: "Choose Search engines" });
    const close = within(dialog).getByRole("button", { name: "Close Search picker" });

    expect(dialog).not.toHaveAttribute("aria-modal");
    expect(dialog.className).toContain("--composer-picker-safe-area-inset-left");
    expect(dialog.className).toContain("--composer-picker-safe-area-inset-right");
    expect(dialog.className).toContain("--composer-picker-safe-area-inset-top");
    expect(dialog.className).toContain("--composer-picker-safe-area-inset-bottom");
    expect(close).toHaveClass(
      "size-11",
      "sm:size-8",
      "[@media(hover:none)]:!size-11",
      "[@media(pointer:coarse)]:!size-11"
    );
    await waitFor(() => expect(close).toHaveFocus());

    fireEvent.pointerDown(screen.getByRole("button", { name: "Outside Search picker" }));

    expect(screen.queryByRole("dialog", { name: "Choose Search engines" })).not.toBeInTheDocument();
    await waitFor(() => expect(trigger).toHaveFocus());
  });

  it("owns an ordered zero-to-three selection and exposes both orchestration modes", () => {
    const onChange = vi.fn();
    render(<ControlledPicker onChange={onChange} />);
    fireEvent.click(screen.getByRole("button", { name: "Search strategy" }));
    const dialog = screen.getByRole("dialog", { name: "Choose Search engines" });

    fireEvent.click(within(dialog).getByRole("button", { name: /Alpha Search/i }));
    fireEvent.click(within(dialog).getByRole("button", { name: /Beta Search/i }));
    expect(screen.getByRole("button", { name: "Search strategy" })).toHaveTextContent("2 engines");
    expect(within(dialog).getByRole("radio", { name: /All selected/i })).toBeChecked();
    fireEvent.click(within(dialog).getByRole("radio", { name: /Model chooses/i }));
    expect(onChange).toHaveBeenLastCalledWith(["alpha", "beta"], "model_choice");

    fireEvent.click(within(dialog).getByRole("button", { name: /Gamma Search/i }));
    expect(within(dialog).getByRole("button", { name: /Hosted Search/i })).toBeDisabled();
    expect(onChange).toHaveBeenLastCalledWith(["alpha", "beta", "gamma"], "model_choice");

    fireEvent.click(within(dialog).getByRole("button", { name: /^Off/i }));
    expect(screen.getByRole("button", { name: "Search strategy" })).toHaveTextContent("Off");
    expect(onChange).toHaveBeenLastCalledWith([], "all_selected");
  });

  it("moves to model-choice mode when a selected engine cannot participate in fan-out", () => {
    const onChange = vi.fn();
    render(<ControlledPicker onChange={onChange} />);
    fireEvent.click(screen.getByRole("button", { name: "Search strategy" }));
    const dialog = screen.getByRole("dialog", { name: "Choose Search engines" });
    fireEvent.click(within(dialog).getByRole("button", { name: /Alpha Search/i }));
    fireEvent.click(within(dialog).getByRole("button", { name: /Hosted Search/i }));

    expect(onChange).toHaveBeenLastCalledWith(["alpha", "hosted"], "model_choice");
    expect(within(dialog).getByRole("radio", { name: /All selected/i })).toBeDisabled();
    expect(within(dialog).getByText(/Model chooses is required/)).toBeVisible();
  });

  it("keeps a logical hosted engine selectable so server admission can choose a client route", () => {
    const onChange = vi.fn();
    render(<ControlledPicker onChange={onChange} />);
    fireEvent.click(screen.getByRole("button", { name: "Search strategy" }));
    const dialog = screen.getByRole("dialog", { name: "Choose Search engines" });
    fireEvent.click(within(dialog).getByRole("button", { name: /Alpha Search/i }));

    const gemini = within(dialog).getByRole("button", { name: /Gemini Search/i });
    expect(gemini).toBeEnabled();
    fireEvent.click(gemini);
    expect(onChange).toHaveBeenLastCalledWith(["alpha", "gemini"], "model_choice");
  });
});
