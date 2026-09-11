import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { AdminMcpController } from "@/components/admin/useAdminMcpController";
import type { AdminGroup, AdminUserRecord } from "@/lib/contracts/admin";
import type { AdminMcpServer, McpToolAccessPolicy } from "@/lib/contracts/mcp";
import { AdminMcpToolAccessEditor } from "./AdminMcpToolAccessEditor";

const groups: AdminGroup[] = [{ id: "editors", name: "Tracker editors", archivedAt: null, systemRole: null, userCount: 1, accessGrants: [] },
  { id: "full", name: "Full access", archivedAt: null, systemRole: "full_access", userCount: 1, accessGrants: [] }];
const users: AdminUserRecord[] = [{
  id: "alice", displayName: "Alice", email: "alice@example.test", status: "active", role: "admin",
  groups: [{ groupId: "editors", name: "Tracker editors", role: "member" }],
  directGrants: [], effectiveEntitlements: { models: [], providers: [], searchStrategies: [] },
  hasVerifiedIdentity: true, lastSessionAt: null
}];
const empty: McpToolAccessPolicy = { name: "issue_update", restricted: false, userIds: [], groupIds: [] };
function server(policy = empty, updatedAt = "2026-09-11T19:00:00.000Z"): AdminMcpServer {
  return {
    id: "tracker", name: "Tracker", namespace: "tracker", description: "", enabled: true,
    activation: null, activePersonalSlots: [], activeRevision: null, archivedAt: null,
    draft: { auth: { mode: "none" }, runtime: { callTimeoutMs: 30000, startupTimeoutMs: 30000 },
      slots: [], source: { kind: "remote", url: "https://mcp.example.test/mcp" }, transport: "streamable_http" },
    draftTest: null, draftTested: false, grants: [], revisions: [], sharedValues: {}, updatedAt,
    validationOAuth: null, toolAccess: [policy]
  };
}
function fixture(policy = empty) {
  const update = vi.fn<AdminMcpController["actions"]["update"]>(async () => true);
  const refresh = vi.fn(async () => undefined);
  const controller = { actions: { update, refresh }, state: { busy: false } } as unknown as AdminMcpController;
  const onClose = vi.fn();
  const props = { controller, groups, name: "issue_update", onClose, server: server(policy), users };
  return { ...render(<AdminMcpToolAccessEditor {...props} />), props, update, refresh, onClose };
}

describe("MCP tool recipients", () => {
  it("allows removing a recipient deleted during editing without losing other selections", async () => {
    const f = fixture({ ...empty, restricted: true, userIds: ["alice"], groupIds: ["editors"] });
    f.rerender(<AdminMcpToolAccessEditor {...f.props} users={[]} />);
    fireEvent.click(screen.getByRole("button", { name: "Remove unavailable user 1" }));
    expect(screen.getByRole("checkbox", { name: "Allow group Tracker editors" })).toBeChecked();
    fireEvent.click(screen.getByRole("button", { name: "Save access" }));
    await waitFor(() => expect(f.onClose).toHaveBeenCalled());
    expect(f.update.mock.calls[0]![1].toolAccess).toEqual({ ...empty, restricted: true, groupIds: ["editors"] });
  });
  it("focuses the editor and saves restricted + empty atomically", async () => {
    const f = fixture();
    expect(screen.getByRole("heading", { name: "Access to issue_update" })).toHaveFocus();
    expect(screen.getByText("Available to everyone with MCP access")).toBeVisible();
    fireEvent.click(screen.getByRole("switch"));
    expect(screen.getByText("Restricted · No one has access")).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Save access" }));
    await waitFor(() => expect(f.onClose).toHaveBeenCalledOnce());
    expect(f.update).toHaveBeenCalledWith("tracker", { expectedUpdatedAt: f.props.server.updatedAt, toolAccess: { ...empty, restricted: true } });
  });

  it("keeps selected recipients visible during search and distinguishes direct from inherited access", async () => {
    const f = fixture({ ...empty, restricted: true });
    fireEvent.click(screen.getByRole("checkbox", { name: "Allow group Tracker editors" }));
    fireEvent.click(screen.getByRole("checkbox", { name: "Allow user Alice" }));
    expect(screen.getByText("Granted directly · Via Tracker editors")).toBeVisible();
    fireEvent.change(screen.getByRole("searchbox"), { target: { value: "no matching account" } });
    expect(screen.getByRole("checkbox", { name: "Allow user Alice" })).toBeChecked();
    fireEvent.change(screen.getByRole("searchbox"), { target: { value: "Alice" } });
    fireEvent.click(screen.getByRole("checkbox", { name: "Allow user Alice" }));
    expect(screen.getByText("Via Tracker editors")).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Save access" }));
    await waitFor(() => expect(f.onClose).toHaveBeenCalled());
    expect(f.update.mock.calls[0]![1].toolAccess).toEqual({ ...empty, restricted: true, groupIds: ["editors"] });
  });

  it("retains the saved recipient list while restriction is off", async () => {
    const policy = { ...empty, restricted: true, groupIds: ["full"], userIds: ["alice"] };
    const f = fixture(policy);
    fireEvent.click(screen.getByRole("switch"));
    expect(screen.queryByRole("searchbox")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("switch"));
    expect(screen.getByRole("checkbox", { name: "Allow group Full access" })).toBeChecked();
    expect(screen.getByRole("checkbox", { name: "Allow user Alice" })).toBeChecked();
    fireEvent.click(screen.getByRole("switch"));
    fireEvent.click(screen.getByRole("button", { name: "Save access" }));
    await waitFor(() => expect(f.onClose).toHaveBeenCalled());
    expect(f.update.mock.calls[0]![1].toolAccess).toEqual({ ...policy, restricted: false });
  });

  it("preserves selections on failure and requires explicit loading of a competing save", async () => {
    const f = fixture({ ...empty, restricted: true });
    f.update.mockResolvedValue(false);
    fireEvent.click(screen.getByRole("checkbox", { name: "Allow user Alice" }));
    fireEvent.click(screen.getByRole("button", { name: "Save access" }));
    await screen.findByRole("alert");
    expect(screen.getByRole("checkbox", { name: "Allow user Alice" })).toBeChecked();
    expect(f.onClose).not.toHaveBeenCalled();
    const current = server({ ...empty, restricted: true, groupIds: ["editors"] }, "2026-09-11T19:01:00.000Z");
    f.rerender(<AdminMcpToolAccessEditor {...f.props} server={current} />);
    expect(screen.getByRole("button", { name: "Save access" })).toBeDisabled();
    expect(screen.getByRole("checkbox", { name: "Allow user Alice" })).toBeChecked();
    fireEvent.click(screen.getByRole("button", { name: "Load saved access" }));
    expect(screen.getByRole("checkbox", { name: "Allow user Alice" })).not.toBeChecked();
    expect(screen.getByRole("checkbox", { name: "Allow group Tracker editors" })).toBeChecked();
    expect(screen.getByRole("button", { name: "Save access" })).toBeEnabled();
  });
});
