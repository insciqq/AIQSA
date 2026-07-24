import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import {
  AdminSearchablePicker,
  type AdminSearchablePickerItem
} from "./AdminSearchablePicker";

const models: AdminSearchablePickerItem[] = [
  {
    id: "vendor/zulu-10",
    keywords: ["text"],
    label: "Zulu Model 10",
    secondaryText: "vendor/zulu-10"
  },
  {
    id: "anthropic/alpha-extended-context-model",
    keywords: ["Anthropic", "reasoning", "vision"],
    label: "Alpha Extended Context Model With A Deliberately Long Display Name",
    secondaryText: "anthropic/alpha-extended-context-model"
  },
  {
    id: "vendor/zulu-2",
    keywords: ["text"],
    label: "Zulu Model 2",
    secondaryText: "vendor/zulu-2"
  }
];

const baseProps = {
  items: models,
  label: "Available OpenRouter model",
  noun: { plural: "models", singular: "model" },
  onSelect: vi.fn()
};

function openPicker() {
  const trigger = screen.getByRole("button", { name: "Available OpenRouter model" });
  fireEvent.click(trigger);
  return trigger;
}

describe("AdminSearchablePicker", () => {
  it("opens on the search field, sorts a large-catalog slice, and keeps raw ids secondary", () => {
    render(<AdminSearchablePicker {...baseProps} />);

    openPicker();

    expect(screen.getByRole("combobox", { name: "Search models" })).toHaveFocus();
    expect(screen.getByText("3 models")).toBeInTheDocument();
    const options = screen.getAllByRole("option");
    expect(options.map((option) => within(option).getByText(/Model/).textContent)).toEqual([
      "Alpha Extended Context Model With A Deliberately Long Display Name",
      "Zulu Model 2",
      "Zulu Model 10"
    ]);
    expect(within(options[0]!).getByText("anthropic/alpha-extended-context-model")).toHaveClass("font-mono");
    expect(within(options[0]!).getByText(/Deliberately Long/)).toHaveClass("break-words");
  });

  it("filters across name, raw id, and keywords and reports the visible result count", () => {
    render(<AdminSearchablePicker {...baseProps} />);
    openPicker();
    const search = screen.getByRole("combobox", { name: "Search models" });

    fireEvent.change(search, { target: { value: "anthropic reasoning" } });

    expect(screen.getByText("1 of 3 models")).toBeInTheDocument();
    expect(screen.getByRole("option", { name: /Alpha Extended Context Model/ })).toBeInTheDocument();
    expect(screen.queryByRole("option", { name: /Zulu Model/ })).not.toBeInTheDocument();

    fireEvent.change(search, { target: { value: "missing-model" } });

    expect(screen.getByText("0 of 3 models")).toBeInTheDocument();
    expect(screen.getByText("No matches for “missing-model”")).toBeInTheDocument();
    expect(screen.queryByRole("option")).not.toBeInTheDocument();
  });

  it("keeps a 350-model catalog searchable inside one results region", () => {
    const catalog = Array.from({ length: 350 }, (_, index) => ({
      id: `vendor/model-${index}`,
      keywords: [index % 2 === 0 ? "reasoning" : "text"],
      label: `Catalog Model ${index}`,
      secondaryText: `vendor/model-${index}`
    }));
    render(<AdminSearchablePicker {...baseProps} items={catalog} />);
    openPicker();

    expect(screen.getByText("350 models")).toBeInTheDocument();
    const results = screen.getByRole("listbox", { name: "Available OpenRouter model" }).parentElement;
    expect(results).toHaveClass("overflow-y-auto");

    fireEvent.change(screen.getByRole("combobox", { name: "Search models" }), {
      target: { value: "vendor/model-349" }
    });

    expect(screen.getByText("1 of 350 models")).toBeInTheDocument();
    expect(screen.getByRole("option", { name: /Catalog Model 349/ })).toBeInTheDocument();
  });

  it("supports Arrow, Home, End, Enter, and Escape navigation with focus restoration", async () => {
    const onSelect = vi.fn();
    render(<AdminSearchablePicker {...baseProps} onSelect={onSelect} />);
    const trigger = openPicker();
    const search = screen.getByRole("combobox", { name: "Search models" });
    const options = screen.getAllByRole("option");

    expect(search).toHaveAttribute("aria-activedescendant", options[0]!.id);
    fireEvent.keyDown(search, { key: "ArrowDown" });
    expect(search).toHaveAttribute("aria-activedescendant", options[1]!.id);
    fireEvent.keyDown(search, { key: "ArrowUp" });
    expect(search).toHaveAttribute("aria-activedescendant", options[0]!.id);
    fireEvent.keyDown(search, { key: "End" });
    expect(search).toHaveAttribute("aria-activedescendant", options[2]!.id);
    fireEvent.keyDown(search, { key: "Home" });
    expect(search).toHaveAttribute("aria-activedescendant", options[0]!.id);
    fireEvent.keyDown(search, { key: "End" });
    fireEvent.keyDown(search, { key: "Enter" });

    expect(onSelect).toHaveBeenCalledWith(models[0]);
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    await waitFor(() => expect(trigger).toHaveFocus());

    fireEvent.click(trigger);
    fireEvent.keyDown(screen.getByRole("combobox", { name: "Search models" }), { key: "Escape" });

    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    await waitFor(() => expect(trigger).toHaveFocus());
  });

  it("selects by pointer, renders the selected value, and restores the trigger", async () => {
    const onSelect = vi.fn();
    const onOpenChange = vi.fn();
    const view = render(
      <AdminSearchablePicker
        {...baseProps}
        onOpenChange={onOpenChange}
        onSelect={onSelect}
        selectedId="vendor/zulu-2"
      />
    );
    const trigger = screen.getByRole("button", { name: "Available OpenRouter model" });

    expect(within(trigger).getByText("Zulu Model 2")).toBeInTheDocument();
    expect(within(trigger).getByText("vendor/zulu-2")).toBeInTheDocument();
    fireEvent.click(trigger);
    expect(onOpenChange).toHaveBeenCalledWith(true);
    fireEvent.click(screen.getByRole("option", { name: /Alpha Extended Context Model/ }));

    expect(onSelect).toHaveBeenCalledWith(models[1]);
    expect(onOpenChange).toHaveBeenLastCalledWith(false);
    await waitFor(() => expect(trigger).toHaveFocus());

    view.rerender(
      <AdminSearchablePicker
        {...baseProps}
        items={[]}
        onOpenChange={onOpenChange}
        onSelect={onSelect}
        selectedFallbackLabel="Existing deployment"
        selectedId="provider/model-not-in-catalog"
      />
    );
    expect(within(trigger).getByText("Existing deployment")).toBeInTheDocument();
    expect(within(trigger).getByText("provider/model-not-in-catalog")).toBeInTheDocument();
  });

  it("keeps loading, error with retry, and empty states recoverable", () => {
    const onRetry = vi.fn();
    const view = render(
      <AdminSearchablePicker
        {...baseProps}
        error={null}
        items={[]}
        loading
        onRetry={onRetry}
      />
    );
    openPicker();

    expect(screen.getByRole("status")).toHaveTextContent("Loading models…");

    view.rerender(
      <AdminSearchablePicker
        {...baseProps}
        error="OpenRouter catalog could not be loaded."
        items={[]}
        onRetry={onRetry}
      />
    );
    expect(screen.getByRole("alert")).toHaveTextContent("OpenRouter catalog could not be loaded.");
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(onRetry).toHaveBeenCalledOnce();

    view.rerender(
      <AdminSearchablePicker
        {...baseProps}
        emptyDescription="Add or test a credential first."
        emptyTitle="No models returned"
        error={null}
        items={[]}
        onRetry={onRetry}
      />
    );
    expect(screen.getByText("No models returned")).toBeInTheDocument();
    expect(screen.getByText("Add or test a credential first.")).toBeInTheDocument();
  });

  it("opens from navigation keys and remains unavailable when disabled", async () => {
    const view = render(<AdminSearchablePicker {...baseProps} />);
    const trigger = screen.getByRole("button", { name: "Available OpenRouter model" });

    fireEvent.keyDown(trigger, { key: "ArrowUp" });
    expect(screen.getByRole("dialog", { name: "Available OpenRouter model" })).toBeInTheDocument();

    view.rerender(<AdminSearchablePicker {...baseProps} disabled />);
    expect(trigger).toBeDisabled();
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
  });
});
