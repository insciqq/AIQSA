import { fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { expect, it, vi } from "vitest";
import { MarkdownPreviewBoundary } from "./MarkdownPreviewBoundary";

function Preview({ value }: { value: string }) {
  if (value === "broken") throw new Error("synthetic rendering failure");
  return <p>{value}</p>;
}
it("contains rendering failure, keeps the source mounted, and retries only after its value changes", () => {
  const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
  const onError = vi.fn();
  function Editor() {
    const [value, setValue] = useState("broken");
    return <><input aria-label="Source" value={value} onChange={event => setValue(event.target.value)} />
      <MarkdownPreviewBoundary resetKey={value} onError={onError} fallback={<p role="status">Preview is unavailable for this text.</p>}>
        <Preview value={value} />
      </MarkdownPreviewBoundary></>;
  }
  try {
    render(<Editor />);
    const input = screen.getByLabelText("Source");
    expect(input).toHaveValue("broken");
    expect(screen.getByRole("status")).toHaveTextContent("Preview is unavailable");
    expect(onError).toHaveBeenCalledTimes(1);
    fireEvent.change(input, { target: { value: "Recovered text" } });
    expect(screen.getByText("Recovered text")).toBeVisible();
    expect(screen.getByLabelText("Source")).toBe(input);
    expect(screen.queryByRole("status")).toBeNull();
  } finally { error.mockRestore(); }
});
