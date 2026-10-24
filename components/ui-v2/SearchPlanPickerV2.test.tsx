import { fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { MAX_SEARCH_PLAN_OPTIONS } from "@/lib/domain/search";
import { SearchPlanPickerV2 } from "./SearchPlanPickerV2";

const options = ["One", "Two", "Three", "Four"].map(name => ({
  strategyId: name, displayName: name, description: `${name} grounding for eligible models`, kind: "web_search" as const
}));

describe("Search source selection", () => {
  it("lists only the sources: no mode, descriptions, turn-off or organization link", () => {
    render(<SearchPlanPickerV2 options={options} selectedIds={["One"]} onChange={vi.fn()} />);
    expect(screen.getAllByRole("checkbox").map(box => box.closest("label")?.textContent))
      .toEqual(["One", "Two", "Three", "Four"]);
    expect(screen.queryByRole("combobox")).toBeNull();
    expect(screen.queryByRole("button")).toBeNull();
    expect(screen.queryByText(/grounding for eligible/u)).toBeNull();
    expect(screen.queryByText(/Let the model choose|Saved for this chat|Each search sends/u)).toBeNull();
  });

  it("combines sources up to the limit and never unchecks the last one", () => {
    const onChange = vi.fn();
    function Picker() {
      const [ids, setIds] = useState<readonly string[]>(["One"]);
      return <SearchPlanPickerV2 options={options} selectedIds={ids} lastSourceNote="To turn search off, use Chat defaults in Studio."
        onChange={next => { onChange(next); setIds(next); }} />;
    }
    render(<Picker />);
    expect(screen.getByRole("checkbox", { name: /One/u })).toBeDisabled();
    expect(screen.getByText("To turn search off, use Chat defaults in Studio.")).toBeVisible();
    for (const name of ["Two", "Three"]) fireEvent.click(screen.getByRole("checkbox", { name }));
    expect(screen.getByRole("checkbox", { name: /Four/u })).toBeDisabled();
    expect(screen.getByRole("checkbox", { name: /Four/u }).closest("label")).toHaveTextContent(`Choose up to ${MAX_SEARCH_PLAN_OPTIONS} sources`);
    fireEvent.click(screen.getByRole("checkbox", { name: "Two" }));
    fireEvent.click(screen.getByRole("checkbox", { name: "Three" }));
    expect(onChange).toHaveBeenLastCalledWith(["One"]);
    expect(screen.getByRole("checkbox", { name: /One/u })).toBeChecked();
    expect(screen.getByRole("checkbox", { name: /One/u })).toBeDisabled();
  });

  it("turns search on from Off by checking a source", () => {
    const onChange = vi.fn();
    render(<SearchPlanPickerV2 options={options.slice(0, 2)} selectedIds={[]} onChange={onChange} />);
    expect(screen.getByText("Search off")).toBeVisible();
    fireEvent.click(screen.getByRole("checkbox", { name: "Two" }));
    expect(onChange).toHaveBeenCalledWith(["Two"]);
  });

  it("lets an Assistant's adjustable row be emptied", () => {
    const onChange = vi.fn();
    render(<SearchPlanPickerV2 allowEmpty options={options} selectedIds={["One"]} onChange={onChange} />);
    fireEvent.click(screen.getByRole("checkbox", { name: "One" }));
    expect(onChange).toHaveBeenCalledWith([]);
  });

  it("replaces a selection a source cannot join, and retains unavailable choices until removed", () => {
    const onChange = vi.fn();
    // One reaches this model only through its provider's own Search, so it searches alone.
    const source = { ...options[0], executionModes: ["model_choice" as const] };
    const { rerender } = render(<SearchPlanPickerV2 options={[source, options[1]]}
      selectedIds={["One"]} onChange={onChange} />);
    expect(screen.getByRole("checkbox", { name: /Two/u })).toBeEnabled();
    expect(screen.getByText("Replaces the selected source")).toBeVisible();
    fireEvent.click(screen.getByRole("checkbox", { name: /Two/u }));
    expect(onChange).toHaveBeenLastCalledWith(["Two"]);
    // A last selected source that is no longer listed is replaced the same way.
    rerender(<SearchPlanPickerV2 options={options.slice(1, 2)} selectedIds={["gone"]} onChange={onChange} />);
    fireEvent.click(screen.getByRole("checkbox", { name: /Two/u }));
    expect(onChange).toHaveBeenLastCalledWith(["Two"]);
    rerender(<SearchPlanPickerV2 options={options} availableIds={new Set()} selectedIds={["One", "missing"]} onChange={onChange} />);
    expect(screen.getByRole("checkbox", { name: /One/u })).toBeEnabled();
    expect(screen.getByRole("checkbox", { name: /One/u }).closest("label")).toHaveTextContent("Unavailable for this model");
    fireEvent.click(screen.getByRole("checkbox", { name: /Unavailable source/u }));
    expect(onChange).toHaveBeenCalledWith(["One"]);
  });
});
