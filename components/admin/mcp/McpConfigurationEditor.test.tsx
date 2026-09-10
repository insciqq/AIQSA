import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { useRef, useState } from "react";
import { describe, expect, it } from "vitest";
import { McpConfigurationEditor } from "./McpConfigurationEditor";

function harness(initial: string, disabled = false) {
  function Harness() {
    const [value, setValue] = useState(initial);
    const [error, setError] = useState<string | null>(null);
    const ref = useRef<HTMLTextAreaElement>(null);
    return <McpConfigurationEditor disabled={disabled} error={error} id="configuration" onChange={setValue} onError={setError} textareaRef={ref} value={value} />;
  }
  return render(<Harness />);
}

describe("MCP inline configuration editor", () => {
  it("preserves the canonical draft, selection, errors and focus across expansion", async () => {
    harness('{"mcpServers":{}}');
    const editor = screen.getByRole<HTMLTextAreaElement>("textbox");
    editor.focus();
    editor.setSelectionRange(2, 8);
    fireEvent.click(screen.getByRole("button", { name: "Expand configuration editor" }));
    const dialog = screen.getByRole("dialog", { name: "MCP configuration" });
    const expanded = within(dialog).getByRole<HTMLTextAreaElement>("textbox");
    await waitFor(() => expect(expanded).toHaveFocus());
    expect([expanded.selectionStart, expanded.selectionEnd]).toEqual([2, 8]);
    fireEvent.change(expanded, { target: { value: '{\n"invalid":\n}' } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Format" }));
    expect(within(dialog).getByRole("alert")).toHaveTextContent("Line 3, column 1");
    expanded.setSelectionRange(3, 6);
    fireEvent.keyDown(expanded, { key: "Escape" });
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    const restored = screen.getByRole<HTMLTextAreaElement>("textbox");
    await waitFor(() => expect(restored).toHaveFocus());
    expect(restored).toHaveValue('{\n"invalid":\n}');
    expect([restored.selectionStart, restored.selectionEnd]).toEqual([3, 6]);
    expect(screen.getByRole("alert")).toHaveTextContent("Line 3, column 1");
    expect(restored).toHaveAccessibleDescription(/Line 3, column 1/u);
  });

  it.each(["https://mcp.example.test/api", "npx -y @example/mcp@latest", "pipx run example-mcp"])("keeps non-JSON input intact: %s", (value) => {
    harness(value);
    expect(screen.getByRole("textbox")).toHaveValue(value);
    expect(screen.getByRole("button", { name: "Format" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "Expand configuration editor" }));
    expect(screen.getByRole("textbox")).toHaveValue(value);
    fireEvent.click(screen.getByRole("button", { name: "Return to form" }));
    expect(screen.getByRole("textbox")).toHaveValue(value);
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("formats and indents inline without replacing or executing the configuration", () => {
    harness('{"mcpServers":{"sample":{"url":"https://mcp.example.test/api"}}}');
    fireEvent.click(screen.getByRole("button", { name: "Format" }));
    const editor = screen.getByRole<HTMLTextAreaElement>("textbox");
    expect(editor.value.split("\n").length).toBe(7);
    editor.setSelectionRange(2, 2);
    fireEvent.keyDown(editor, { key: "Tab" });
    expect(editor.value).toContain('\n    "mcpServers"');
    fireEvent.keyDown(editor, { ctrlKey: true, key: "m" });
    expect(fireEvent.keyDown(editor, { key: "Tab" })).toBe(true);
  });

  it("keeps all editor controls unavailable while the parent is busy", () => {
    harness("{}", true);
    expect(screen.getByRole("textbox")).toBeDisabled();
    for (const button of screen.getAllByRole("button")) expect(button).toBeDisabled();
  });
});
