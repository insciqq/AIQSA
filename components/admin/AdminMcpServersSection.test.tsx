import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { AdminMcpController } from "@/components/admin/useAdminMcpController";
import { useAdminMcpSectionState } from "@/components/admin/useAdminMcpSectionState";
import type { AdminMcpServer } from "@/lib/contracts/mcp";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AdminMcpServersSection } from "./AdminMcpServersSection";

const server: AdminMcpServer = {
  activePersonalSlots: [{ label: "Test workspace", slotKey: "workspace_key" }],
  activeRevision: {
    artifactStatus: "not_applicable",
    createdAt: "2026-07-21T00:00:00.000Z",
    draftHash: "old",
    id: "revision-1",
    identityHash: "identity-old",
    resolvedArtifact: null,
    revisionNumber: 1,
    validationEvidence: {
      evidence: {},
      testedAt: "2026-07-21T00:00:00.000Z",
      toolInventory: [{ description: "Old description", name: "remember" }]
    }
  },
  archivedAt: null,
  description: "Team memory tools",
  draft: {
    auth: {
      allowedAuthorizationServerOrigins: ["https://auth.example.com"],
      mode: "oauth",
      scopes: ["memory:read"]
    },
    runtime: { callTimeoutMs: 60000, startupTimeoutMs: 60000 },
    slots: [{
      label: "Test workspace",
      policy: { kind: "personal", required: true },
      sensitive: true,
      slotKey: "workspace_key",
      target: { kind: "header", name: "X-Workspace-Key" },
      valueType: "secret"
    }],
    source: { kind: "remote", url: "https://mcp.example/mcp" },
    transport: "streamable_http"
  },
  draftTest: {
    draftHash: "new",
    evidence: {},
    identityHash: "identity-new",
    resolvedArtifact: null,
    testedAt: "2026-07-22T00:00:00.000Z",
    toolInventory: [
      { description: "New description", name: "remember" },
      { description: "Find memories", name: "recall" }
    ]
  },
  draftTested: true,
  enabled: true,
  grants: [],
  id: "server-1",
  name: "Memory",
  namespace: "memory",
  revisions: [],
  sharedValues: {},
  updatedAt: "2026-07-22T00:00:00.000Z",
  validationOAuth: {
    accountLabel: "AIQSA test workspace",
    connectedAt: "2026-07-22T00:00:00.000Z",
    state: "ready"
  }
};

function viewController(selectedServer: AdminMcpServer = server) {
  const actions = {
    activate: vi.fn().mockResolvedValue(true),
    checkUpdate: vi.fn().mockResolvedValue(true),
    create: vi.fn().mockResolvedValue(server),
    delete: vi.fn().mockResolvedValue(true),
    disconnectValidationOAuth: vi.fn().mockResolvedValue(true),
    dismissError: vi.fn(),
    dismissNotice: vi.fn(),
    grant: vi.fn().mockResolvedValue(true),
    rebuild: vi.fn().mockResolvedValue(true),
    refresh: vi.fn().mockResolvedValue(undefined),
    rollback: vi.fn().mockResolvedValue(true),
    select: vi.fn(),
    test: vi.fn().mockResolvedValue(true),
    update: vi.fn().mockResolvedValue(true)
  };
  return {
    actions,
    controller: {
      actions,
      state: {
        busy: false,
        error: null,
        loaded: true,
        loading: false,
        notice: null,
        selectedServer,
        servers: [selectedServer]
      }
    } as AdminMcpController
  };
}

function TestSection({ controller }: { controller: AdminMcpController }) {
  const section = useAdminMcpSectionState();
  return <AdminMcpServersSection controller={controller} section={section} />;
}

function PersistentSection({ controller }: { controller: AdminMcpController }) {
  const section = useAdminMcpSectionState();
  const [visible, setVisible] = useState(true);
  return (
    <>
      <button onClick={() => setVisible((current) => !current)} type="button">
        {visible ? "Hide MCP section" : "Show MCP section"}
      </button>
      {visible ? <AdminMcpServersSection controller={controller} section={section} /> : null}
    </>
  );
}

describe("AdminMcpServersSection", () => {
  afterEach(() => {
    window.history.replaceState(null, "", "/");
  });

  it("shows honest trust, OAuth, revision, inventory, and one-time test evidence", () => {
    const view = viewController();
    render(<TestSection controller={view.controller} />);

    expect(screen.getByText(/model may invoke every current or future valid tool/i)).toBeInTheDocument();
    expect(screen.getByText("External account: AIQSA test workspace")).toBeInTheDocument();
    const checkConnection = screen.getByRole("button", { name: "Check connection" });
    expect(checkConnection.closest("form")).toHaveAttribute(
      "action",
      "/api/admin/mcp/server-1/oauth/validation/connect"
    );
    expect(checkConnection.closest("form")).toHaveAttribute("method", "post");
    const reconnect = screen.getByRole("button", { name: "Reconnect" });
    expect(reconnect.closest("form")).toHaveAttribute(
      "action",
      "/api/admin/mcp/server-1/oauth/validation/reconnect"
    );
    expect(reconnect.closest("form")).toHaveAttribute("method", "post");
    expect(screen.getByText(/runtime health/i).parentElement).toHaveTextContent(/user-scoped/i);
    expect(screen.getByText(/\+1 added · 1 changed · −0 removed/)).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText("Test workspace"), { target: { value: "one-use-only" } });
    fireEvent.click(screen.getByRole("button", { name: "Test draft" }));
    expect(view.actions.test).toHaveBeenCalledWith("server-1", {
      oneTimeValues: { workspace_key: "one-use-only" }
    });
  });

  it("normalizes pasted npx configuration for review and keeps imported secrets in password fields", async () => {
    const view = viewController();
    render(<TestSection controller={view.controller} />);

    fireEvent.click(screen.getByRole("button", { name: "New server" }));
    expect(screen.getByRole("heading", { name: "Add an MCP server" })).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("Configuration JSON, URL, or install command"), {
      target: {
        value: JSON.stringify({
          mcpServers: {
            mem0: {
              args: ["-y", "@mem0/mcp-server@2.0.0"],
              command: "npx",
              env: { MEM0_API_KEY: "top-secret" }
            }
          }
        })
      }
    });
    fireEvent.click(screen.getByRole("button", { name: "Normalize and review" }));

    expect(screen.getByLabelText("Display name")).toHaveValue("mem0");
    expect(screen.getByLabelText("Source")).toHaveValue("npm");
    const secret = screen.getByLabelText("New shared value for MEM0_API_KEY");
    expect(secret).toHaveAttribute("type", "password");
    expect(secret).toHaveValue("top-secret");

    fireEvent.click(screen.getByRole("button", { name: "Create draft" }));
    await waitFor(() => expect(view.actions.create).toHaveBeenCalledTimes(1));
    expect(view.actions.create).toHaveBeenCalledWith(expect.objectContaining({
      name: "mem0",
      sharedValues: { mem0_api_key: "top-secret" }
    }));
  });

  it("uses an in-flow irreversible confirmation before deleting", () => {
    const view = viewController();
    render(<TestSection controller={view.controller} />);
    fireEvent.click(screen.getByRole("button", { name: "Delete…" }));
    const prompt = screen.getByText(/Delete Memory\?/i).closest("div");
    expect(prompt).not.toBeNull();
    expect(prompt).toHaveTextContent(/cannot be undone/i);
    fireEvent.click(within(prompt!).getByRole("button", { name: "Delete server" }));
    expect(view.actions.delete).toHaveBeenCalledWith("server-1");
  });

  it("hides activation when the tested identity already matches the active revision", () => {
    const active = {
      ...server,
      activeRevision: { ...server.activeRevision!, identityHash: "same" },
      draftTest: { ...server.draftTest!, identityHash: "same" }
    };
    const view = viewController(active);
    render(<TestSection controller={view.controller} />);

    expect(screen.queryByRole("button", { name: "Activate tested revision" })).not.toBeInTheDocument();
    expect(screen.getByText("The tested revision is active.")).toBeInTheDocument();
  });

  it("keeps activation available for a new resolved artifact under the same draft selector", () => {
    const update = {
      ...server,
      activeRevision: { ...server.activeRevision!, draftHash: "same", identityHash: "artifact-old" },
      draftTest: { ...server.draftTest!, draftHash: "same", identityHash: "artifact-new" }
    };
    render(<TestSection controller={viewController(update).controller} />);

    expect(screen.getByRole("button", { name: "Activate tested revision" })).toBeInTheDocument();
  });

  it("keeps an operational draft when the rendered admin section changes", () => {
    const view = viewController();
    render(<PersistentSection controller={view.controller} />);

    fireEvent.change(screen.getByRole("searchbox", { name: "Search MCP servers" }), {
      target: { value: "memory" }
    });
    fireEvent.click(screen.getByRole("button", { name: "New server" }));
    fireEvent.click(screen.getByRole("button", { name: "Configure manually" }));
    fireEvent.change(screen.getByLabelText("Display name"), { target: { value: "Unfinished draft" } });
    fireEvent.click(screen.getByRole("button", { name: "Hide MCP section" }));
    fireEvent.click(screen.getByRole("button", { name: "Show MCP section" }));

    expect(screen.getByRole("searchbox", { name: "Search MCP servers" })).toHaveValue("memory");
    expect(screen.getByLabelText("Display name")).toHaveValue("Unfinished draft");
  });

  it("selects the OAuth callback server and scrubs only callback query parameters", async () => {
    window.history.replaceState(
      null,
      "",
      "/admin?section=mcp&oauth=connected&server=server-1&keep=yes#current"
    );
    const view = viewController();
    render(<TestSection controller={view.controller} />);

    expect(screen.getByText(/Validation OAuth completed/i)).toBeInTheDocument();
    await waitFor(() => expect(view.actions.select).toHaveBeenCalledWith("server-1"));
    expect(window.location.search).toBe("?section=mcp&keep=yes");
    expect(window.location.hash).toBe("#current");
  });
});
