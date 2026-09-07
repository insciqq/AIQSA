import { act, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
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
        code: "email_not_configured" as const,
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
    <output data-testid="state">
      {controller.loading ? "loading" : controller.unavailable ? "unavailable" : "ready"}:
      {controller.attention?.items.map((item) => item.id).join(",") ?? "none"}
    </output>
  );
}

describe("useAdminAttention", () => {
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
