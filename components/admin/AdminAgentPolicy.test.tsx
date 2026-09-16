import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_AGENT_POLICY } from "@/lib/contracts/agentPolicy";
import { AdminAgentPolicy } from "./AdminAgentPolicy";

const api = vi.hoisted(() => ({ request: vi.fn() }));
vi.mock("./adminAgentPolicyApi", async (original) => ({
  ...await original<typeof import("./adminAgentPolicyApi")>(), requestAgentPolicy: api.request
}));
afterEach(() => vi.resetAllMocks());
describe("Agent policy editor", () => {
  it("starts off, keeps saved values when toggled and saves a versioned block", async () => {
    api.request.mockResolvedValue({ ok: true, policy: DEFAULT_AGENT_POLICY });
    const reportNotice = vi.fn();
    render(<AdminAgentPolicy reportNotice={reportNotice} />);
    const toggle = await screen.findByRole("switch", { name: "Apply Agent limits" });
    const calls = screen.getByRole("spinbutton", { name: "Provider calls per turn" });
    expect(toggle).not.toBeChecked(); expect(calls).toBeDisabled(); expect(calls).toHaveValue(40);
    fireEvent.click(toggle); expect(calls).toBeEnabled();
    fireEvent.change(calls, { target: { value: "3" } });
    fireEvent.click(toggle); expect(calls).toBeDisabled(); expect(calls).toHaveValue(3);
    api.request.mockResolvedValue({ ok: true, policy: { ...DEFAULT_AGENT_POLICY, maxModelCalls: 3, version: 2 } });
    fireEvent.click(screen.getByRole("button", { name: "Save Agent settings" }));
    await waitFor(() => expect(reportNotice).toHaveBeenCalled());
    expect(api.request).toHaveBeenLastCalledWith(expect.objectContaining({ update: expect.objectContaining({
      expectedVersion: 1, limitsEnabled: false, maxModelCalls: 3
    }) }));
    expect(screen.getByRole("button", { name: "Save Agent settings" })).toBeDisabled();
  });
  it("preserves edits across focus and a version conflict and shows the new saved values", async () => {
    api.request.mockResolvedValue({ ok: true, policy: { ...DEFAULT_AGENT_POLICY, limitsEnabled: true } });
    render(<AdminAgentPolicy reportNotice={vi.fn()} />);
    const calls = await screen.findByRole("spinbutton", { name: "Provider calls per turn" });
    fireEvent.change(calls, { target: { value: "7" } }); fireEvent.focus(window);
    expect(api.request).toHaveBeenCalledTimes(1);
    api.request.mockResolvedValueOnce({ ok: false, error: "agent_policy_stale" })
      .mockResolvedValueOnce({ ok: true, policy: { ...DEFAULT_AGENT_POLICY, maxModelCalls: 9, version: 2 } });
    fireEvent.click(screen.getByRole("button", { name: "Save Agent settings" }));
    expect(await screen.findByText("Saved: 9")).toBeVisible();
    expect(calls).toHaveValue(7); expect(calls).toBeEnabled();
    expect(screen.getByRole("alert")).toHaveTextContent("Your edits were kept");
    api.request.mockResolvedValue({ ok: true, policy: { ...DEFAULT_AGENT_POLICY, maxModelCalls: 7, limitsEnabled: true, version: 3 } });
    fireEvent.click(screen.getByRole("button", { name: "Save Agent settings" }));
    await waitFor(() => expect(api.request).toHaveBeenLastCalledWith(expect.objectContaining({ update: expect.objectContaining({
      expectedVersion: 2, maxModelCalls: 7, limitsEnabled: true
    }) })));
  });
});
