import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AdminWorkspaceSection } from "./AdminWorkspaceSection";

const workspaceApi = vi.hoisted(() => ({
  get: vi.fn(),
  overview: vi.fn(),
  update: vi.fn()
}));

const reportNotice = vi.fn();

vi.mock("./adminWorkspaceApi", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./adminWorkspaceApi")>();
  return {
    ...actual,
    getAdminWorkspacePolicy: workspaceApi.get,
    getAdminWorkspaceOverview: workspaceApi.overview,
    updateAdminWorkspacePolicy: workspaceApi.update
  };
});

const readyPolicy = {
  enabled: false,
  internetEnabled: true,
  runtime: {
    imageReady: true,
    mcpVersion: "0.6.16",
    runtimeVersion: "0.6.16",
    state: "ready" as const,
    virtualizationReady: true
  },
  version: 2
};

describe("AdminWorkspaceSection", () => {
  beforeEach(() => {
    workspaceApi.get.mockReset().mockResolvedValue({ data: readyPolicy, ok: true });
    workspaceApi.update.mockReset();
    workspaceApi.overview.mockReset().mockResolvedValue({ ok: true, data: {
      activeCount: 0, filter: "active", observedAt: "2026-09-09T12:00:00.000Z", page: 1, pageSize: 20,
      rows: [], state: "fresh", stoppedCount: 1, totalCount: 0, transitioningCount: 0, unknownCount: 0,
      updatedAt: "2026-09-09T12:00:00.000Z"
    } });
    reportNotice.mockReset();
  });
  afterEach(() => vi.restoreAllMocks());

  it("shows content-free readiness and persists both installation controls", async () => {
    workspaceApi.update
      .mockResolvedValueOnce({
        data: { ...readyPolicy, enabled: true, version: 3 },
        ok: true
      })
      .mockResolvedValueOnce({
        data: { ...readyPolicy, enabled: true, internetEnabled: false, version: 4 },
        ok: true
      });
    render(<AdminWorkspaceSection reportNotice={reportNotice} />);

    expect(await screen.findByText("Ready")).toBeVisible();
    expect(screen.getByText("Runtime 0.6.16 · MCP 0.6.16")).toBeVisible();
    const enabled = screen.getByRole("switch", { name: "Enable Workspace" });
    const internet = screen.getByRole("switch", {
      name: "Allow public internet in new workspaces"
    });
    expect(enabled).not.toBeChecked();
    expect(internet).toBeChecked();

    fireEvent.click(enabled);
    await waitFor(() => expect(workspaceApi.update).toHaveBeenNthCalledWith(1, 2, {
      enabled: true
    }));
    await waitFor(() => expect(enabled).toBeChecked());
    fireEvent.click(internet);
    await waitFor(() => expect(workspaceApi.update).toHaveBeenNthCalledWith(2, 3, {
      internetEnabled: false
    }));
    await waitFor(() => expect(internet).not.toBeChecked());
    expect(reportNotice).toHaveBeenCalledWith("Workspace policy updated.");
  });

  it("keeps policy controls visible while explaining unavailable virtualization", async () => {
    workspaceApi.get.mockResolvedValue({
      data: {
        ...readyPolicy,
        runtime: {
          imageReady: true,
          reasonCode: "workspace_virtualization_unavailable",
          state: "unavailable" as const,
          virtualizationReady: false
        }
      },
      ok: true
    });
    render(<AdminWorkspaceSection reportNotice={reportNotice} />);

    expect(await screen.findByText("Unavailable")).toBeVisible();
    expect(screen.getByText("Hardware virtualization is unavailable to the runner.")).toBeVisible();
    expect(screen.getByRole("switch", { name: "Enable Workspace" })).toBeEnabled();
  });

  it("refreshes on focus without allowing an older read to replace a saved policy", async () => {
    let now = 0;
    vi.spyOn(Date, "now").mockImplementation(() => now);
    let finishRead!: (value: unknown) => void;
    render(<AdminWorkspaceSection reportNotice={reportNotice} />);
    const enabled = await screen.findByRole("switch", { name: "Enable Workspace" });
    workspaceApi.get.mockImplementationOnce(() => new Promise((resolve) => { finishRead = resolve; }));
    now = 6_000;
    fireEvent.focus(window);
    workspaceApi.update.mockResolvedValue({ data: { ...readyPolicy, enabled: true, version: 3 }, ok: true });
    fireEvent.click(enabled);
    await waitFor(() => expect(enabled).toBeChecked());
    await act(async () => finishRead({ data: readyPolicy, ok: true }));
    expect(enabled).toBeChecked();

    workspaceApi.get.mockResolvedValue({ data: { ...readyPolicy, version: 4 }, ok: true });
    now = 12_000;
    fireEvent.focus(window);
    await waitFor(() => expect(enabled).not.toBeChecked());
  });

  it("keeps a failed policy save visible through activity and policy refreshes", async () => {
    let now = 0;
    vi.spyOn(Date, "now").mockImplementation(() => now);
    workspaceApi.update.mockResolvedValue({ error: "workspace_policy_action_failed", ok: false });
    render(<AdminWorkspaceSection reportNotice={reportNotice} />);
    fireEvent.click(await screen.findByRole("switch", { name: "Enable Workspace" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Workspace policy could not be updated.");
    fireEvent.click(screen.getByRole("button", { name: "Refresh activity" }));
    now = 6_000;
    fireEvent.focus(window);
    await waitFor(() => expect(workspaceApi.get).toHaveBeenCalledTimes(2));
    expect(screen.getByRole("alert")).toHaveTextContent("Workspace policy could not be updated.");
    expect(screen.getByRole("switch", { name: "Enable Workspace" })).not.toBeChecked();
  });
});
