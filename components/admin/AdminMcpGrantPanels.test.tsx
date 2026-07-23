import { fireEvent, render, screen, within } from "@testing-library/react";
import type { AdminMcpController } from "@/components/admin/useAdminMcpController";
import type { AdminGroup, AdminUserRecord } from "@/lib/contracts/admin";
import type { AdminMcpServer } from "@/lib/contracts/mcp";
import { describe, expect, it, vi } from "vitest";
import { AdminMcpGroupAccessPanel, AdminMcpUserAccessPanel } from "./AdminMcpGrantPanels";

const server: AdminMcpServer = {
  activePersonalSlots: [{ label: "API key", slotKey: "api_key" }],
  activeRevision: null,
  archivedAt: null,
  description: "Memory",
  draft: {
    auth: { mode: "static" },
    runtime: { callTimeoutMs: 60000, startupTimeoutMs: 60000 },
    slots: [{
      label: "API key",
      policy: { kind: "personal", required: true },
      sensitive: true,
      slotKey: "api_key",
      target: { kind: "header", name: "Authorization" },
      valueType: "secret"
    }],
    source: { kind: "remote", url: "https://mcp.example/mcp" },
    transport: "streamable_http"
  },
  draftTest: null,
  draftTested: false,
  enabled: true,
  grants: [],
  id: "server-1",
  name: "Memory",
  namespace: "memory",
  revisions: [],
  sharedValues: {},
  updatedAt: "2026-07-22T00:00:00.000Z",
  validationOAuth: null
};

const group: AdminGroup = {
  accessGrants: [],
  archivedAt: null,
  id: "group-1",
  name: "operators",
  userCount: 2
};

const user: AdminUserRecord = {
  displayName: "Alice",
  effectiveEntitlements: { models: [], providers: [], searchStrategies: [] },
  email: "alice@example.com",
  groups: [],
  hasVerifiedIdentity: true,
  id: "user-1",
  lastSessionAt: null,
  role: "user",
  status: "active"
};

function controller(selectedServer: AdminMcpServer = server) {
  const grant = vi.fn().mockResolvedValue(true);
  return {
    controller: {
      actions: { grant },
      state: {
        busy: false,
        error: null,
        loaded: true,
        loading: false,
        notice: null,
        selectedServer,
        servers: [selectedServer]
      }
    } as unknown as AdminMcpController,
    grant
  };
}

describe("Admin MCP grant ownership", () => {
  it("edits whole-server group grants in Model access without personal slots", () => {
    const view = controller();
    render(<AdminMcpGroupAccessPanel controller={view.controller} group={group} />);

    fireEvent.click(screen.getByRole("button", { name: "Grant Memory for group operators" }));
    expect(view.grant).toHaveBeenCalledWith("server-1", {
      canUse: true,
      groupId: "group-1"
    });
    expect(screen.queryByText("API key")).not.toBeInTheDocument();
  });

  it("keeps direct use and exact personal-field grants in selected user details", () => {
    const view = controller();
    render(<AdminMcpUserAccessPanel controller={view.controller} user={user} />);

    fireEvent.click(screen.getByRole("button", { name: "Grant Memory directly for Alice" }));
    expect(view.grant).toHaveBeenLastCalledWith("server-1", {
      canUse: true,
      personalSlotKeys: [],
      userId: "user-1"
    });

    const panel = screen.getByTestId("admin-user-mcp-access");
    fireEvent.click(within(panel).getByRole("checkbox", { name: "API key" }));
    expect(view.grant).toHaveBeenLastCalledWith("server-1", {
      canUse: false,
      personalSlotKeys: ["api_key"],
      userId: "user-1"
    });
  });

  it("uses active-revision personal slots and exposes stale grant keys for cleanup", () => {
    const view = controller({
      ...server,
      activePersonalSlots: [],
      grants: [{
        canUse: false,
        groupId: null,
        groupName: null,
        id: "grant-1",
        personalSlotKeys: ["removed_key"],
        userId: user.id,
        userName: user.displayName
      }]
    });
    render(<AdminMcpUserAccessPanel controller={view.controller} user={user} />);

    expect(screen.queryByRole("checkbox", { name: "API key" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("checkbox", { name: "removed_key" }));
    expect(view.grant).toHaveBeenLastCalledWith("server-1", {
      canUse: false,
      personalSlotKeys: [],
      userId: "user-1"
    });
  });
});
