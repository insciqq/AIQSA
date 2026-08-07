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
  activation: null,
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

  it("shows honest trust, OAuth, revision, inventory, and one-time test evidence", async () => {
    const view = viewController();
    render(<TestSection controller={view.controller} />);

    expect(screen.getByText(/newly discovered tool names are enabled by default/i)).toBeInTheDocument();
    expect(screen.getByText(/user-scoped; not returned by this admin catalog/i)).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /Validate & tools/i }));
    expect(screen.getByText("External account: AIQSA test workspace")).toBeInTheDocument();
    const checkConnection = screen.getByRole("link", { name: "Check connection" });
    expect(checkConnection).toHaveAttribute(
      "href",
      "/api/admin/mcp/server-1/oauth/validation/connect"
    );
    const reconnect = screen.getByRole("link", { name: "Reconnect" });
    expect(reconnect).toHaveAttribute(
      "href",
      "/api/admin/mcp/server-1/oauth/validation/reconnect"
    );
    expect(screen.getByText(/\+1 added · 1 changed · −0 removed/)).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText("Test workspace"), { target: { value: "one-use-only" } });
    fireEvent.click(screen.getByRole("button", { name: "Test draft" }));
    expect(view.actions.test).toHaveBeenCalledWith("server-1", {
      oneTimeValues: { workspace_key: "one-use-only" }
    });
    await waitFor(() => expect(screen.getByLabelText("Test workspace")).toHaveValue(""));
  });

  it("clears one-time validation values after a request settles", async () => {
    const view = viewController();
    render(<TestSection controller={view.controller} />);
    fireEvent.click(screen.getByRole("button", { name: /Validate & tools/i }));

    const oneTime = screen.getByLabelText("Test workspace");
    fireEvent.change(oneTime, { target: { value: "one-use-only" } });
    fireEvent.click(screen.getByRole("button", { name: "Test draft" }));

    await waitFor(() => expect(oneTime).toHaveValue(""));
  });

  it("edits candidate tool policy without implying the active revision changed", () => {
    const policyServer: AdminMcpServer = {
      ...server,
      activeRevision: server.activeRevision
        ? { ...server.activeRevision, disabledToolNames: ["remember"] }
        : null,
      draft: {
        ...server.draft,
        disabledToolNames: ["recall", "stale_tool"]
      },
      draftTested: false
    };
    const view = viewController(policyServer);
    render(<TestSection controller={view.controller} />);

    fireEvent.click(screen.getByRole("button", { name: /Validate & tools/i }));

    expect(screen.getByText("Candidate draft — 1 enabled · 1 disabled")).toBeInTheDocument();
    expect(screen.getByText("Active revision 1 — 0 enabled · 1 disabled")).toBeInTheDocument();
    expect(screen.getByText(/inventory came from the previous draft test/i)).toBeInTheDocument();
    expect(screen.getByRole("checkbox", { name: "Enabled for remember" })).toBeChecked();
    expect(screen.getByRole("checkbox", { name: "Enabled for recall" })).not.toBeChecked();
    expect(screen.getByText("stale_tool")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("checkbox", { name: "Enabled for remember" }));
    expect(view.actions.update).toHaveBeenNthCalledWith(1, "server-1", {
      draft: { ...policyServer.draft, disabledToolNames: ["recall", "remember", "stale_tool"] }
    });

    fireEvent.click(screen.getByRole("button", { name: "Remove disabled name stale_tool" }));
    expect(view.actions.update).toHaveBeenNthCalledWith(2, "server-1", {
      draft: { ...policyServer.draft, disabledToolNames: ["recall"] }
    });
  });

  it("makes disabled installation availability and its restoration action explicit", () => {
    const view = viewController({ ...server, enabled: false });
    render(<TestSection controller={view.controller} />);

    for (const status of screen.getAllByText("Disabled")) {
      expect(status).toHaveClass("border-trace-strong", "bg-control-surface", "text-ink");
    }

    fireEvent.click(screen.getByRole("button", { name: /Runtime Availability to users/i }));
    const enable = screen.getByRole("button", { name: "Enable" });
    expect(enable).toHaveClass("border-proof/25", "bg-proof/[0.08]", "text-proof");
    fireEvent.click(enable);
    expect(view.actions.update).toHaveBeenCalledWith("server-1", { enabled: true });
  });

  it("normalizes trailing-comma uvx configuration from the document editor and keeps secrets in password fields", async () => {
    const view = viewController();
    render(<TestSection controller={view.controller} />);

    fireEvent.click(screen.getByRole("button", { name: "New server" }));
    expect(screen.getByRole("heading", { name: "Add an MCP server" })).toBeInTheDocument();
    expect(screen.getByText("Configuration document")).toBeInTheDocument();
    expect(screen.getByText("Trailing commas accepted")).toBeInTheDocument();
    const editor = screen.getByLabelText("Configuration JSON, URL, or install command");
    expect(editor).toHaveClass("h-[clamp(18rem,36dvh,22rem)]", "min-h-72", "resize-y", "font-mono");
    expect(editor).not.toHaveClass("min-h-control");
    fireEvent.change(editor, {
      target: {
        value: `{
  "mcpServers": {
    "mem0": {
      "command": "uvx",
      "args": ["mem0-mcp-server",],
      "env": {
        "MEM0_API_KEY": "fixture-secret",
      },
    },
  },
}`
      }
    });
    expect(screen.getByText("11 lines")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Parse" }));

    expect(screen.getByLabelText("Display name")).toHaveValue("mem0");
    expect(screen.getByLabelText("Display name")).toHaveFocus();
    expect(screen.getByLabelText("Source")).toHaveValue("pypi");
    const secret = screen.getByLabelText("New shared value for MEM0_API_KEY");
    expect(secret).toHaveAttribute("type", "password");
    expect(secret).toHaveValue("fixture-secret");

    fireEvent.click(screen.getByRole("button", { name: "Activate" }));
    await waitFor(() => expect(view.actions.create).toHaveBeenCalledTimes(1));
    expect(view.actions.create).toHaveBeenCalledWith(expect.objectContaining({
      activate: true,
      name: "mem0",
      sharedValues: { mem0_api_key: "fixture-secret" }
    }));
  });

  it("keeps malformed JSON in the document editor with an associated recoverable error", async () => {
    const view = viewController();
    render(<TestSection controller={view.controller} />);

    fireEvent.click(screen.getByRole("button", { name: "New server" }));
    const editor = screen.getByLabelText("Configuration JSON, URL, or install command");
    const malformed = '{"command": "uvx", "args": ["server",],,}';
    fireEvent.change(editor, { target: { value: malformed } });
    fireEvent.click(screen.getByRole("button", { name: "Parse" }));

    expect(editor).toHaveAttribute("aria-invalid", "true");
    expect(editor).toHaveAttribute("aria-describedby", "mcp-import-help mcp-import-error");
    await waitFor(() => expect(editor).toHaveFocus());
    expect(editor).toHaveValue(malformed);
    expect(screen.getByRole("alert")).toHaveTextContent(/configuration needs attention/i);
    expect(screen.getByRole("alert")).toHaveTextContent(/not valid JSON/i);

    fireEvent.change(editor, { target: { value: `${malformed} ` } });
    expect(editor).not.toHaveAttribute("aria-invalid");
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("prepares the official hosted Notion snippet for same-origin OAuth", async () => {
    const view = viewController();
    render(<TestSection controller={view.controller} />);

    fireEvent.click(screen.getByRole("button", { name: "New server" }));
    fireEvent.change(screen.getByLabelText("Configuration JSON, URL, or install command"), {
      target: {
        value: JSON.stringify({
          mcpServers: {
            notion: { url: "https://mcp.notion.com/mcp" }
          }
        })
      }
    });
    fireEvent.click(screen.getByRole("button", { name: "Parse" }));

    expect(screen.getByLabelText("Display name")).toHaveValue("notion");
    expect(screen.getByLabelText("Mode")).toHaveValue("oauth");
    expect(screen.getByLabelText("Allowed authorization server origins"))
      .toHaveValue("https://mcp.notion.com");
    expect(screen.getByText(/pre-fills the MCP endpoint origin/i)).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Continue to authorization" }));
    await waitFor(() => expect(view.actions.create).toHaveBeenCalledTimes(1));
    expect(view.actions.create).toHaveBeenCalledWith(expect.objectContaining({
      draft: expect.objectContaining({
        auth: {
          allowedAuthorizationServerOrigins: ["https://mcp.notion.com"],
          mode: "oauth",
          scopes: []
        }
      }),
      name: "notion"
    }));
    expect(view.actions.create).not.toHaveBeenCalledWith(expect.objectContaining({ activate: true }));
  });

  it("uses an in-flow irreversible confirmation before deleting", () => {
    const view = viewController();
    render(<TestSection controller={view.controller} />);
    fireEvent.click(screen.getByRole("button", { name: /Delete Irreversible removal/i }));
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
    expect(screen.getByText(/latest tested identity is already active/i)).toBeInTheDocument();
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

  it("shows the exact background activation stage without asking for another activation", () => {
    const activating: AdminMcpServer = {
      ...server,
      activeRevision: null,
      enabled: false,
      activation: {
        completedAt: null,
        errorCode: null,
        id: "attempt-1",
        issues: [],
        requestedAt: "2026-07-22T01:00:00.000Z",
        stage: "discovering_tools",
        startedAt: "2026-07-22T01:00:01.000Z",
        updatedAt: "2026-07-22T01:00:02.000Z"
      }
    };
    render(<TestSection controller={viewController(activating).controller} />);

    const receipt = screen.getByTestId("admin-mcp-activation-progress");
    expect(within(receipt).getByRole("heading", { name: "Activating MCP" })).toBeInTheDocument();
    expect(within(receipt).getByText("Discovering tools")).toBeInTheDocument();
    expect(within(receipt).getByText("Step 3 of 4")).toBeInTheDocument();
    const catalogRow = screen.getByRole("listitem");
    expect(within(catalogRow).getByText("Disabled")).toBeInTheDocument();
    expect(catalogRow).toHaveAttribute("data-resource-availability-row", "disabled");
    expect(screen.queryByRole("button", { name: "Activate tested revision" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Validate draft" })).not.toBeInTheDocument();
  });

  it("uses the OCI stage sequence without a package-resolution step", () => {
    const oci: AdminMcpServer = {
      ...server,
      activeRevision: null,
      activation: {
        completedAt: null,
        errorCode: null,
        id: "attempt-oci",
        issues: [],
        requestedAt: "2026-07-22T01:00:00.000Z",
        stage: "preparing_runtime",
        startedAt: "2026-07-22T01:00:01.000Z",
        updatedAt: "2026-07-22T01:00:02.000Z"
      },
      draft: {
        ...server.draft,
        source: { args: [], image: "ghcr.io/example/mcp:1", kind: "oci" }
      }
    };
    render(<TestSection controller={viewController(oci).controller} />);

    const receipt = screen.getByTestId("admin-mcp-activation-progress");
    expect(within(receipt).getByText("Preparing runtime")).toBeInTheDocument();
    expect(within(receipt).getByText("Step 2 of 5")).toBeInTheDocument();
  });

  it("keeps a failed activation receipt actionable through the existing retry", () => {
    const failed: AdminMcpServer = {
      ...server,
      activation: {
        completedAt: "2026-07-22T01:00:03.000Z",
        errorCode: "mcp_draft_test_failed",
        id: "attempt-1",
        issues: [{ code: "remote_unavailable", path: "source.url" }],
        requestedAt: "2026-07-22T01:00:00.000Z",
        stage: "failed",
        startedAt: "2026-07-22T01:00:01.000Z",
        updatedAt: "2026-07-22T01:00:03.000Z"
      }
    };
    const view = viewController(failed);
    render(<TestSection controller={view.controller} />);

    const receipt = screen.getByTestId("admin-mcp-activation-failed");
    expect(within(receipt).getByText(/source.url: remote_unavailable/i)).toBeInTheDocument();
    fireEvent.click(within(receipt).getByRole("button", { name: "Retry activation" }));
    expect(view.actions.activate).toHaveBeenCalledWith("server-1");
  });

  it("distinguishes missing revision artifacts and requires explicit draft replacement to rebuild", async () => {
    const missingRevision = {
      ...server.activeRevision!,
      artifactStatus: "missing" as const,
      id: "revision-missing",
      revisionNumber: 2
    };
    const revisionServer = {
      ...server,
      revisions: [server.activeRevision!, missingRevision]
    };
    const view = viewController(revisionServer);
    render(<TestSection controller={view.controller} />);

    fireEvent.click(screen.getByRole("button", { name: /Revisions Rollback and rebuild/i }));
    const missingRow = screen.getByText("Revision 2").closest("section");
    expect(missingRow).not.toBeNull();
    expect(within(missingRow!).getByRole("button", { name: "Roll back" })).toBeDisabled();
    expect(within(missingRow!).getByText("Artifact missing")).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText("Test workspace"), { target: { value: "rebuild-only" } });
    fireEvent.click(within(missingRow!).getByRole("button", { name: "Rebuild" }));
    fireEvent.click(within(missingRow!).getByRole("button", { name: /Replace draft, rebuild, and activate/i }));

    await waitFor(() => expect(view.actions.rebuild).toHaveBeenCalledWith("server-1", {
      oneTimeValues: { workspace_key: "rebuild-only" },
      replaceDraft: true,
      revisionId: "revision-missing"
    }));
    expect(screen.getByLabelText("Test workspace")).toHaveValue("");
  });

  it("keeps legacy archived MCP records read-only", () => {
    const archived = { ...server, archivedAt: "2026-07-24T00:00:00.000Z", enabled: false };
    render(<TestSection controller={viewController(archived).controller} />);

    expect(screen.getByText("Legacy archived")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /Definition Source, auth, and fields/i }));
    expect(screen.getByRole("button", { name: "Edit draft" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: /Validate & tools/i }));
    expect(screen.getByRole("checkbox", { name: "Enabled for remember" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: /Delete Irreversible removal/i }));
    expect(screen.getByText(/Legacy archived records are read-only/i)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Delete…" })).not.toBeInTheDocument();
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

  it("uses one compact catalog or detail with persistent horizontal server tasks", () => {
    const view = viewController();
    render(<TestSection controller={view.controller} />);

    expect(screen.getByTestId("mcp-catalog-view")).toHaveClass("block");
    expect(screen.getByTestId("mcp-detail-view")).toHaveClass("hidden");

    fireEvent.click(screen.getByRole("listitem"));
    expect(screen.getByTestId("mcp-catalog-view")).toHaveClass("hidden");
    expect(screen.getByTestId("mcp-detail-view")).toHaveClass("block");
    expect(screen.queryByTestId("mcp-server-task-index")).not.toBeInTheDocument();
    const taskNavigation = screen.getByRole("navigation", { name: "MCP server tasks" });
    expect(within(taskNavigation).getAllByRole("button")).toHaveLength(6);
    expect(within(taskNavigation).getByRole("button", { name: /Overview Publication and trust/i })).toHaveAttribute(
      "aria-current",
      "page"
    );

    fireEvent.click(within(taskNavigation).getByRole("button", { name: /Validate & tools/i }));
    expect(within(taskNavigation).getByRole("button", { name: /Validate & tools/i })).toHaveAttribute(
      "aria-current",
      "page"
    );
    expect(screen.getByRole("heading", { name: "Validate & tools" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Back to server tasks" })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Back to MCP servers" }));
    expect(screen.getByTestId("mcp-catalog-view")).toHaveClass("block");
  });

  it("returns to the compact catalog when refresh or deletion removes the selected server", async () => {
    const view = viewController();
    const { rerender } = render(<TestSection controller={view.controller} />);

    fireEvent.click(screen.getByRole("listitem"));
    expect(screen.getByTestId("mcp-catalog-view")).toHaveClass("hidden");
    expect(screen.getByTestId("mcp-detail-view")).toHaveClass("block");

    const removedController = {
      ...view.controller,
      state: {
        ...view.controller.state,
        selectedServer: null,
        servers: []
      }
    } as AdminMcpController;
    rerender(<TestSection controller={removedController} />);

    await waitFor(() => expect(screen.getByTestId("mcp-catalog-view")).toHaveClass("block"));
    expect(screen.getByTestId("mcp-detail-view")).toHaveClass("hidden");
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
