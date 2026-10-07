import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { UserUsageLimitStatus } from "@/lib/contracts/usageLimits";
import { USAGE_LIMIT_FOCUS_DEBOUNCE_MS } from "@/components/app-shell/useUsageLimitStatus";
import { composerGalleryConfig } from "@/app/ui-v2-fixture/_fixtures/ComposerV2Gallery";
import { ComposerV2 } from "./ComposerV2";
import { UsageLimitNoticeV2 } from "./UsageLimitNoticeV2";

function status(messages: Partial<UserUsageLimitStatus["messages"]> = {}, rest: Partial<UserUsageLimitStatus> = {}): UserUsageLimitStatus {
  return {
    installationExhausted: false,
    monthlyBudgetMicros: null,
    monthSpentMicros: 0,
    periodStart: "2026-10-01T00:00:00.000Z",
    resetsAt: "2026-11-01T00:00:00.000Z",
    ...rest,
    messages: { dayFreesAt: null, hourFreesAt: null, lastDay: 0, lastHour: 0, perDay: null, perHour: null, ...messages }
  };
}

const flush = () => act(async () => { await Promise.resolve(); });

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("composer usage-limit notice", () => {
  it("shows nothing without limits, while loading or when the status cannot be read", async () => {
    const pending = new Promise<UserUsageLimitStatus>(() => undefined);
    const view = render(<UsageLimitNoticeV2 accountId="user-1" busy={false} load={() => pending} />);
    expect(view.container).toBeEmptyDOMElement();
    view.unmount();

    render(<UsageLimitNoticeV2 accountId="user-1" busy={false} load={async () => status({ lastHour: 99 })} />);
    await flush();
    expect(screen.queryByTestId("composer-usage-limit")).toBeNull();
    cleanup();

    render(<UsageLimitNoticeV2 accountId="user-1" busy={false} load={async () => { throw new Error("usage_limits_failed_503"); }} />);
    await flush();
    expect(screen.queryByTestId("composer-usage-limit")).toBeNull();
  });

  it("cautions near a limit and turns critical when it is reached", async () => {
    render(<UsageLimitNoticeV2 accountId="user-1" busy={false} load={async () => status({ lastHour: 24, perHour: 30 })} />);
    await flush();
    const caution = screen.getByTestId("composer-usage-limit");
    expect(caution).toHaveAttribute("data-tone", "caution");
    expect(caution).toHaveAttribute("role", "status");
    expect(caution).toHaveTextContent("You've sent 24 of 30 messages allowed in the last hour.");
    cleanup();

    render(<UsageLimitNoticeV2 accountId="user-1" busy={false}
      load={async () => status({}, { monthlyBudgetMicros: 5_000_000, monthSpentMicros: 5_000_000 })} />);
    await flush();
    const critical = screen.getByTestId("composer-usage-limit");
    expect(critical).toHaveAttribute("data-tone", "critical");
    expect(critical).toHaveTextContent(/^You've used your monthly budget \(≈ \$5\.00 of \$5\.00\)\. New messages resume on .+\.$/u);
  });

  it("reads again after a run settles and once after a burst of window focus", async () => {
    vi.useFakeTimers();
    const load = vi.fn(async () => status({ lastHour: 1, perHour: 30 }));
    const view = render(<UsageLimitNoticeV2 accountId="user-1" busy={false} load={load} />);
    await flush();
    expect(load).toHaveBeenCalledTimes(1);
    view.rerender(<UsageLimitNoticeV2 accountId="user-1" busy load={load} />);
    await flush();
    expect(load).toHaveBeenCalledTimes(1);
    load.mockResolvedValue(status({ lastHour: 30, perHour: 30 }, {}));
    view.rerender(<UsageLimitNoticeV2 accountId="user-1" busy={false} load={load} />);
    await flush();
    expect(load).toHaveBeenCalledTimes(2);
    expect(screen.getByTestId("composer-usage-limit")).toHaveAttribute("data-tone", "critical");

    fireEvent.focus(window);
    fireEvent.focus(window);
    fireEvent.focus(window);
    await act(async () => { vi.advanceTimersByTime(USAGE_LIMIT_FOCUS_DEBOUNCE_MS - 1); });
    expect(load).toHaveBeenCalledTimes(2);
    await act(async () => { vi.advanceTimersByTime(1); });
    await flush();
    expect(load).toHaveBeenCalledTimes(3);
  });

  it("ignores a late answer for the previous account and an older read", async () => {
    const answers: Array<(value: UserUsageLimitStatus) => void> = [];
    const load = vi.fn(() => new Promise<UserUsageLimitStatus>((resolve) => { answers.push(resolve); }));
    const view = render(<UsageLimitNoticeV2 accountId="user-1" busy={false} load={load} />);
    view.rerender(<UsageLimitNoticeV2 accountId="user-2" busy={false} load={load} />);
    await act(async () => { answers[1]?.(status({ lastHour: 1, perHour: 30 })); });
    await act(async () => { answers[0]?.(status({ lastHour: 30, perHour: 30 })); });
    expect(screen.queryByTestId("composer-usage-limit")).toBeNull();
  });

  it("never blocks Send: the server decides admission", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({
      usageLimits: status({ hourFreesAt: "2026-10-07T12:20:00.000Z", lastHour: 30, perHour: 30 })
    })));
    const onSend = vi.fn();
    render(<ComposerV2 config={composerGalleryConfig} draft="Hello" onDraftChange={vi.fn()} onSend={onSend}
      selectedModelId="gpt-5.2" selectedProvider="openai-work" usageLimitsAccountId="user-1" />);
    expect(await screen.findByTestId("composer-usage-limit")).toHaveTextContent(
      /^You've sent 30 of 30 messages allowed in the last hour\. You can send again .+\.$/u
    );
    expect(fetch).toHaveBeenCalledWith("/api/me/usage-limits", expect.objectContaining({ cache: "no-store" }));
    fireEvent.click(screen.getByRole("button", { name: "Send message" }));
    expect(onSend).toHaveBeenCalledOnce();
  });
});
