import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { AdminSheet } from "@/components/admin/AdminSheet";
import { ModelJsonDialog } from "./ModelJsonDialog";

function harness(value = "{}") {
  const apply = vi.fn();
  const closeSheet = vi.fn();
  function Harness() {
    const [open, setOpen] = useState(false);
    return <AdminSheet onClose={closeSheet} open testId="outer" title="Edit model">
      <button onClick={() => setOpen(true)} type="button">Edit JSON</button>
      <input aria-label="Other model setting" defaultValue="Keep this" />
      {open ? <ModelJsonDialog example={'{ "maxOutputTokens": 1024 }'} modelLabel="Test model" onApply={(next) => { apply(next); setOpen(false); }} onClose={() => setOpen(false)} providerLabel="Test provider" value={value} /> : null}
    </AdminSheet>;
  }
  render(<Harness />);
  const trigger = screen.getByRole("button", { name: "Edit JSON" });
  trigger.focus();
  fireEvent.click(trigger);
  return { apply, closeSheet, trigger };
}

describe("ModelJsonDialog", () => {
  it.each(["", "{}", " {\n } ", '{"temperature":0.5}'])("shows an instructional example without changing or dirtying %j", async (value) => {
    const { apply, trigger } = harness(value);
    const editor = screen.getByRole("textbox", { name: "Default parameters JSON" });
    expect(editor).toHaveValue(value);
    expect(editor).toHaveAccessibleDescription(/one JSON object.*Example only/u);
    expect(JSON.parse(screen.getByTestId("model-json-example").textContent!)).toEqual({ maxOutputTokens: 1024 });
    fireEvent.click(screen.getByRole("button", { name: "Close JSON editor" }));
    await waitFor(() => expect(trigger).toHaveFocus());
    expect(screen.queryByRole("dialog", { name: "Discard JSON changes" })).not.toBeInTheDocument();
    expect(apply).not.toHaveBeenCalled();
  });

  it.each(["{}", " {\n } "])("applies untouched %j without injecting example settings", (value) => {
    const { apply } = harness(value);
    fireEvent.click(screen.getByRole("button", { name: "Apply to model" }));
    expect(apply).toHaveBeenCalledExactlyOnceWith(value);
  });

  it("locally formats a long configuration and applies its exact text to the model draft", async () => {
    const { apply, closeSheet, trigger } = harness();
    const dialog = screen.getByRole("dialog", { name: "Default parameters · JSON" });
    expect(dialog).toHaveTextContent("Test model · Test provider");
    const editor = within(dialog).getByRole("textbox", { name: "Default parameters JSON" });
    const value = JSON.stringify({ provider: { values: Array.from({ length: 40 }, (_, index) => ({ key: index, enabled: true })) } });
    fireEvent.change(editor, { target: { value } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Format" }));
    expect(editor).toHaveValue(JSON.stringify(JSON.parse(value), null, 2));
    expect(within(dialog).getByText("166 lines")).toBeInTheDocument();
    expect(apply).not.toHaveBeenCalled();
    fireEvent.click(within(dialog).getByRole("button", { name: "Apply to model" }));
    expect(apply).toHaveBeenCalledWith(JSON.stringify(JSON.parse(value), null, 2));
    expect(closeSheet).not.toHaveBeenCalled();
    await waitFor(() => expect(trigger).toHaveFocus());
    expect(screen.getByRole("textbox", { name: "Other model setting" })).toHaveValue("Keep this");
  });

  it("preserves invalid text on Format and Apply and gives a line/column error without echoing it", () => {
    const { apply } = harness();
    const dialog = screen.getByRole("dialog", { name: "Default parameters · JSON" });
    const editor = within(dialog).getByRole("textbox");
    const value = '{\n  "private-value":\n}';
    fireEvent.change(editor, { target: { value } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Format" }));
    expect(within(dialog).getByRole("alert")).toHaveTextContent("Line 3, column 1");
    expect(within(dialog).getByRole("alert")).not.toHaveTextContent("private-value");
    expect(editor).toHaveValue(value);
    expect(editor).toHaveAttribute("aria-invalid", "true");
    expect(editor).toHaveFocus();
    fireEvent.click(within(dialog).getByRole("button", { name: "Apply to model" }));
    expect(editor).toHaveValue(value);
    expect(apply).not.toHaveBeenCalled();
    fireEvent.change(editor, { target: { value: "[]" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Apply to model" }));
    expect(within(dialog).getByRole("alert")).toHaveTextContent("must be one JSON object");
  });

  it("gives the inner confirmation priority for Escape and discards only the JSON draft", async () => {
    const { apply, closeSheet, trigger } = harness();
    const editor = screen.getByRole("textbox", { name: "Default parameters JSON" });
    fireEvent.change(editor, { target: { value: '{"local":true}' } });
    editor.focus();
    fireEvent.keyDown(editor, { key: "Escape" });
    const confirmation = await screen.findByRole("dialog", { name: "Discard JSON changes" });
    fireEvent.keyDown(within(confirmation).getByRole("button", { name: "Keep editing" }), { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Discard JSON changes" })).not.toBeInTheDocument());
    expect(editor).toHaveValue('{"local":true}');
    expect(closeSheet).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    fireEvent.click(await screen.findByRole("button", { name: "Confirm discard json changes" }));
    await waitFor(() => expect(trigger).toHaveFocus());
    expect(apply).not.toHaveBeenCalled();
    expect(closeSheet).not.toHaveBeenCalled();
    expect(screen.getByRole("textbox", { name: "Other model setting" })).toHaveValue("Keep this");
  });

  it("supports indentation, keyboard escape from Tab capture and containment at dialog boundaries", () => {
    harness('{\n"x":1\n}');
    const dialog = screen.getByRole("dialog", { name: "Default parameters · JSON" });
    const editor = within(dialog).getByRole<HTMLTextAreaElement>("textbox");
    editor.focus();
    editor.setSelectionRange(2, 2);
    fireEvent.keyDown(editor, { key: "Tab" });
    expect(editor).toHaveValue('{\n  "x":1\n}');
    fireEvent.keyDown(editor, { key: "Tab", shiftKey: true });
    expect(editor).toHaveValue('{\n"x":1\n}');
    fireEvent.keyDown(editor, { ctrlKey: true, key: "m" });
    expect(within(dialog).getByRole("button", { name: "Tab: move focus" })).toHaveAttribute("aria-pressed", "true");
    expect(fireEvent.keyDown(editor, { key: "Tab" })).toBe(true);
    const last = within(dialog).getByRole("button", { name: "Apply to model" });
    last.focus();
    fireEvent.keyDown(last, { key: "Tab" });
    expect(within(dialog).getByRole("button", { name: "Close JSON editor" })).toHaveFocus();
    fireEvent.keyDown(document.activeElement!, { key: "Tab", shiftKey: true });
    expect(last).toHaveFocus();
  });

  it("escapes highlighted text and closes a clean inner dialog without closing the sheet", async () => {
    const { closeSheet, trigger } = harness('{"text":"<img src=x onerror=alert(1)>"}');
    expect(document.querySelector("img")).toBeNull();
    const editor = screen.getByRole("textbox", { name: "Default parameters JSON" });
    fireEvent.keyDown(editor, { key: "Escape" });
    await waitFor(() => expect(trigger).toHaveFocus());
    expect(closeSheet).not.toHaveBeenCalled();
    expect(screen.queryByTestId("model-json-dialog")).not.toBeInTheDocument();
  });

  it.each(["Dismiss JSON editor", "Close JSON editor", "Cancel"])("keeps dirty JSON behind a local discard confirmation on %s", async (label) => {
    const { apply, closeSheet } = harness();
    const editor = screen.getByRole("textbox", { name: "Default parameters JSON" });
    fireEvent.change(editor, { target: { value: '{"local":42}' } });
    fireEvent.click(screen.getByRole("button", { name: label }));
    const confirmation = await screen.findByRole("dialog", { name: "Discard JSON changes" });
    fireEvent.click(within(confirmation).getByRole("button", { name: "Keep editing" }));
    expect(editor).toHaveValue('{"local":42}');
    expect(apply).not.toHaveBeenCalled();
    expect(closeSheet).not.toHaveBeenCalled();
  });
});
