import { act, renderHook, waitFor } from "@testing-library/react";
import type { AdminProviderConnection } from "@/lib/contracts/adminProviders";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useAdminProvidersController } from "./useAdminProvidersController";

const api = vi.hoisted(() => ({
  createModel: vi.fn(),
  getConnections: vi.fn(),
  runConnectionAction: vi.fn()
}));

vi.mock("./adminProvidersApi", () => ({
  adminProviderErrorMessage: (error: { code: string }) => error.code,
  createAdminProviderModel: api.createModel,
  getAdminProviderConnections: api.getConnections,
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
    api.getConnections.mockReset();
    api.runConnectionAction.mockReset();
  });

  it("saves a model with Test & Save in one request and starts background checks without a toast", async () => {
    const original = connection("connection-a", "Provider A");
    api.getConnections.mockResolvedValue({ data: [original], ok: true });
    api.createModel.mockResolvedValue({ data: [original], ok: true });
    api.runConnectionAction.mockResolvedValue({ data: [{ ...original, displayName: "checking" }], ok: true });
    const onNotice = vi.fn();
    const { result } = renderHook(() => useAdminProvidersController(true, { onNotice }));
    await waitFor(() => expect(result.current.state.loaded).toBe(true));

    await act(async () => {
      await expect(result.current.actions.saveModel(original.id, null, { configuration: { upstreamModelId: "m" }, displayName: "M" }))
        .resolves.toEqual({ ok: true });
    });
    expect(api.createModel).toHaveBeenCalledWith(original.id, {
      activate: true,
      configuration: { upstreamModelId: "m" },
      displayName: "M"
    });
    expect(onNotice).toHaveBeenCalledWith("Model saved and turned on.");

    await act(async () => {
      await expect(result.current.actions.startModelChecks(original.id, "credential-1", ["model-1"]))
        .resolves.toEqual({ ok: true });
    });
    expect(api.runConnectionAction).toHaveBeenCalledWith(original.id, {
      action: "check_models",
      credentialId: "credential-1",
      modelIds: ["model-1"]
    });
    expect(onNotice).toHaveBeenCalledOnce();
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
