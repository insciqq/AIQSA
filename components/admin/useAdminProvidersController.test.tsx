import { act, renderHook, waitFor } from "@testing-library/react";
import type { AdminProviderConnection } from "@/lib/contracts/adminProviders";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useAdminProvidersController } from "./useAdminProvidersController";

const api = vi.hoisted(() => ({
  getConnections: vi.fn(),
  runConnectionAction: vi.fn()
}));

vi.mock("./adminProvidersApi", () => ({
  adminProviderErrorMessage: (error: { code: string }) => error.code,
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
      apiRoot: "https://openrouter.ai/api/v1"
    },
    draftVersion: 1,
    enabled: false,
    family: "openrouter",
    id,
    models: [],
    unassignedPolicy: "use_default",
    updatedAt: "2026-07-24T00:00:00.000Z"
  };
}

describe("useAdminProvidersController", () => {
  beforeEach(() => {
    api.getConnections.mockReset();
    api.runConnectionAction.mockReset();
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

    act(() => result.current.actions.select(second.id));
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

    expect(result.current.state.selectedConnection?.id).toBe(second.id);
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

    expect(result.current.state.selectedConnection?.displayName).toBe("Provider A updated");
    expect(result.current.state.notice).toBe("Group credential assignment saved.");
    await waitFor(() => expect(onMutationCommitted).toHaveBeenCalledOnce());
  });
});
