import { act, fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MarkdownEditorV2 } from "./MarkdownEditorV2";

function Editor({ initial = "" }: { initial?: string }) {
  const [value, setValue] = useState(initial);
  return <MarkdownEditorV2 label="Source" previewLabel="Rendered text" value={value} onChange={setValue} maxLength={32000} />;
}
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe("controlled Markdown editor", () => {
  it("uses the container threshold, preserves source selection, and supports keyboard modes", () => {
    let width = 879;
    let resize!: () => void;
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(() => ({ width } as DOMRect));
    vi.stubGlobal("ResizeObserver", class { constructor(callback: () => void) { resize = callback; } observe() {} disconnect() {} });
    render(<Editor initial="# Heading" />);
    expect(screen.getByRole("radio", { name: "Write" })).toBeChecked();
    expect(screen.queryByRole("radio", { name: "Split" })).toBeNull();
    act(() => { width = 880; resize(); });
    expect(screen.getByRole("radio", { name: "Split" })).toBeChecked();
    const source = screen.getByLabelText("Source") as HTMLTextAreaElement;
    source.setSelectionRange(2, 6);
    source.scrollTop = 20;
    const split = screen.getByRole("radio", { name: "Split" });
    split.focus();
    fireEvent.keyDown(split, { key: "ArrowRight" });
    expect(screen.getByRole("radio", { name: "Preview" })).toHaveFocus();
    expect(screen.getByRole("heading", { name: "Heading" })).toBeVisible();
    fireEvent.keyDown(screen.getByRole("radio", { name: "Preview" }), { key: "Home" });
    expect(screen.getByLabelText("Source")).toBe(source);
    expect(source.selectionStart).toBe(2);
    expect(source.scrollTop).toBe(20);
    fireEvent.click(screen.getByRole("radio", { name: "Split" }));
    screen.getByRole("radio", { name: "Split" }).focus();
    act(() => { width = 879; resize(); });
    expect(screen.getByRole("radio", { name: "Write" })).toHaveFocus();
    expect(screen.queryByRole("radio", { name: "Split" })).toBeNull();
    expect(source).toHaveValue("# Heading");
  });

  it("renders deeply nested untrusted text without external links or image requests", () => {
    render(<Editor initial={`${">".repeat(3000)} bounded\n\n[link](https://example.com) ![image](https://example.com/image.png) <script>bad()</script>`} />);
    fireEvent.click(screen.getByRole("radio", { name: "Preview" }));
    expect(document.querySelectorAll("blockquote")).toHaveLength(32);
    expect(screen.getByRole("region", { name: "Rendered text" })).toHaveTextContent("bounded");
    expect(document.querySelector("a, img, script, iframe, object, embed")).toBeNull();
    fireEvent.click(screen.getByRole("radio", { name: "Write" }));
    expect((screen.getByLabelText("Source") as HTMLTextAreaElement).value).toContain(">".repeat(3000));
  });
});
