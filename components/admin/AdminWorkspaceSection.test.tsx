import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AdminWorkspaceSection } from "./AdminWorkspaceSection";

const workspaceApi = vi.hoisted(() => ({
  get: vi.fn(),
  update: vi.fn()
}));

vi.mock("./adminWorkspaceApi", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./adminWorkspaceApi")>();
  return {
    ...actual,
    getAdminWorkspacePolicy: workspaceApi.get,
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
  });

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
    render(<AdminWorkspaceSection />);

    expect(await screen.findByText("Ready")).toBeVisible();
    expect(screen.getByText("Runtime 0.6.16 · MCP 0.6.16")).toBeVisible();
    const enabled = screen.getByRole("checkbox", { name: "Enable Workspace" });
    const internet = screen.getByRole("checkbox", {
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
    expect(await screen.findByRole("status")).toHaveTextContent("Workspace policy updated.");
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
    render(<AdminWorkspaceSection />);

    expect(await screen.findByText("Unavailable")).toBeVisible();
    expect(screen.getByText("Hardware virtualization is unavailable to the runner.")).toBeVisible();
    expect(screen.getByRole("checkbox", { name: "Enable Workspace" })).toBeEnabled();
  });
});
