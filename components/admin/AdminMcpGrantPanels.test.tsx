import { fireEvent, render, screen, within } from "@testing-library/react";
import type { AdminMcpController } from "@/components/admin/useAdminMcpController";
import type { AdminGroup, AdminUserRecord } from "@/lib/contracts/admin";
import type { AdminMcpServer } from "@/lib/contracts/mcp";
import { describe, expect, it, vi } from "vitest";
import { AdminMcpGroupAccessPanel, AdminMcpUserAccessPanel } from "./AdminMcpGrantPanels";

const server: AdminMcpServer = {
  activePersonalSlots: [{ label: "API key", slotKey: "api_key" }],
  activeRevision: null,
  activation: null,
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
  systemRole: null,
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
  it("edits whole-server group grants in Access & groups without personal slots", () => {
    const view = controller();
    render(<AdminMcpGroupAccessPanel controller={view.controller} group={group} />);

    fireEvent.click(screen.getByRole("button", { name: "Grant Memory for group operators" }));
    expect(view.grant).toHaveBeenCalledWith("server-1", {
      canUse: true,
      groupId: "group-1"
    });
    expect(screen.queryByText("API key")).not.toBeInTheDocument();
  });

  it("renders full-access MCP coverage as automatic and never offers a grant mutation", () => {
    const view = controller({
      ...server,
      grants: [{
        canUse: true,
        groupId: "group-full-access",
        groupName: "full-access",
        id: "grant-system",
        personalSlotKeys: [],
        userId: null,
        userName: null
      }]
    });
    render(<AdminMcpGroupAccessPanel
      controller={view.controller}
      group={{ ...group, id: "group-full-access", name: "full-access", systemRole: "full_access" }}
    />);

    expect(screen.getByText("Included automatically")).toBeInTheDocument();
    expect(screen.getByText(/every current and future MCP server/u)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Memory for group full-access/u })).not.toBeInTheDocument();
    expect(view.grant).not.toHaveBeenCalled();
  });

  it("keeps an installation-wide disabled server visible beside its independent grant", () => {
    const view = controller({ ...server, enabled: false });
    render(<AdminMcpGroupAccessPanel controller={view.controller} group={group} />);

    expect(screen.getByText("Disabled")).toHaveClass("border-trace-strong", "bg-control-surface", "text-ink");
    expect(screen.getByRole("button", { name: "Grant Memory for group operators" })).toBeEnabled();
  });

  it("keeps direct use and exact personal-field grants in selected user details", () => {
    const view = controller();
    render(<AdminMcpUserAccessPanel controller={view.controller} groups={[]} user={user} />);

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
    render(<AdminMcpUserAccessPanel controller={view.controller} groups={[]} user={user} />);

    expect(screen.queryByRole("checkbox", { name: "API key" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("checkbox", { name: "removed_key" }));
    expect(view.grant).toHaveBeenLastCalledWith("server-1", {
      canUse: false,
      personalSlotKeys: [],
      userId: "user-1"
    });
  });

  it("shows inherited Full access separately from the direct grant control", () => {
    const view = controller();
    const fullAccess = {
      ...group,
      id: "group-full-access",
      name: "Full access",
      systemRole: "full_access" as const
    };
    render(
      <AdminMcpUserAccessPanel
        controller={view.controller}
        groups={[fullAccess]}
        user={{
          ...user,
          groups: [{ groupId: fullAccess.id, name: fullAccess.name, role: "member" }]
        }}
      />
    );

    expect(screen.getByText("Included via Full access")).toHaveAttribute(
      "data-effective-mcp-access",
      "granted"
    );
    expect(screen.getByRole("button", { name: "Grant Memory directly for Alice" })).toHaveTextContent("Grant directly");
  });

  it("names an ordinary group that provides effective MCP access", () => {
    const view = controller({
      ...server,
      grants: [{
        canUse: true,
        groupId: group.id,
        groupName: group.name,
        id: "grant-group",
        personalSlotKeys: [],
        userId: null,
        userName: null
      }]
    });
    render(
      <AdminMcpUserAccessPanel
        controller={view.controller}
        groups={[group]}
        user={{
          ...user,
          groups: [{ groupId: group.id, name: group.name, role: "member" }]
        }}
      />
    );

    expect(screen.getByText("Included via operators")).toHaveAttribute(
      "data-effective-mcp-access",
      "granted"
    );
    expect(screen.getByRole("button", { name: "Grant Memory directly for Alice" })).toHaveTextContent("Grant directly");
  });

  it("does not call assigned group access effective while the account is inactive", () => {
    const fullAccess = {
      ...group,
      id: "group-full-access",
      name: "Full access",
      systemRole: "full_access" as const
    };
    const view = controller();
    render(
      <AdminMcpUserAccessPanel
        controller={view.controller}
        groups={[fullAccess]}
        user={{
          ...user,
          groups: [{ groupId: fullAccess.id, name: fullAccess.name, role: "member" }],
          status: "disabled"
        }}
      />
    );

    expect(screen.getByText("Unavailable while account is inactive")).toHaveAttribute(
      "data-effective-mcp-access",
      "not-granted"
    );
    expect(screen.getByRole("button", { name: "Grant Memory directly for Alice" })).toBeDisabled();
  });
});
