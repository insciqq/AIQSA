import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { useMemo, useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { useComposerPickerSession } from "./composerPicker";

const items = ["Alpha", "Bravo", "Charlie"];
const searchScrollMargins = {};

function FinitePicker({ disabled = false, onSelect = vi.fn() }: { disabled?: boolean; onSelect?(item: string): void }) {
  const {
    boundaryProps,
    boundaryRef,
    dialogProps,
    dialogRef,
    getItemProps,
    open,
    toggle,
    triggerProps,
    triggerRef
  } = useComposerPickerSession({
    dialogId: "finite-picker-dialog",
    disabled,
    initialFocus: "selected",
    items,
    onSelect,
    openFromTriggerKeys: true,
    selectedIndex: 1
  });

  return (
    <div {...boundaryProps} ref={boundaryRef}>
      <button {...triggerProps} ref={triggerRef} type="button" disabled={disabled} onClick={toggle}>Choose item</button>
      {open ? (
        <div {...dialogProps} ref={dialogRef} aria-label="Finite picker">
          {items.map((item, index) => (
            <button key={item} {...getItemProps(index)} type="button">{item}</button>
          ))}
        </div>
      ) : null}
    </div>
  );
}

function SearchPicker({
  controlled = false,
  onSelect = vi.fn()
}: {
  controlled?: boolean;
  onSelect?(item: string): void;
}) {
  const [controlledOpen, setControlledOpen] = useState(false);
  const [query, setQuery] = useState("");
  const filteredItems = useMemo(
    () => items.filter((item) => item.toLowerCase().includes(query.toLowerCase())),
    [query]
  );
  const {
    boundaryProps,
    boundaryRef,
    dialogProps,
    dialogRef,
    getItemProps,
    handleSearchKeyDown,
    open,
    resultsRef,
    searchRef,
    setActiveIndex,
    toggle,
    triggerProps,
    triggerRef
  } = useComposerPickerSession({
    dialogId: "search-picker-dialog",
    initialFocus: "search",
    itemFocusPreventScroll: true,
    items: filteredItems,
    onClose: () => setQuery(""),
    onOpenChange: controlled ? setControlledOpen : undefined,
    onSelect,
    open: controlled ? controlledOpen : undefined,
    scrollMargins: searchScrollMargins,
    selectedIndex: 0
  });

  return (
    <>
      <div {...boundaryProps} ref={boundaryRef}>
        <button {...triggerProps} ref={triggerRef} type="button" onClick={toggle}>Search items</button>
        {open ? (
          <div {...dialogProps} ref={dialogRef} aria-label="Search picker">
            <input
              ref={searchRef}
              aria-label="Filter items"
              value={query}
              onChange={(event) => {
                setActiveIndex(0);
                setQuery(event.target.value);
              }}
              onKeyDown={handleSearchKeyDown}
            />
            <div ref={resultsRef}>
              {filteredItems.map((item, index) => (
                <button key={item} {...getItemProps(index)} type="button">{item}</button>
              ))}
            </div>
          </div>
        ) : null}
      </div>
      <button type="button">Outside</button>
    </>
  );
}

describe("useComposerPickerSession", () => {
  it("owns finite-option roving focus, trigger keys, hover, selection, and opener restoration", async () => {
    const onSelect = vi.fn();
    render(<FinitePicker onSelect={onSelect} />);
    const trigger = screen.getByRole("button", { name: "Choose item" });

    fireEvent.keyDown(trigger, { key: "ArrowDown", keyCode: 229 });
    expect(screen.queryByRole("dialog", { name: "Finite picker" })).not.toBeInTheDocument();

    fireEvent.keyDown(trigger, { key: "ArrowUp" });
    const dialog = screen.getByRole("dialog", { name: "Finite picker" });
    expect(trigger).toHaveAttribute("aria-expanded", "true");
    expect(trigger).toHaveAttribute("aria-controls", "finite-picker-dialog");
    const alpha = within(dialog).getByRole("button", { name: "Alpha" });
    const charlie = within(dialog).getByRole("button", { name: "Charlie" });
    await waitFor(() => expect(charlie).toHaveFocus());

    fireEvent.mouseMove(alpha);
    expect(charlie).toHaveFocus();
    expect(alpha).toHaveAttribute("tabindex", "0");
    expect(charlie).toHaveAttribute("tabindex", "-1");

    fireEvent.keyDown(charlie, { key: "Home" });
    expect(alpha).toHaveFocus();
    fireEvent.keyDown(alpha, { key: "ArrowUp" });
    expect(charlie).toHaveFocus();
    fireEvent.keyDown(charlie, { key: "Enter" });

    expect(onSelect).toHaveBeenCalledWith("Charlie");
    expect(screen.queryByRole("dialog", { name: "Finite picker" })).not.toBeInTheDocument();
    await waitFor(() => expect(trigger).toHaveFocus());
  });

  it("keeps searchable navigation in the input, transfers Tab to the active row, clamps filtering, and resets on Escape", async () => {
    render(<SearchPicker />);
    const trigger = screen.getByRole("button", { name: "Search items" });
    fireEvent.click(trigger);
    const search = screen.getByRole("textbox", { name: "Filter items" });
    await waitFor(() => expect(search).toHaveFocus());

    fireEvent.keyDown(search, { key: "End" });
    expect(search).toHaveFocus();
    expect(screen.getByRole("button", { name: "Charlie" })).toHaveAttribute("tabindex", "0");
    fireEvent.change(search, { target: { value: "br" } });
    const bravo = screen.getByRole("button", { name: "Bravo" });
    expect(bravo).toHaveAttribute("tabindex", "0");
    fireEvent.keyDown(search, { key: "Tab" });
    expect(bravo).toHaveFocus();

    fireEvent.keyDown(bravo, { key: "Escape" });
    expect(screen.queryByRole("dialog", { name: "Search picker" })).not.toBeInTheDocument();
    await waitFor(() => expect(trigger).toHaveFocus());
    fireEvent.click(trigger);
    expect(screen.getByRole("textbox", { name: "Filter items" })).toHaveValue("");
  });

  it("does not navigate or select searchable options during IME composition", async () => {
    const onSelect = vi.fn();
    render(<SearchPicker onSelect={onSelect} />);
    fireEvent.click(screen.getByRole("button", { name: "Search items" }));
    const search = screen.getByRole("textbox", { name: "Filter items" });
    await waitFor(() => expect(search).toHaveFocus());

    fireEvent.keyDown(search, { isComposing: true, key: "End" });
    fireEvent.keyDown(search, { isComposing: true, key: "Enter" });
    fireEvent.keyDown(search, { isComposing: true, key: "Escape" });
    fireEvent.keyDown(search, { key: "Process" });
    fireEvent.keyDown(search, { key: "Enter", keyCode: 229 });
    fireEvent.keyDown(search, { key: "Escape", keyCode: 229 });

    expect(screen.getByRole("button", { name: "Alpha" })).toHaveAttribute("tabindex", "0");
    expect(onSelect).not.toHaveBeenCalled();
    expect(screen.getByRole("dialog", { name: "Search picker" })).toBeVisible();
  });

  it("supports controlled open state and closes on outside pointer input", async () => {
    render(<SearchPicker controlled />);
    const trigger = screen.getByRole("button", { name: "Search items" });
    fireEvent.click(trigger);
    expect(screen.getByRole("dialog", { name: "Search picker" })).toBeVisible();

    fireEvent.pointerDown(screen.getByRole("button", { name: "Outside" }));
    expect(screen.queryByRole("dialog", { name: "Search picker" })).not.toBeInTheDocument();
    await waitFor(() => expect(trigger).toHaveFocus());
  });

  it("closes an open session when its owner becomes disabled", async () => {
    const view = render(<FinitePicker />);
    fireEvent.click(screen.getByRole("button", { name: "Choose item" }));
    expect(screen.getByRole("dialog", { name: "Finite picker" })).toBeVisible();

    view.rerender(<FinitePicker disabled />);
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Finite picker" })).not.toBeInTheDocument());
    expect(screen.getByRole("button", { name: "Choose item" })).toBeDisabled();
  });
});
