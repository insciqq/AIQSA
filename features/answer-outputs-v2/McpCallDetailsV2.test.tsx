import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { McpCallDetails } from "@/lib/contracts/mcpCallDetails";
import { McpCallDetailsV2 } from "./McpCallDetailsV2";
import { AnswerProcessV2 } from "./AnswerProcessV2";

const props = { label: "Searched Logs", meta: "0.8 s · round 2", reference: { roundIndex: 2, ordinal: 0 },
  runId: "run-mcp", status: "complete" as const };
const text = '<img src=x onerror="alert(1)"> [link](https://example.com)';
function section(value = text): NonNullable<McpCallDetails["request"]> {
  return { text: value, byteSize: new TextEncoder().encode(value).length, truncated: false };
}
function details(overrides: Partial<McpCallDetails> = {}): McpCallDetails {
  return { request: section('{"query":"test"}'), response: section(), requestState: "available", responseState: "available",
    isError: false, unsupportedContentTypes: [], ...overrides };
}
const response = (value: unknown) => ({ ok: true, json: async () => value }) as Response;
const toggle = () => screen.getByRole("button", { name: /MCP call details/u });

afterEach(() => vi.unstubAllGlobals());

describe("lazy MCP call details", () => {
  it("loads on expansion, renders text inertly, copies delivered text, and reuses the loaded result", async () => {
    const fetcher = vi.fn().mockResolvedValue(response(details()));
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal("fetch", fetcher);
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
    render(<McpCallDetailsV2 {...props} />);
    expect(toggle()).toHaveAttribute("aria-expanded", "false");
    expect(fetcher).not.toHaveBeenCalled();
    fireEvent.click(toggle());
    await waitFor(() => expect(screen.getByLabelText("Response text")).toHaveTextContent(text));
    expect(fetcher).toHaveBeenCalledWith("/api/model-runs/run-mcp/mcp-calls/2/0", expect.objectContaining({ cache: "no-store", signal: expect.any(AbortSignal) }));
    expect(screen.getByLabelText("Response text").querySelector("img,a")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Copy response" }));
    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("Response copied."));
    expect(writeText).toHaveBeenCalledWith(text);
    fireEvent.click(toggle());
    fireEvent.click(toggle());
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it.each(["pending", "cancelled", "too_large", "unavailable"] as const)("shows a truthful %s response with no copy control", async state => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response(details({ response: null, responseState: state }))));
    render(<McpCallDetailsV2 {...props} />);
    fireEvent.click(toggle());
    await waitFor(() => expect(screen.getByLabelText("Response")).toHaveAttribute("data-state", state));
    expect(screen.queryByRole("button", { name: "Copy response" })).not.toBeInTheDocument();
    if (state === "pending") expect(screen.getByRole("button", { name: "Refresh call details" })).toBeVisible();
  });

  it("shows full bytes, dropped types and safe tool errors without rendering markup", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response(details({ response: { ...section(), byteSize: 100_000, truncated: true },
      isError: true, unsupportedContentTypes: ["image", "audio"] }))));
    render(<McpCallDetailsV2 {...props} />);
    fireEvent.click(toggle());
    await screen.findByText("Showing part of 100,000 bytes.");
    expect(screen.getByTestId("mcp-call-details")).toHaveTextContent("Content not included: image, audio.");
    expect(screen.getByTestId("mcp-call-details")).toHaveTextContent("The tool reported an error.");
  });

  it("distinguishes an empty response from unavailable request content and reports copy failure", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response(details({ request: null, requestState: "unavailable", response: section("") }))));
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: vi.fn().mockRejectedValue(new Error("blocked")) } });
    render(<McpCallDetailsV2 {...props} />);
    fireEvent.click(toggle());
    await screen.findByText("No response content.");
    expect(screen.getByLabelText("Request")).toHaveTextContent("The content is no longer available.");
    expect(screen.queryByRole("button", { name: "Copy request" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Copy response" }));
    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("Could not copy response."));
  });

  it.each([false, true])("retries failed or malformed loads without displaying raw server errors (%s)", async malformed => {
    const fetcher = vi.fn().mockResolvedValueOnce(malformed ? response({ secret: "do not show" }) : { ok: false })
      .mockResolvedValueOnce(response(details()));
    vi.stubGlobal("fetch", fetcher);
    render(<McpCallDetailsV2 {...props} />);
    fireEvent.click(toggle());
    await screen.findByRole("alert");
    expect(document.body).not.toHaveTextContent("do not show");
    fireEvent.click(screen.getByRole("button", { name: "Retry call details" }));
    await screen.findByLabelText("Response text");
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("shows the plain unavailable sentence without Retry once access is lost, and keeps Retry for 5xx", async () => {
    const fetcher = vi.fn().mockResolvedValue({ ok: false, status: 404, json: async () => ({ error: "chat_not_found" }) } as Response);
    vi.stubGlobal("fetch", fetcher);
    const { rerender } = render(<McpCallDetailsV2 {...props} />);
    fireEvent.click(toggle());
    await screen.findByText("The content is no longer available.");
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Retry call details" })).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Request")).not.toBeInTheDocument();
    fireEvent.click(toggle());
    fireEvent.click(toggle());
    rerender(<McpCallDetailsV2 {...props} status="error" />);
    expect(screen.getByTestId("mcp-call-details")).toHaveTextContent("The content is no longer available.");
    expect(fetcher).toHaveBeenCalledTimes(1);

    const failing = vi.fn().mockResolvedValue({ ok: false, status: 503, json: async () => ({}) } as Response);
    vi.stubGlobal("fetch", failing);
    rerender(<McpCallDetailsV2 {...props} runId="other-run" />);
    fireEvent.click(toggle());
    await screen.findByRole("alert");
    expect(screen.getByRole("button", { name: "Retry call details" })).toBeVisible();
    expect(screen.queryByText("The content is no longer available.")).not.toBeInTheDocument();
  });

  it("refreshes an open pending response when the call settles and preserves disclosure", async () => {
    const fetcher = vi.fn().mockResolvedValueOnce(response(details({ response: null, responseState: "pending" })))
      .mockResolvedValueOnce(response(details()));
    vi.stubGlobal("fetch", fetcher);
    const { rerender } = render(<McpCallDetailsV2 {...props} status="running" />);
    fireEvent.click(toggle());
    await screen.findByText("The call has not finished.");
    rerender(<McpCallDetailsV2 {...props} />);
    await screen.findByLabelText("Response text");
    expect(toggle()).toHaveAttribute("aria-expanded", "true");
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("aborts on collapse and ignores an old response after a different run is mounted", async () => {
    let finish: (value: Response) => void = () => undefined;
    const fetcher = vi.fn().mockImplementationOnce(() => new Promise<Response>(resolve => { finish = resolve; }))
      .mockResolvedValue(response(details({ response: section("new response") })));
    vi.stubGlobal("fetch", fetcher);
    const { rerender } = render(<McpCallDetailsV2 {...props} />);
    fireEvent.click(toggle());
    const signal = fetcher.mock.calls[0]![1].signal as AbortSignal;
    fireEvent.click(toggle());
    expect(signal.aborted).toBe(true);
    rerender(<McpCallDetailsV2 {...props} runId="other-run" />);
    expect(toggle()).toHaveAttribute("aria-expanded", "false");
    fireEvent.click(toggle());
    await screen.findByText("new response");
    await act(async () => finish(response(details({ response: section("stale response") }))));
    expect(document.body).not.toHaveTextContent("stale response");
  });

  it("shows live authorized MCP rows, while rows without authority and other origins stay plain", () => {
    const fetcher = vi.fn();
    vi.stubGlobal("fetch", fetcher);
    render(<AnswerProcessV2 runId="run-mcp" liveLabel="Using Logs…" toolActivity={{ calls: [
      { origin: "mcp", round: 2, toolName: "logs", status: "running", details: props.reference },
      { origin: "mcp", round: 2, toolName: "restricted", status: "running" },
      { origin: "skill", round: 2, toolName: "load_skill", status: "complete", details: props.reference }
    ] }} />);
    const process = screen.getByTestId("tool-activity-disclosure") as HTMLDetailsElement;
    process.open = true;
    expect(screen.getAllByRole("button", { name: /MCP call details/u })).toHaveLength(1);
    expect(fetcher).not.toHaveBeenCalled();
  });
});
