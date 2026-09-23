import { fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import type { SearchPlan } from "@/lib/domain/search";
import { SearchPlanPickerV2 } from "./SearchPlanPickerV2";

const options = ["One", "Two", "Three", "Four"].map(name => ({ strategyId: name, displayName: name, kind: "web_search" as const }));

describe("Search source selection", () => {
  it("combines sources, enforces the limit, changes mode and turns search off explicitly", () => {
    const reset = vi.fn();
    function Picker() {
      const [plan, setPlan] = useState<SearchPlan>({ mode: "all_selected", optionIds: [] });
      return <SearchPlanPickerV2 options={options} plan={plan} onChange={setPlan} onReset={reset} scope="defaults" />;
    }
    render(<Picker />);
    for (const name of ["One", "Two", "Three"]) fireEvent.click(screen.getByRole("checkbox", { name }));
    expect(screen.getByRole("checkbox", { name: /Four/ })).toBeDisabled();
    fireEvent.click(screen.getByRole("checkbox", { name: "Two" }));
    fireEvent.click(screen.getByRole("checkbox", { name: "Four" }));
    expect(screen.getByRole("checkbox", { name: "One" })).toBeChecked();
    fireEvent.change(screen.getByRole("combobox"), { target: { value: "model_choice" } });
    expect(screen.getByText(/The model decides which/)).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Use organization Search default" }));
    expect(reset).toHaveBeenCalledOnce();
    fireEvent.click(screen.getByRole("button", { name: "Turn off search" }));
    expect(screen.getByText("0 of 3 sources")).toBeVisible();
  });

  it("explains incompatible combinations and retains unavailable choices until removed", () => {
    const onChange = vi.fn();
    const source = { ...options[0], executionModes: ["model_choice" as const] };
    const { rerender } = render(<SearchPlanPickerV2 options={[source, options[1]]}
      plan={{ mode: "all_selected", optionIds: ["One"] }} onChange={onChange} scope="chat" />);
    expect(screen.getByRole("checkbox", { name: /Two/ })).toBeDisabled();
    expect(screen.getByText(/Select “Let the model choose”/)).toBeVisible();
    rerender(<SearchPlanPickerV2 options={options} availableIds={new Set()} plan={{ mode: "model_choice", optionIds: ["One", "missing"] }} onChange={onChange} scope="chat" />);
    expect(screen.getByRole("checkbox", { name: /One/ })).toBeEnabled();
    fireEvent.click(screen.getByRole("checkbox", { name: /Unavailable source/ }));
    expect(onChange).toHaveBeenCalledWith({ mode: "model_choice", optionIds: ["One"] });
  });
});
