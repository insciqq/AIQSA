import { act, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AdminAttentionResult } from "./adminAttentionApi";
import { useAdminAttention, type UseAdminAttentionOptions } from "./useAdminAttention";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function attentionResult(ids: string[]): AdminAttentionResult {
  return {
    attention: {
      checkedAt: "2026-09-07T12:00:00.000Z",
      items: ids.map((id) => ({
        action: "Open",
        code: id.startsWith("memory") ? "memory_processing_blocked" as const : "email_not_configured" as const,
        count: null,
        detail: id,
        id,
        severity: "neutral" as const,
        target: { section: "email" as const },
        title: id
      })),
      unavailable: []
    },
    ok: true
  };
}

function Harness(options: UseAdminAttentionOptions) {
  const controller = useAdminAttention(options);
  return (
    <output data-stale={JSON.stringify(controller.staleItems)} data-testid="state">
      {controller.loading ? "loading" : controller.unavailable ? "unavailable" : "ready"}:
      {controller.attention?.items.map((item) => item.id).join(",") ?? "none"}
    </output>
  );
}

describe("useAdminAttention", () => {
  afterEach(() => vi.useRealTimers());

  it("polls within 30 seconds, reconciles background recovery and fences pending work after leaving", async () => {
    vi.useFakeTimers();
    const pending = deferred<AdminAttentionResult>();
    const request = vi.fn<() => Promise<AdminAttentionResult>>()
      .mockResolvedValueOnce(attentionResult([]))
      .mockResolvedValueOnce(attentionResult(["memory-blocked"]))
      .mockResolvedValueOnce(attentionResult([]))
      .mockReturnValueOnce(pending.promise);
    const view = render(<Harness active refreshKey={1} requestAttention={request} />);
    await act(async () => { await Promise.resolve(); });
    await act(async () => { await vi.advanceTimersByTimeAsync(25_000); });
    expect(screen.getByTestId("state")).toHaveTextContent("ready:memory-blocked");
    await act(async () => { await vi.advanceTimersByTimeAsync(25_000); });
    expect(screen.getByTestId("state")).not.toHaveTextContent("memory-blocked");
    await act(async () => { await vi.advanceTimersByTimeAsync(25_000); });
    view.rerender(<Harness active={false} refreshKey={1} requestAttention={request} />);
    await act(async () => { pending.resolve(attentionResult(["memory-old"])); await pending.promise; });
    await act(async () => { await vi.advanceTimersByTimeAsync(75_000); window.dispatchEvent(new Event("focus")); });
    expect(request).toHaveBeenCalledTimes(4);
    expect(screen.getByTestId("state")).not.toHaveTextContent("memory-old");
  });

  it("retains only unavailable sources with their original observation time, then removes confirmed recovery", async () => {
    const partial = attentionResult(["updated-email"]);
    if (!partial.ok) throw new Error("fixture_invalid");
    partial.attention.checkedAt = "2026-09-07T12:00:25.000Z";
    partial.attention.unavailable = ["memory"];
    const recovered = attentionResult([]);
    if (!recovered.ok) throw new Error("fixture_invalid");
    recovered.attention.checkedAt = "2026-09-07T12:00:50.000Z";
    const request = vi.fn<() => Promise<AdminAttentionResult>>()
      .mockResolvedValueOnce(attentionResult(["memory-blocked", "old-email"]))
      .mockResolvedValueOnce(partial).mockRejectedValueOnce(new Error("offline"))
      .mockResolvedValueOnce(recovered);
    const view = render(<Harness active refreshKey={1} requestAttention={request} />);
    await waitFor(() => expect(screen.getByTestId("state")).toHaveTextContent("memory-blocked,old-email"));
    view.rerender(<Harness active refreshKey={2} requestAttention={request} />);
    await waitFor(() => expect(screen.getByTestId("state")).toHaveTextContent("updated-email,memory-blocked"));
    expect(screen.getByTestId("state")).toHaveAttribute("data-stale", '{"memory-blocked":"2026-09-07T12:00:00.000Z"}');
    view.rerender(<Harness active refreshKey={3} requestAttention={request} />);
    await waitFor(() => expect(screen.getByTestId("state")).toHaveTextContent("unavailable:updated-email,memory-blocked"));
    expect(screen.getByTestId("state").getAttribute("data-stale")).toContain('"memory-blocked":"2026-09-07T12:00:00.000Z"');
    view.rerender(<Harness active refreshKey={4} requestAttention={request} />);
    await waitFor(() => expect(screen.getByTestId("state")).not.toHaveTextContent("memory-blocked"));
    expect(screen.getByTestId("state")).toHaveAttribute("data-stale", "{}");
  });
  it("loads only while active, refetches after reconciled mutations and on window focus", async () => {
    const request = vi.fn<() => Promise<AdminAttentionResult>>()
      .mockResolvedValueOnce(attentionResult(["first"]))
      .mockResolvedValueOnce(attentionResult(["second"]))
      .mockResolvedValueOnce(attentionResult(["third"]));
    const view = render(<Harness active={false} refreshKey={1} requestAttention={request} />);
    expect(request).not.toHaveBeenCalled();
    expect(screen.getByTestId("state")).toHaveTextContent("loading:none");

    view.rerender(<Harness active refreshKey={1} requestAttention={request} />);
    await waitFor(() => expect(screen.getByTestId("state")).toHaveTextContent("ready:first"));

    view.rerender(<Harness active refreshKey={2} requestAttention={request} />);
    await waitFor(() => expect(screen.getByTestId("state")).toHaveTextContent("ready:second"));

    act(() => {
      window.dispatchEvent(new Event("focus"));
    });
    await waitFor(() => expect(screen.getByTestId("state")).toHaveTextContent("ready:third"));
    expect(request).toHaveBeenCalledTimes(3);
  });

  it("ignores a stale response that settles after a newer request and keeps the list on failure", async () => {
    const first = deferred<AdminAttentionResult>();
    const second = deferred<AdminAttentionResult>();
    const request = vi.fn<() => Promise<AdminAttentionResult>>()
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise)
      .mockResolvedValueOnce({ error: "network_error", ok: false });
    const view = render(<Harness active refreshKey={1} requestAttention={request} />);
    view.rerender(<Harness active refreshKey={2} requestAttention={request} />);

    await act(async () => {
      second.resolve(attentionResult(["newest"]));
      await second.promise;
    });
    expect(screen.getByTestId("state")).toHaveTextContent("ready:newest");

    await act(async () => {
      first.resolve(attentionResult(["stale"]));
      await first.promise;
    });
    expect(screen.getByTestId("state")).toHaveTextContent("ready:newest");

    view.rerender(<Harness active refreshKey={3} requestAttention={request} />);
    await waitFor(() => expect(screen.getByTestId("state")).toHaveTextContent("unavailable:newest"));
  });
});
