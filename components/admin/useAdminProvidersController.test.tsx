import { act, renderHook, waitFor } from "@testing-library/react";
import type { AdminProviderConnection } from "@/lib/contracts/adminProviders";
import { StrictMode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useAdminProvidersController } from "./useAdminProvidersController";
import { fixtureModel } from "./providers/providerFixtures";

const api = vi.hoisted(() => ({
  createModel: vi.fn(),
  discoverCompatibleModels: vi.fn(),
  getConnections: vi.fn(),
  renameModel: vi.fn(),
  runConnectionAction: vi.fn()
}));

vi.mock("./adminProvidersApi", () => ({
  adminProviderErrorMessage: (error: { code: string }) => error.code,
  createAdminProviderModel: api.createModel,
  discoverAdminCompatibleModels: api.discoverCompatibleModels,
  getAdminProviderConnections: api.getConnections,
  renameAdminProviderModel: api.renameModel,
  runAdminProviderConnectionAction: api.runConnectionAction
}));

function connection(id: string, displayName: string): AdminProviderConnection {
  return {
    activatedAt: null,
    activeChecks: [],
    activeConfig: null,
    activeVersion: 0,
    assignments: [],
    createdAt: "2026-07-24T00:00:00.000Z",
    credentials: [],
    defaultCredentialId: null,
    displayName,
    draftChecks: [],
    draftConfig: {
      allowPrivateNetwork: false,
      apiRoot: "https://openrouter.ai/api/v1",
      authenticationMode: "bearer",
      responseTimeoutSeconds: 300
    },
    draftVersion: 1,
    enabled: false,
    family: "openrouter",
    id,
    models: [],
    unassignedPolicy: "use_default",
    updatedAt: "2026-07-24T00:00:00.000Z",
    userAssignments: []
  };
}

describe("useAdminProvidersController", () => {
  beforeEach(() => {
    api.createModel.mockReset();
    api.discoverCompatibleModels.mockReset();
    api.getConnections.mockReset();
    api.renameModel.mockReset();
    api.runConnectionAction.mockReset();
  });

  it("finishes its initial catalog load through StrictMode effect replay", async () => {
    const original = connection("connection-a", "Provider A");
    let finishLoad!: (value: { ok: true; data: AdminProviderConnection[] }) => void;
    api.getConnections.mockImplementation(() => new Promise((resolve) => { finishLoad = resolve; }));
    const { result } = renderHook(() => useAdminProvidersController(true), { wrapper: StrictMode });
    expect(result.current.state.loading).toBe(true);
    await act(async () => { finishLoad({ ok: true, data: [original] }); });
    expect(result.current.state.loaded).toBe(true);
    expect(result.current.state.loading).toBe(false);
    expect(result.current.state.connections).toEqual([original]);
    expect(api.getConnections).toHaveBeenCalledOnce();
  });

  it.each(["mutation", "refresh"] as const)("ignores a model save completing after actual unmount during %s", async (phase) => {
    const original = connection("connection-a", "Provider A");
    const model = fixtureModel({ connectionId: original.id, displayName: "Old name", id: "model-1" });
    original.models = [model];
    api.getConnections.mockResolvedValue({ ok: true, data: [original] });
    const receipt = { connectionId: original.id, modelId: model.id, displayName: "New name",
      draftVersion: 1, saved: "name", publication: "not_requested", checks: "not_requested" };
    let finish!: () => void;
    if (phase === "mutation") api.renameModel.mockImplementation(() => new Promise((resolve) => {
      finish = () => resolve({ ok: true, data: receipt });
    }));
    else api.renameModel.mockResolvedValue({ ok: true, data: receipt });
    const onMutationCommitted = vi.fn();
    const { result, unmount } = renderHook(() => useAdminProvidersController(true, { onMutationCommitted }), { wrapper: StrictMode });
    await waitFor(() => expect(result.current.state.loaded).toBe(true));
    if (phase === "refresh") api.getConnections.mockImplementation(() => new Promise((resolve) => {
      finish = () => resolve({ ok: true, data: [original] });
    }));
    let pending!: ReturnType<typeof result.current.actions.renameModel>;
    act(() => { pending = result.current.actions.renameModel(original.id, model.id, {
      displayName: "New name", expectedDisplayName: model.displayName, expectedActiveVersion: 1,
      expectedDraftVersion: 1, expectedUpdatedAt: model.updatedAt
    }); });
    await waitFor(() => expect(api.getConnections).toHaveBeenCalledTimes(phase === "refresh" ? 2 : 1));
    unmount();
    await act(async () => {
      finish();
      await expect(pending).resolves.toMatchObject({ ok: false, error: { code: "provider_admin_superseded" } });
    });
    expect(api.renameModel).toHaveBeenCalledOnce();
    expect(api.getConnections).toHaveBeenCalledTimes(phase === "refresh" ? 2 : 1);
    expect(onMutationCommitted).not.toHaveBeenCalled();
  });

  it.each([{ modelId: "other" }, { draftVersion: 99 }])("rejects a receipt with another identity or version: %j", async (patch) => {
    const original = connection("connection-a", "Provider A");
    const model = fixtureModel({ connectionId: original.id, displayName: "Old name", id: "model-1" });
    original.models = [model];
    api.getConnections.mockResolvedValue({ ok: true, data: [original] });
    api.renameModel.mockResolvedValue({ ok: true, data: { connectionId: original.id, modelId: model.id, displayName: "New name",
      draftVersion: 1, saved: "name", publication: "not_requested", checks: "not_requested", ...patch } });
    const { result } = renderHook(() => useAdminProvidersController(true));
    await waitFor(() => expect(result.current.state.loaded).toBe(true));
    await act(async () => {
      await expect(result.current.actions.renameModel(original.id, model.id, { displayName: "New name", expectedDisplayName: model.displayName,
        expectedActiveVersion: 1, expectedDraftVersion: 1, expectedUpdatedAt: model.updatedAt }))
        .resolves.toMatchObject({ ok: false, error: { code: "provider_admin_response_invalid" }, persistence: { model: null, receipt: null } });
    });
    expect(api.renameModel).toHaveBeenCalledOnce();
  });

  it("keeps a create without a returned model ID unknown even if the catalog contains an identical model", async () => {
    const original = connection("connection-a", "Provider A");
    const model = fixtureModel({ connectionId: original.id, displayName: "Created", id: "new-model" });
    api.getConnections.mockResolvedValueOnce({ ok: true, data: [original] })
      .mockResolvedValue({ ok: true, data: [{ ...original, models: [model] }] });
    api.createModel.mockResolvedValue({ ok: false, error: { blockers: [], code: "network_error", resourceIds: [] } });
    const { result } = renderHook(() => useAdminProvidersController(true));
    await waitFor(() => expect(result.current.state.loaded).toBe(true));
    await act(async () => {
      await expect(result.current.actions.saveModel(original.id, null, { displayName: model.displayName, configuration: model.draftConfig }))
        .resolves.toMatchObject({ ok: false, persistence: { model: null, receipt: null } });
    });
    expect(api.createModel).toHaveBeenCalledOnce();
    expect(api.runConnectionAction).not.toHaveBeenCalled();
  });

  it("publishes an acknowledged name-only save through the catalog without starting setup", async () => {
    const original = connection("connection-a", "Provider A");
    const model = fixtureModel({ connectionId: original.id, displayName: "Old name", id: "model-1", enabled: false });
    original.models = [model];
    const updated = { ...original, models: [{ ...model, displayName: "New name" }] };
    const body = { displayName: "New name", expectedActiveVersion: model.activeVersion,
      expectedDisplayName: model.displayName, expectedDraftVersion: model.draftVersion, expectedUpdatedAt: model.updatedAt };
    api.getConnections.mockResolvedValue({ ok: true, data: [original] });
    api.getConnections.mockResolvedValueOnce({ ok: true, data: [original] }).mockResolvedValue({ ok: true, data: [updated] });
    api.renameModel.mockResolvedValue({ ok: true, data: { connectionId: original.id, modelId: model.id, displayName: "New name",
      draftVersion: model.draftVersion, saved: "name", publication: "not_requested", checks: "not_requested" } });
    const onMutationCommitted = vi.fn();
    const { result } = renderHook(() => useAdminProvidersController(true, { onMutationCommitted }));
    await waitFor(() => expect(result.current.state.loaded).toBe(true));
    await act(async () => {
      await expect(result.current.actions.renameModel(original.id, model.id, body)).resolves.toMatchObject({ ok: true });
    });
    expect(api.renameModel).toHaveBeenCalledWith(original.id, model.id, body);
    expect(api.createModel).not.toHaveBeenCalled();
    expect(api.runConnectionAction).not.toHaveBeenCalled();
    expect(api.discoverCompatibleModels).not.toHaveBeenCalled();
    expect(result.current.state.connections).toEqual([updated]);
    expect(result.current.state.busy).toBe(false);
    await waitFor(() => expect(onMutationCommitted).toHaveBeenCalledOnce());
  });

  it("preserves the bounded ownership marker returned by compatible discovery", async () => {
    const original = connection("connection-a", "Provider A");
    api.getConnections.mockResolvedValue({ data: [original], ok: true });
    api.discoverCompatibleModels.mockResolvedValue({
      data: [{ capabilities: {}, id: "vendor/model", ownedBy: "codex-lb" }],
      ok: true
    });
    const { result } = renderHook(() => useAdminProvidersController(true));
    await waitFor(() => expect(result.current.state.loaded).toBe(true));

    await act(async () => {
      await expect(result.current.actions.discoverCompatibleModels(
        original.id,
        "credential-1"
      )).resolves.toEqual([{
        capabilities: {},
        id: "vendor/model",
        ownedBy: "codex-lb"
      }]);
    });
    expect(api.discoverCompatibleModels).toHaveBeenCalledWith(original.id, "credential-1");
  });

  it("saves a model with Test & Save in one request and starts background checks without a toast", async () => {
    const original = connection("connection-a", "Provider A");
    api.getConnections.mockResolvedValue({ data: [original], ok: true });
    api.createModel.mockResolvedValue({ data: { connectionId: original.id, modelId: "model-created", displayName: "M",
      draftVersion: 1, saved: "configuration", publication: "active", checks: "checked" }, ok: true });
    api.runConnectionAction.mockResolvedValue({ data: [{ ...original, displayName: "checking" }], ok: true });
    const onNotice = vi.fn();
    const { result } = renderHook(() => useAdminProvidersController(true, { onNotice }));
    await waitFor(() => expect(result.current.state.loaded).toBe(true));

    await act(async () => {
      await expect(result.current.actions.saveModel(original.id, null, { configuration: { upstreamModelId: "m" }, displayName: "M" }))
        .resolves.toMatchObject({ ok: true });
    });
    expect(api.createModel).toHaveBeenCalledWith(original.id, {
      activate: true,
      configuration: { upstreamModelId: "m" },
      displayName: "M"
    }, fetch, undefined, undefined);
    expect(onNotice).not.toHaveBeenCalled();

    await act(async () => {
      await expect(result.current.actions.startModelChecks(original.id, "credential-1", ["model-1"]))
        .resolves.toMatchObject({ ok: true });
    });
    expect(api.runConnectionAction).toHaveBeenCalledWith(original.id, {
      action: "check_models",
      credentialId: "credential-1",
      modelIds: ["model-1"]
    });
    expect(onNotice).not.toHaveBeenCalled();
    expect(result.current.state.connections[0]?.displayName).toBe("checking");
    expect(result.current.state.busy).toBe(false);
  });

  it("refreshes quietly without touching busy or loading and yields to a mutation in flight", async () => {
    const original = connection("connection-a", "Provider A");
    api.getConnections.mockResolvedValue({ data: [original], ok: true });
    const { result } = renderHook(() => useAdminProvidersController(true));
    await waitFor(() => expect(result.current.state.loaded).toBe(true));

    api.getConnections.mockResolvedValue({ data: [{ ...original, displayName: "polled" }], ok: true });
    await act(async () => {
      await expect(result.current.actions.refreshQuietly()).resolves.toBe(true);
    });
    expect(result.current.state.connections[0]?.displayName).toBe("polled");
    expect(result.current.state.loading).toBe(false);

    let finishAction!: (value: { data: AdminProviderConnection[]; ok: true }) => void;
    api.runConnectionAction.mockImplementation(() => new Promise((resolve) => { finishAction = resolve; }));
    let pending!: Promise<boolean>;
    act(() => {
      pending = result.current.actions.connectionAction(original.id, { action: "enable" }, "On.");
    });
    await waitFor(() => expect(result.current.state.busy).toBe(true));
    api.getConnections.mockResolvedValue({ data: [{ ...original, displayName: "late poll" }], ok: true });
    await act(async () => {
      await expect(result.current.actions.refreshQuietly()).resolves.toBe(false);
    });
    await act(async () => {
      finishAction({ data: [{ ...original, displayName: "mutated" }], ok: true });
      await pending;
    });
    expect(result.current.state.connections[0]?.displayName).toBe("mutated");
  });

  it("keeps a late activation override error scoped to the connection that produced it", async () => {
    const first = connection("connection-a", "Provider A");
    const second = connection("connection-b", "Provider B");
    let finishAction!: (value: {
      error: { blockers: never[]; code: string; resourceIds: never[] };
      ok: false;
    }) => void;
    api.getConnections.mockResolvedValue({ data: [first, second], ok: true });
    api.runConnectionAction.mockImplementation(() => new Promise((resolve) => {
      finishAction = resolve;
    }));

    const onMutationCommitted = vi.fn();
    const { result } = renderHook(() => useAdminProvidersController(true, { onMutationCommitted }));
    await waitFor(() => expect(result.current.state.loaded).toBe(true));

    let pending!: Promise<boolean>;
    act(() => {
      pending = result.current.actions.connectionAction(
        first.id,
        { action: "activate" },
        "Activated."
      );
    });
    await waitFor(() => expect(result.current.state.busy).toBe(true));

    await act(async () => {
      finishAction({
        error: {
          blockers: [],
          code: "provider_activation_unavailable_confirmation_required",
          resourceIds: []
        },
        ok: false
      });
      await pending;
    });

    expect(result.current.state.connections.map(({ id }) => id)).toEqual([first.id, second.id]);
    expect(result.current.state.errorCode).toBe(
      "provider_activation_unavailable_confirmation_required"
    );
    expect(result.current.state.feedbackConnectionId).toBe(first.id);
    expect(onMutationCommitted).not.toHaveBeenCalled();
  });

  it("notifies the dashboard after a successful catalog mutation without awaiting refresh", async () => {
    const original = connection("connection-a", "Provider A");
    const updated = { ...original, displayName: "Provider A updated" };
    const onMutationCommitted = vi.fn(() => new Promise<never>(() => undefined));
    api.getConnections.mockResolvedValue({ data: [original], ok: true });
    api.runConnectionAction.mockResolvedValue({ data: [updated], ok: true });

    const { result } = renderHook(() => useAdminProvidersController(true, { onMutationCommitted }));
    await waitFor(() => expect(result.current.state.loaded).toBe(true));

    await act(async () => {
      await expect(result.current.actions.connectionAction(
        original.id,
        { action: "assign_group_credential", credentialId: "credential-1", groupId: "group-1" },
        "Group credential assignment saved."
      )).resolves.toBe(true);
    });

    expect(result.current.state.connections[0]?.displayName).toBe("Provider A updated");
    expect(result.current.state.notice).toBe("Group credential assignment saved.");
    await waitFor(() => expect(onMutationCommitted).toHaveBeenCalledOnce());
  });

  it("preserves structured delete blockers for the replacement error presentation", async () => {
    api.getConnections.mockResolvedValue({
      error: {
        blockers: [{ count: 2, kind: "run_profiles" }],
        code: "provider_connection_delete_blocked",
        resourceIds: ["profile-fast", "profile-deep"]
      },
      ok: false
    });

    const { result } = renderHook(() => useAdminProvidersController(true));
    await waitFor(() => expect(result.current.state.loaded).toBe(true));

    expect(result.current.state.error).toBe("provider_connection_delete_blocked");
    expect(result.current.state.errorBlockers).toEqual([
      { count: 2, kind: "run_profiles" }
    ]);
  });
});
