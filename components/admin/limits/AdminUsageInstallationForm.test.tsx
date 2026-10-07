import { act, fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { AdminUsageInstallationForm } from "./AdminUsageInstallationForm";
import type { AdminUsageLimitsController } from "./useAdminUsageLimits";

const original = { messagesPerDay: null, messagesPerHour: null, monthlyBudgetMicros: null, monthlyCapMicros: null, version: 1 };

function setup(saveInstallation: AdminUsageLimitsController["saveInstallation"]) {
  const controller = { busy: false, refresh: vi.fn(async () => undefined), saveInstallation } as unknown as AdminUsageLimitsController;
  const props = { controller, reportNotice: vi.fn() };
  const view = render(<AdminUsageInstallationForm {...props} installation={original} />);
  return { props, view };
}

describe("AdminUsageInstallationForm", () => {
  it("saves against the version the draft started from, so a refresh cannot hide another administrator's change", async () => {
    const saveInstallation = vi.fn(async () => ({ error: "usage_limits_stale" as const, ok: false as const }));
    const { props, view } = setup(saveInstallation);
    fireEvent.change(screen.getByRole("textbox", { name: "Messages per day" }), { target: { value: "40" } });
    view.rerender(<AdminUsageInstallationForm {...props} installation={{ ...original, monthlyCapMicros: 100_000_000, version: 2 }} />);
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Save limits" })); });
    expect(saveInstallation).toHaveBeenCalledWith({
      expectedVersion: 1, messagesPerDay: 40, messagesPerHour: null, monthlyBudgetMicros: null, monthlyCapMicros: null
    });
    expect(screen.getAllByText(/Saved: \$100\.00/u).length).toBeGreaterThan(0);
  });

  it("after a shown conflict, saves the reviewed draft against the current version", async () => {
    const saveInstallation = vi.fn()
      .mockResolvedValueOnce({ error: "usage_limits_stale", ok: false })
      .mockResolvedValueOnce({ ok: true });
    const { props, view } = setup(saveInstallation);
    fireEvent.change(screen.getByRole("textbox", { name: "Messages per day" }), { target: { value: "40" } });
    view.rerender(<AdminUsageInstallationForm {...props} installation={{ ...original, monthlyCapMicros: 100_000_000, version: 2 }} />);
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Save limits" })); });
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Save limits" })); });
    expect(saveInstallation).toHaveBeenLastCalledWith(expect.objectContaining({ expectedVersion: 2, messagesPerDay: 40 }));
  });
});
