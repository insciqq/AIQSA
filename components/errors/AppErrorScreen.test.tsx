import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { AppErrorScreen } from "./AppErrorScreen";

function crash(message: string, extra: Partial<Error & { digest: string }> = {}) {
  const error = Object.assign(new Error(message), extra);
  error.stack = `Error: ${message}\n    at PrivateComponent (secret-path.tsx:1:1)`;
  return error;
}

function renderScreen(error: Error & { digest?: string }, props: Partial<Parameters<typeof AppErrorScreen>[0]> = {}) {
  const reporter = { report: vi.fn() };
  const reset = vi.fn();
  const reload = vi.fn();
  render(<AppErrorScreen error={error} reload={reload} reporter={reporter} reset={reset} {...props} />);
  return { reload, reporter, reset };
}

describe("AppErrorScreen", () => {
  it("shows a calm recoverable screen without the error's content and reports the crash once", () => {
    const error = crash("private canary message", { digest: "1234567890" });
    const h = renderScreen(error);

    expect(screen.getByRole("heading", { name: "Something went wrong" })).toHaveFocus();
    expect(screen.getByText("Reference:")).toHaveTextContent("Reference: 1234567890");
    expect(document.body.textContent).not.toMatch(/canary|secret-path|PrivateComponent/);
    expect(h.reporter.report).toHaveBeenCalledTimes(1);
    expect(h.reporter.report).toHaveBeenCalledWith("render", error);

    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(h.reset).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole("button", { name: "Reload" }));
    expect(h.reload).toHaveBeenCalledTimes(1);
  });

  it("prefers Next's retry and hides an unsafe digest", () => {
    const retry = vi.fn();
    const h = renderScreen(crash("x", { digest: "<script>private</script>" }), { retry });
    expect(screen.queryByText(/Reference/)).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(retry).toHaveBeenCalledTimes(1);
    expect(h.reset).not.toHaveBeenCalled();
  });

  it("asks for a reload after a stale-deploy chunk failure", () => {
    const error = crash("Loading chunk 77 failed.", { name: "ChunkLoadError" });
    const h = renderScreen(error);
    expect(screen.getByRole("heading", { name: "AIQSA was updated" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Try again" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Reload" }));
    expect(h.reload).toHaveBeenCalledTimes(1);
    expect(h.reporter.report).toHaveBeenCalledWith("chunk_load", error);
  });
});
