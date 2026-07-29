import { ComposerSearchPicker } from "@/components/app-shell/ComposerSearchPicker";
import type { CatalogSearchStrategy } from "@/components/app-shell/types";
import type { SearchPlanMode } from "@/lib/domain/search";
import { fireEvent, render, screen, within } from "@testing-library/react";
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
    displayName: "Exclusive Gemini Search",
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

  it("disables an exclusive native engine when another engine is selected", () => {
    render(<ControlledPicker />);
    fireEvent.click(screen.getByRole("button", { name: "Search strategy" }));
    const dialog = screen.getByRole("dialog", { name: "Choose Search engines" });
    fireEvent.click(within(dialog).getByRole("button", { name: /Alpha Search/i }));

    expect(within(dialog).getByRole("button", { name: /Exclusive Gemini Search/i }))
      .toBeDisabled();
  });
});
