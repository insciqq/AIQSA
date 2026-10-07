import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { UserUsageLimitStatus } from "@/lib/contracts/usageLimits";
import { UsageLimitsSettingsV2 } from "./UsageLimitsSettingsV2";

function status(rest: Partial<UserUsageLimitStatus> = {}, messages: Partial<UserUsageLimitStatus["messages"]> = {}): UserUsageLimitStatus {
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

afterEach(cleanup);

describe("Settings usage limits", () => {
  it("adds nothing for a user without limits or while the status loads", async () => {
    const pending = render(<UsageLimitsSettingsV2 load={() => new Promise(() => undefined)} />);
    expect(pending.container).toBeEmptyDOMElement();
    pending.unmount();

    const view = render(<UsageLimitsSettingsV2 load={async () => status({ monthSpentMicros: 4_000_000 }, { lastHour: 7 })} />);
    await flush();
    expect(view.container).toBeEmptyDOMElement();
  });

  it("shows the month spend against the budget with a meter, the reset and both message windows", async () => {
    render(<UsageLimitsSettingsV2 load={async () => status(
      { monthlyBudgetMicros: 10_000_000, monthSpentMicros: 3_200_000 },
      { lastDay: 40, lastHour: 12, perDay: 200, perHour: 30 }
    )} />);
    await flush();
    const block = screen.getByRole("region", { name: "Usage limits" });
    expect(block).toHaveTextContent("Set by your administrator.");
    expect(block).toHaveTextContent("Monthly budget≈ $3.20 of $10.00");
    const meter = within(block).getByRole("meter", { name: "Monthly budget used" });
    expect(meter).toHaveAttribute("aria-valuenow", "32");
    expect(meter).toHaveAttribute("data-tone", "ok");
    expect(block).toHaveTextContent(/Resets on .+\. Months follow UTC\./u);
    expect(block).toHaveTextContent("Counts the models you use; Memory, Knowledge and chat titles don't count.");
    expect(block).toHaveTextContent("Messages12 of 30 in the last hour · 40 of 200 in the last 24 hours");
  });

  it("marks a reached budget and a reached shared cap without installation amounts", async () => {
    render(<UsageLimitsSettingsV2 load={async () => status(
      { installationExhausted: true, monthlyBudgetMicros: 10_000_000, monthSpentMicros: 10_400_000 }
    )} />);
    await flush();
    const block = screen.getByRole("region", { name: "Usage limits" });
    expect(within(block).getByRole("meter")).toHaveAttribute("data-tone", "critical");
    expect(within(block).getByRole("meter")).toHaveAttribute("aria-valuenow", "100");
    expect(block).toHaveTextContent(/New messages are paused for everyone: the shared monthly usage limit is reached\. It resets .+\./u);
    expect(block).not.toHaveTextContent("Messages");
  });

  it("shows a quiet unavailable line instead of numbers and retries on request", async () => {
    const load = vi.fn()
      .mockRejectedValueOnce(new Error("usage_limits_failed_503"))
      .mockResolvedValueOnce(status({}, { lastHour: 3, perHour: 30 }));
    render(<UsageLimitsSettingsV2 load={load} />);
    await flush();
    const unavailable = screen.getByTestId("settings-usage-limits-unavailable");
    expect(unavailable).toHaveTextContent("Usage limits are unavailable right now.");
    expect(unavailable).not.toHaveTextContent(/\d/u);
    fireEvent.click(within(unavailable).getByRole("button", { name: "Retry" }));
    await flush();
    expect(load).toHaveBeenCalledTimes(2);
    expect(screen.getByRole("region", { name: "Usage limits" })).toHaveTextContent("Messages3 of 30 in the last hour");
  });
});
