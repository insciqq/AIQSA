import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type {
  AdminProviderConnection,
  AdminProviderModel
} from "@/lib/contracts/adminProviders";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AdminProvidersSection } from "./AdminProvidersSection";

const mocks = vi.hoisted(() => ({
  useController: vi.fn()
}));

vi.mock("./useAdminProvidersController", () => ({
  useAdminProvidersController: mocks.useController
}));

vi.mock("./AdminRunProfilesPanel", () => ({
  AdminRunProfilesPanel: () => null
}));

const connection: AdminProviderConnection = {
  activatedAt: null,
  activeChecks: [],
  activeConfig: null,
  activeVersion: 0,
  assignments: [],
  createdAt: "2026-07-23T00:00:00.000Z",
  credentials: [{
    activatedAt: null,
    activeVersion: null,
    createdAt: "2026-07-23T00:00:00.000Z",
    draftSecretConfigured: true,
    draftVersion: 1,
    enabled: true,
    id: "credential-1",
    label: "Primary",
    testedAt: null,
    updatedAt: "2026-07-23T00:00:00.000Z"
  }],
  defaultCredentialId: "credential-1",
  displayName: "OpenRouter",
  draftChecks: [],
  draftConfig: {
    allowPrivateNetwork: false,
    apiRoot: "https://openrouter.ai/api/v1"
  },
  draftVersion: 1,
  enabled: false,
  family: "openrouter",
  id: "connection-1",
  models: [],
  unassignedPolicy: "use_default",
  updatedAt: "2026-07-23T00:00:00.000Z"
};

function providerModel(
  overrides: Partial<AdminProviderModel> = {}
): AdminProviderModel {
  const configuration = {
    adapterKind: "openrouter_chat_completions" as const,
    capabilities: {
      nativePdfInput: false,
      nativeSearch: false,
      pdf: false,
      reasoning: false,
      vision: false
    },
    defaultParams: {},
    openRouterRouting: { mode: "automatic" as const, providers: [] as [] },
    upstreamModelId: "vendor/model"
  };
  return {
    activatedAt: null,
    activeConfig: null,
    activeVersion: 0,
    connectionId: connection.id,
    createdAt: "2026-07-23T00:00:00.000Z",
    displayName: "Configured model",
    draftConfig: configuration,
    draftVersion: 1,
    enabled: true,
    id: "model-1",
    updatedAt: "2026-07-23T00:00:00.000Z",
    ...overrides
  };
}

function controller() {
  const actions = {
    connectionAction: vi.fn().mockResolvedValue(true),
    createConnection: vi.fn().mockResolvedValue(true),
    createCredential: vi.fn().mockResolvedValue(true),
    createModel: vi.fn().mockResolvedValue(true),
    deleteConnection: vi.fn().mockResolvedValue(true),
    deleteCredential: vi.fn().mockResolvedValue(true),
    deleteModel: vi.fn().mockResolvedValue(true),
    discoverEndpoints: vi.fn().mockResolvedValue([{
      name: "Provider A endpoint",
      providerName: "Provider A",
      supportedParameters: ["tools"],
      tag: "provider-a"
    }]),
    discoverModels: vi.fn().mockResolvedValue([{
      contextLength: 128_000,
      id: "vendor/fetched-model",
      inputModalities: ["text", "image"],
      name: "Fetched Model",
      outputModalities: ["text"],
      pricing: {},
      supportedParameters: ["tools", "reasoning"]
    }]),
    dismissError: vi.fn(),
    dismissNotice: vi.fn(),
    refresh: vi.fn().mockResolvedValue(true),
    refreshActive: vi.fn().mockResolvedValue(true),
    select: vi.fn(),
    testCredential: vi.fn().mockResolvedValue(true),
    testDraft: vi.fn().mockResolvedValue(true),
    updateConnection: vi.fn().mockResolvedValue(true),
    updateCredential: vi.fn().mockResolvedValue(true),
    updateModel: vi.fn().mockResolvedValue(true)
  };
  const state: {
    busy: boolean;
    connections: AdminProviderConnection[];
    error: string | null;
    errorBlockers: Array<{ count: number; kind: string }>;
    errorCode: string | null;
    feedbackConnectionId: string | null;
    loaded: boolean;
    loading: boolean;
    notice: string | null;
    selectedConnection: AdminProviderConnection | null;
  } = {
    busy: false,
    connections: [connection],
    error: null,
    errorBlockers: [],
    errorCode: null,
    feedbackConnectionId: null,
    loaded: true,
    loading: false,
    notice: null,
    selectedConnection: connection
  };
  return { actions, state };
}

function openTask(name: "Authentication" | "Credentials" | "Diagnostics" | "Models") {
  fireEvent.click(screen.getByRole("tab", { name }));
}

describe("AdminProvidersSection", () => {
  beforeEach(() => {
    mocks.useController.mockReset();
  });

  it("keeps administrator keys write-only in a password field and clears the submitted value", async () => {
    const view = controller();
    mocks.useController.mockReturnValue(view);
    render(<AdminProvidersSection active groups={[]} />);

    openTask("Credentials");

    const addKey = screen.getByRole("button", { name: "Add key" });
    expect(addKey).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByLabelText("API key")).not.toBeInTheDocument();
    fireEvent.click(addKey);

    const keyInput = screen.getByLabelText("API key");
    expect(keyInput).toHaveAttribute("type", "password");
    fireEvent.change(keyInput, { target: { value: "sk-admin-secret" } });
    expect(screen.getByRole("button", { name: "Save key" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "Test new key" }));
    await waitFor(() => expect(view.actions.testCredential).toHaveBeenCalledWith(
      "connection-1",
      {
        expectedConnectionDraftVersion: 1,
        secret: "sk-admin-secret"
      }
    ));
    await waitFor(() => expect(screen.getByRole("button", { name: "Save key" })).toBeEnabled());
    fireEvent.click(screen.getByRole("button", { name: "Save key" }));

    await waitFor(() => expect(view.actions.createCredential).toHaveBeenCalledWith(
      "connection-1",
      { label: "Primary", secret: "sk-admin-secret" }
    ));
    await waitFor(() => expect(screen.queryByLabelText("API key")).not.toBeInTheDocument());
    fireEvent.click(screen.getByRole("button", { name: "Add key" }));
    expect(screen.getByLabelText("API key")).toHaveValue("");
    expect(screen.queryByText("sk-admin-secret")).not.toBeInTheDocument();
  });

  it("does not accept a late key-test result for a changed input", async () => {
    let finishTest!: (value: boolean) => void;
    const view = controller();
    view.actions.testCredential = vi.fn(() => new Promise<boolean>((resolve) => {
      finishTest = resolve;
    }));
    mocks.useController.mockReturnValue(view);
    render(<AdminProvidersSection active groups={[]} />);

    openTask("Credentials");
    fireEvent.click(screen.getByRole("button", { name: "Add key" }));
    const keyInput = screen.getByLabelText("API key");
    fireEvent.change(keyInput, { target: { value: "first-key" } });
    fireEvent.click(screen.getByRole("button", { name: "Test new key" }));
    fireEvent.change(keyInput, { target: { value: "changed-key" } });
    finishTest(true);

    await waitFor(() => expect(view.actions.testCredential).toHaveBeenCalledOnce());
    expect(screen.getByRole("button", { name: "Save key" })).toBeDisabled();
  });

  it("clears an unsaved write-only key when its form closes", async () => {
    const view = controller();
    mocks.useController.mockReturnValue(view);
    render(<AdminProvidersSection active groups={[]} />);

    openTask("Credentials");
    fireEvent.click(screen.getByRole("button", { name: "Add key" }));
    fireEvent.change(screen.getByLabelText("API key"), {
      target: { value: "unsaved-secret" }
    });
    fireEvent.click(screen.getByRole("button", { name: "Test new key" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Save key" })).toBeEnabled());

    fireEvent.click(screen.getByRole("button", { name: "Close key form" }));
    fireEvent.click(screen.getByRole("button", { name: "Add key" }));

    expect(screen.getByLabelText("API key")).toHaveValue("");
    expect(screen.getByRole("button", { name: "Save key" })).toBeDisabled();
  });

  it("keeps focused task drafts mounted while switching Advanced peer views", () => {
    const view = controller();
    mocks.useController.mockReturnValue(view);
    render(<AdminProvidersSection active groups={[]} />);

    openTask("Credentials");
    fireEvent.click(screen.getByRole("button", { name: "Add key" }));
    fireEvent.change(screen.getByLabelText("API key"), {
      target: { value: "still-local" }
    });
    fireEvent.click(screen.getByRole("tab", { name: "Run profiles" }));
    fireEvent.click(screen.getByRole("tab", { name: "Connections" }));

    expect(screen.getByLabelText("API key")).toHaveValue("still-local");
  });

  it("opens the model editor from the contextual readiness action", async () => {
    const view = controller();
    mocks.useController.mockReturnValue(view);
    render(<AdminProvidersSection active groups={[]} />);

    const addModelActions = screen.getAllByRole("button", { name: "Add model" });
    expect(addModelActions).toHaveLength(2);
    expect(addModelActions[1]).toHaveAttribute("aria-expanded", "false");

    fireEvent.click(addModelActions[0]!);

    await waitFor(() => expect(addModelActions[1]).toHaveAttribute(
      "aria-expanded",
      "true"
    ));
    expect(screen.getByRole("heading", { name: "Add model" })).toBeInTheDocument();
  });

  it("keeps compact list/detail navigation independent from the selected connection", () => {
    const secondConnection: AdminProviderConnection = {
      ...connection,
      displayName: "OpenRouter backup",
      id: "connection-2"
    };
    const view = controller();
    view.state.connections = [connection, secondConnection];
    mocks.useController.mockReturnValue(view);
    render(<AdminProvidersSection active groups={[]} />);

    const index = screen.getByTestId("provider-connection-index");
    const detail = screen.getByTestId("provider-connection-task-detail");
    expect(index).toHaveClass("block");
    expect(detail).toHaveClass("hidden");
    fireEvent.click(within(index).getByRole("button", {
      name: /OpenRouter backup/
    }));

    expect(view.actions.select).toHaveBeenCalledWith(secondConnection.id);
    expect(index).toHaveClass("hidden");
    expect(detail).toHaveClass("block");
    fireEvent.click(screen.getByRole("button", { name: "Back to connections" }));
    expect(index).toHaveClass("block");
    expect(detail).toHaveClass("hidden");
  });

  it("does not expose an activation override on a different connection", () => {
    const secondConnection: AdminProviderConnection = {
      ...connection,
      displayName: "OpenRouter backup",
      id: "connection-2"
    };
    const baseView = controller();
    const view = {
      ...baseView,
      state: {
        ...baseView.state,
        connections: [connection, secondConnection],
        error: "Confirmation required.",
        errorCode: "provider_activation_unavailable_confirmation_required",
        feedbackConnectionId: connection.id,
        selectedConnection: secondConnection
      }
    };
    mocks.useController.mockReturnValue(view);
    render(<AdminProvidersSection active groups={[]} />);

    expect(screen.queryByRole("button", { name: "Review override" })).not.toBeInTheDocument();
    expect(screen.queryByText("Confirmation required.")).not.toBeInTheDocument();
  });

  it("submits only a currently usable credential after assignment options refresh", () => {
    const group = {
      accessGrants: [],
      archivedAt: null,
      id: "group-1",
      name: "Researchers",
      userCount: 4
    };
    const view = controller();
    mocks.useController.mockReturnValue(view);
    const rendered = render(<AdminProvidersSection active groups={[group]} />);

    const refreshedConnection: AdminProviderConnection = {
      ...connection,
      credentials: [
        { ...connection.credentials[0]!, enabled: false },
        {
          ...connection.credentials[0]!,
          id: "credential-2",
          label: "Backup"
        }
      ],
      defaultCredentialId: "credential-2"
    };
    view.state.connections = [refreshedConnection];
    view.state.selectedConnection = refreshedConnection;
    rendered.rerender(<AdminProvidersSection active groups={[group]} />);

    openTask("Authentication");
    fireEvent.click(screen.getByRole("button", { name: "Assign" }));

    expect(view.actions.connectionAction).toHaveBeenCalledWith(
      connection.id,
      {
        action: "assign_group_credential",
        credentialId: "credential-2",
        groupId: group.id
      },
      expect.stringContaining("does not grant model access")
    );
  });

  it("keeps the connection edit optimistic lock at its opening draft version", () => {
    const view = controller();
    view.actions.updateConnection = vi.fn(() => new Promise(() => undefined));
    mocks.useController.mockReturnValue(view);
    const rendered = render(<AdminProvidersSection active groups={[]} />);

    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    const refreshedConnection: AdminProviderConnection = {
      ...connection,
      draftVersion: 2,
      unassignedPolicy: "require_assignment"
    };
    view.state.connections = [refreshedConnection];
    view.state.selectedConnection = refreshedConnection;
    rendered.rerender(<AdminProvidersSection active groups={[]} />);
    fireEvent.change(screen.getByLabelText("Display name"), {
      target: { value: "Edited OpenRouter" }
    });
    fireEvent.click(screen.getByRole("button", { name: "Save connection" }));

    expect(view.actions.updateConnection).toHaveBeenCalledWith(
      connection.id,
      expect.objectContaining({
        displayName: "Edited OpenRouter",
        expectedDraftVersion: 1,
        unassignedPolicy: "use_default"
      })
    );
  });

  it("keeps credential rotation fenced to the version opened by the administrator", async () => {
    const view = controller();
    view.actions.updateCredential = vi.fn(() => new Promise(() => undefined));
    mocks.useController.mockReturnValue(view);
    const rendered = render(<AdminProvidersSection active groups={[]} />);

    openTask("Credentials");
    fireEvent.click(screen.getByRole("button", {
      name: "Rotate Primary credential"
    }));
    fireEvent.change(screen.getByPlaceholderText("Replacement API key"), {
      target: { value: "replacement-secret" }
    });
    fireEvent.click(screen.getByRole("button", { name: "Test replacement" }));
    await waitFor(() => expect(screen.getByRole("button", {
      name: "Save replacement"
    })).toBeEnabled());

    const refreshedConnection: AdminProviderConnection = {
      ...connection,
      credentials: [{
        ...connection.credentials[0]!,
        draftVersion: 2
      }]
    };
    view.state.connections = [refreshedConnection];
    view.state.selectedConnection = refreshedConnection;
    rendered.rerender(<AdminProvidersSection active groups={[]} />);
    fireEvent.click(screen.getByRole("button", { name: "Save replacement" }));

    expect(view.actions.updateCredential).toHaveBeenCalledWith(
      connection.id,
      "credential-1",
      {
        action: "rotate",
        expectedDraftVersion: 1,
        secret: "replacement-secret"
      },
      expect.stringContaining("replacement key draft saved")
    );
  });

  it("supports the OpenRouter key to model to ordered provider draft flow", async () => {
    const view = controller();
    view.actions.discoverEndpoints.mockResolvedValue([
      {
        name: "Provider A endpoint",
        providerName: "Shared provider",
        supportedParameters: ["tools"],
        tag: "provider-a"
      },
      {
        name: "Provider B endpoint",
        providerName: "Shared provider",
        supportedParameters: ["tools"],
        tag: "provider-b"
      }
    ]);
    mocks.useController.mockReturnValue(view);
    render(<AdminProvidersSection active groups={[]} />);

    openTask("Models");
    const modelsRegion = screen.getByTestId("provider-task-models");
    fireEvent.click(within(modelsRegion).getByRole("button", { name: "Add model" }));
    await waitFor(() => expect(view.actions.discoverModels).toHaveBeenCalledWith(
      "connection-1",
      "credential-1"
    ));

    fireEvent.click(screen.getByRole("button", { name: "OpenRouter model" }));
    const catalogSearch = await screen.findByRole("combobox", { name: "Search models" });
    fireEvent.change(catalogSearch, { target: { value: "vendor fetched" } });
    expect(screen.getByText("1 of 1 model")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("option", { name: /Fetched Model/ }));

    expect(screen.getByRole("textbox", { name: /Deployment name/ })).toHaveValue("Fetched Model");
    const advanced = screen.getByText("Advanced model settings").closest("details");
    expect(advanced).not.toHaveAttribute("open");
    fireEvent.click(screen.getByRole("radio", { name: /Only selected providers/ }));
    await waitFor(() => expect(view.actions.discoverEndpoints).toHaveBeenCalledWith(
      "connection-1",
      "credential-1",
      "vendor/fetched-model"
    ));

    const routeSearch = await screen.findByRole("searchbox", {
      name: "Search downstream providers"
    });
    fireEvent.change(routeSearch, { target: { value: "provider-b" } });
    fireEvent.click(screen.getByRole("button", {
      name: "Add route Shared provider (provider-b)"
    }));
    fireEvent.change(routeSearch, { target: { value: "provider-a" } });
    fireEvent.click(screen.getByRole("button", {
      name: "Add route Shared provider (provider-a)"
    }));
    fireEvent.click(screen.getByRole("button", { name: "Move provider-a up" }));
    const selectedRoute = screen.getByRole("list", {
      name: "Selected provider route priority"
    });
    expect(within(selectedRoute).getAllByRole("listitem").map((item) => item.textContent)).toEqual([
      expect.stringContaining("provider-a"),
      expect.stringContaining("provider-b")
    ]);
    fireEvent.click(screen.getByRole("button", { name: "Save model" }));

    await waitFor(() => expect(view.actions.createModel).toHaveBeenCalledWith(
      "connection-1",
      expect.objectContaining({
        configuration: expect.objectContaining({
          adapterKind: "openrouter_chat_completions",
          openRouterRouting: {
            mode: "only_selected",
            providers: ["provider-a", "provider-b"]
          },
          upstreamModelId: "vendor/fetched-model"
        }),
        displayName: "Fetched Model"
      })
    ));
  });

  it("keeps model actions outside the list clip and leaves the upstream id in Advanced only", () => {
    const view = controller();
    const configuredConnection: AdminProviderConnection = {
      ...connection,
      models: [providerModel()]
    };
    view.state.connections = [configuredConnection];
    view.state.selectedConnection = configuredConnection;
    mocks.useController.mockReturnValue(view);

    render(<AdminProvidersSection active groups={[]} />);

    openTask("Models");
    const models = screen.getByRole("list", { name: "Configured models" });
    expect(models).not.toHaveClass("overflow-hidden");
    fireEvent.click(within(models).getByLabelText("More actions for Configured model model"));
    expect(within(models).getByRole("button", { name: "Delete Configured model model" })).toBeVisible();
    expect(within(models).queryByText("vendor/model", { exact: true })).not.toBeInTheDocument();
  });

  it("routes destructive provider actions through the host confirmation port", async () => {
    const view = controller();
    const configuredConnection: AdminProviderConnection = {
      ...connection,
      models: [providerModel()]
    };
    view.state.connections = [configuredConnection];
    view.state.selectedConnection = configuredConnection;
    const requestConfirmation = vi.fn();
    mocks.useController.mockReturnValue(view);
    render(
      <AdminProvidersSection
        active
        groups={[]}
        requestConfirmation={requestConfirmation}
      />
    );

    openTask("Models");
    fireEvent.click(screen.getByLabelText("More actions for Configured model model"));
    fireEvent.click(screen.getByRole("button", { name: "Delete Configured model model" }));

    expect(requestConfirmation).toHaveBeenCalledWith(expect.objectContaining({
      testId: "admin-confirm-delete-provider-model",
      title: "Delete “Configured model”?"
    }));
    await requestConfirmation.mock.calls[0]![0].onConfirm();
    expect(view.actions.deleteModel).toHaveBeenCalledWith("connection-1", "model-1");
  });

  it("keeps group key assignment separate and exposes activation once locally ready", async () => {
    const view = controller();
    const readyConnection: AdminProviderConnection = {
      ...connection,
      models: [providerModel()]
    };
    view.state.connections = [readyConnection];
    view.state.selectedConnection = readyConnection;
    mocks.useController.mockReturnValue(view);
    render(<AdminProvidersSection active groups={[{
      accessGrants: [],
      archivedAt: null,
      id: "group-1",
      name: "Researchers",
      userCount: 4
    }]} />);

    openTask("Authentication");
    fireEvent.click(screen.getByRole("button", { name: "Assign" }));
    await waitFor(() => expect(view.actions.connectionAction).toHaveBeenCalledWith(
      "connection-1",
      {
        action: "assign_group_credential",
        credentialId: "credential-1",
        groupId: "group-1"
      },
      expect.stringContaining("does not grant model access")
    ));
    fireEvent.click(screen.getByRole("button", { name: "Activate and enable" }));
    expect(view.actions.connectionAction).toHaveBeenCalledWith(
      "connection-1",
      { action: "activate", confirmUnavailable: false, enableConnection: true },
      expect.stringContaining("activated")
    );
  });

  it("separates runtime and publication state and makes readiness blockers actionable", () => {
    const pendingConnection: AdminProviderConnection = {
      ...connection,
      activeConfig: connection.draftConfig,
      activeVersion: 1,
      draftVersion: 2,
      enabled: false,
      models: [providerModel({
        activatedAt: "2026-07-23T00:00:00.000Z",
        activeConfig: providerModel().draftConfig,
        activeVersion: 1
      })]
    };
    const view = controller();
    view.state.connections = [pendingConnection];
    view.state.selectedConnection = pendingConnection;
    mocks.useController.mockReturnValue(view);

    const rendered = render(<AdminProvidersSection active groups={[]} />);

    const connectionHeading = screen.getByRole("heading", {
      level: 2,
      name: "OpenRouter"
    });
    const header = connectionHeading.parentElement;
    expect(header).not.toBeNull();
    expect(within(header!).getByText("Disabled")).toBeInTheDocument();
    expect(within(header!).getByText("Changes pending")).toBeInTheDocument();
    expect(screen.getByText("Ready to activate.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Activate changes and enable" })).toBeInTheDocument();

    const blockedView = controller();
    mocks.useController.mockReturnValue(blockedView);
    rendered.rerender(<AdminProvidersSection active groups={[]} />);
    expect(screen.getAllByText("Add and enable at least one model.").length).toBeGreaterThan(0);
    expect(screen.getByRole("button", { name: "Add model" })).toBeInTheDocument();
  });

  it("labels a revoked credential version instead of presenting it as a usable draft", () => {
    const revokedConnection: AdminProviderConnection = {
      ...connection,
      credentials: [{
        ...connection.credentials[0]!,
        activeVersion: {
          activatedAt: "2026-07-23T00:00:00.000Z",
          id: "version-revoked",
          revokedAt: "2026-07-23T01:00:00.000Z",
          testedAt: "2026-07-23T00:00:00.000Z",
          version: 1
        },
        draftSecretConfigured: false
      }]
    };
    const view = controller();
    view.state.connections = [revokedConnection];
    view.state.selectedConnection = revokedConnection;
    mocks.useController.mockReturnValue(view);

    render(<AdminProvidersSection active groups={[]} />);

    openTask("Credentials");
    expect(screen.getByText("Revoked")).toBeInTheDocument();
    expect(screen.getByText("Key version 1 was revoked.")).toBeInTheDocument();
    expect(screen.queryByRole("button", {
      name: "Revoke Primary active key"
    })).not.toBeInTheDocument();
  });

  it("keeps model testing optional instead of rendering a required credential matrix", () => {
    const activeModel = {
      activatedAt: "2026-07-23T00:00:00.000Z",
      activeConfig: {
        adapterKind: "openrouter_chat_completions" as const,
        capabilities: {
          nativePdfInput: false,
          nativeSearch: false,
          pdf: false,
          reasoning: false,
          vision: false
        },
        defaultParams: {},
        openRouterRouting: { mode: "automatic" as const, providers: [] as [] },
        upstreamModelId: "vendor/model"
      },
      activeVersion: 1,
      connectionId: "connection-1",
      createdAt: "2026-07-23T00:00:00.000Z",
      displayName: "Active Model",
      draftConfig: {
        adapterKind: "openrouter_chat_completions" as const,
        capabilities: {
          nativePdfInput: false,
          nativeSearch: false,
          pdf: false,
          reasoning: false,
          vision: false
        },
        defaultParams: {},
        openRouterRouting: { mode: "automatic" as const, providers: [] as [] },
        upstreamModelId: "vendor/model"
      },
      draftVersion: 1,
      enabled: true,
      id: "model-active",
      updatedAt: "2026-07-23T00:00:00.000Z"
    };
    const activeConnection: AdminProviderConnection = {
      ...connection,
      activeChecks: [{
        checkedAt: "2026-07-23T00:00:00.000Z",
        connectionVersion: 1,
        credentialId: "credential-1",
        credentialVersionId: "version-1",
        evidence: null,
        latestRefreshError: { code: "provider_refresh_failed", version: 1 },
        modelVersion: 1,
        providerModelId: "model-active",
        refreshFailedAt: "2026-07-23T00:05:00.000Z",
        status: "available"
      }],
      activeConfig: connection.draftConfig,
      activeVersion: 1,
      credentials: [{
        ...connection.credentials[0]!,
        activeVersion: {
          activatedAt: "2026-07-23T00:00:00.000Z",
          id: "version-1",
          revokedAt: null,
          testedAt: "2026-07-23T00:00:00.000Z",
          version: 1
        },
        draftSecretConfigured: false
      }],
      enabled: true,
      models: [activeModel]
    };
    const view = controller();
    view.state.connections = [activeConnection];
    view.state.selectedConnection = activeConnection;
    mocks.useController.mockReturnValue(view);
    render(<AdminProvidersSection active groups={[]} />);

    expect(screen.queryByText("Available · refresh needs attention")).not.toBeVisible();
    expect(screen.queryByRole("table")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Check model route" })).not.toBeInTheDocument();
    openTask("Diagnostics");
    expect(screen.getByText("Available · refresh needs attention")).toBeVisible();
    expect(screen.getByRole("button", { name: "Check model route" })).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Check model route" }));
    expect(view.actions.testDraft).toHaveBeenCalledWith(
      "connection-1",
      "model-active",
      {
        confirmPaidRequest: false,
        credentialId: "credential-1",
        mode: "account_catalog"
      }
    );
    fireEvent.click(screen.getByRole("button", { name: "Refresh active check" }));
    expect(view.actions.refreshActive).toHaveBeenCalledWith(
      "connection-1",
      "model-active",
      "credential-1",
      false
    );
  });

  it("renders a load failure as an error instead of an empty connection catalog", () => {
    const view = controller();
    view.state.connections = [];
    view.state.selectedConnection = null;
    view.state.error = "Provider catalog is unavailable.";
    mocks.useController.mockReturnValue(view);

    render(<AdminProvidersSection active groups={[]} />);

    expect(screen.getByRole("alert")).toHaveTextContent("Provider connections could not be loaded");
    expect(screen.queryByText("No provider connections")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Retry provider refresh" }));
    expect(view.actions.refresh).toHaveBeenCalledOnce();
  });

  it("prefills a new advanced connection from the Quick provider family", async () => {
    const view = controller();
    view.state.connections = [];
    view.state.selectedConnection = null;
    mocks.useController.mockReturnValue(view);

    render(<AdminProvidersSection active advancedEntryProvider="openai" groups={[]} />);

    expect(await screen.findByRole("heading", { name: "New provider connection" })).toBeInTheDocument();
    expect(screen.getByLabelText("Provider family")).toHaveValue("openai");
    expect(screen.getByRole("textbox", { name: /API root/ })).toHaveValue("https://api.openai.com/v1");
  });
});
