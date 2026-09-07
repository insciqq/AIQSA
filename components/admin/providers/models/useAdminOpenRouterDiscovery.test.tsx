import { act, renderHook, waitFor } from "@testing-library/react";
import type {
  AdminOpenRouterDiscoveredEndpoint,
  AdminOpenRouterDiscoveredModel,
  AdminProviderCredential
} from "@/lib/contracts/adminProviders";
import { describe, expect, it, vi } from "vitest";
import {
  openRouterEndpointDiscoveryIdentity,
  openRouterModelDiscoveryIdentity,
  useAdminOpenRouterDiscovery,
  type OpenRouterModelDiscoveryIdentity
} from "./useAdminOpenRouterDiscovery";

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

function model(id: string): AdminOpenRouterDiscoveredModel {
  return {
    id,
    inputModalities: ["text"],
    name: id,
    outputModalities: ["text"],
    pricing: {},
    supportedParameters: []
  };
}

function endpoint(tag: string): AdminOpenRouterDiscoveredEndpoint {
  return {
    name: tag,
    providerName: tag,
    supportedParameters: [],
    tag
  };
}

function identity(
  version: OpenRouterModelDiscoveryIdentity["credentialVersion"] = {
    kind: "draft",
    version: 2
  }
): OpenRouterModelDiscoveryIdentity {
  return {
    connectionDraftVersion: 3,
    connectionId: "connection-1",
    credentialId: "credential-1",
    credentialVersion: version
  };
}

describe("useAdminOpenRouterDiscovery", () => {
  it("reuses a model catalog only for the same connection and credential-version identity", async () => {
    const first = deferred<AdminOpenRouterDiscoveredModel[] | null>();
    const loadModels = vi.fn().mockReturnValueOnce(first.promise)
      .mockResolvedValueOnce([model("vendor/model-2")]);
    const { result } = renderHook(() => useAdminOpenRouterDiscovery({
      loadEndpoints: vi.fn(),
      loadModels
    }));
    const draftIdentity = identity();

    expect(result.current.models.get(draftIdentity).status).toBe("idle");
    let firstResult!: Promise<ReadonlyArray<AdminOpenRouterDiscoveredModel> | null>;
    let reusedResult!: Promise<ReadonlyArray<AdminOpenRouterDiscoveredModel> | null>;
    act(() => {
      firstResult = result.current.models.load(draftIdentity);
      reusedResult = result.current.models.load({ ...draftIdentity });
    });
    expect(firstResult).toBe(reusedResult);
    expect(result.current.models.get(draftIdentity).status).toBe("loading");
    await waitFor(() => expect(loadModels).toHaveBeenCalledOnce());

    first.resolve([model("vendor/model-1")]);
    await act(async () => {
      await firstResult;
    });
    expect(loadModels).toHaveBeenCalledOnce();
    expect(result.current.models.get(draftIdentity)).toMatchObject({
      error: null,
      items: [{ id: "vendor/model-1" }],
      status: "success"
    });

    const rotatedIdentity = identity({ kind: "draft", version: 3 });
    await act(async () => {
      await result.current.models.load(rotatedIdentity);
    });
    expect(loadModels).toHaveBeenCalledTimes(2);
    expect(result.current.models.get(draftIdentity).items).toHaveLength(1);
  });

  it("exposes an empty result as a completed state instead of repeatedly loading it", async () => {
    const request = deferred<AdminOpenRouterDiscoveredModel[] | null>();
    const loadModels = vi.fn().mockReturnValue(request.promise);
    const { result } = renderHook(() => useAdminOpenRouterDiscovery({
      loadEndpoints: vi.fn(),
      loadModels
    }));
    const currentIdentity = identity();

    let promise!: Promise<ReadonlyArray<AdminOpenRouterDiscoveredModel> | null>;
    act(() => {
      promise = result.current.models.load(currentIdentity);
    });
    request.resolve([]);
    await act(async () => {
      await promise;
      await result.current.models.load(currentIdentity);
    });

    expect(loadModels).toHaveBeenCalledOnce();
    expect(result.current.models.get(currentIdentity)).toEqual({
      error: null,
      items: [],
      status: "empty"
    });
  });

  it("turns null into a safe error and retries the exact identity", async () => {
    const failed = deferred<AdminOpenRouterDiscoveredModel[] | null>();
    const recovered = deferred<AdminOpenRouterDiscoveredModel[] | null>();
    const loadModels = vi.fn()
      .mockReturnValueOnce(failed.promise)
      .mockReturnValueOnce(recovered.promise);
    const { result } = renderHook(() => useAdminOpenRouterDiscovery({
      loadEndpoints: vi.fn(),
      loadModels,
      modelErrorMessage: "The account catalog is unavailable."
    }));
    const currentIdentity = identity();

    let failedResult!: Promise<ReadonlyArray<AdminOpenRouterDiscoveredModel> | null>;
    act(() => {
      failedResult = result.current.models.load(currentIdentity);
    });
    failed.resolve(null);
    await act(async () => {
      await failedResult;
    });
    expect(result.current.models.get(currentIdentity)).toEqual({
      error: "The account catalog is unavailable.",
      items: [],
      status: "error"
    });

    let retryResult!: Promise<ReadonlyArray<AdminOpenRouterDiscoveredModel> | null>;
    act(() => {
      retryResult = result.current.models.retry(currentIdentity);
    });
    recovered.resolve([model("vendor/recovered")]);
    await act(async () => {
      await retryResult;
    });
    expect(loadModels).toHaveBeenCalledTimes(2);
    expect(result.current.models.get(currentIdentity)).toMatchObject({
      error: null,
      items: [{ id: "vendor/recovered" }],
      status: "success"
    });
  });

  it("suppresses a stale model response after a refresh wins", async () => {
    const first = deferred<AdminOpenRouterDiscoveredModel[] | null>();
    const refresh = deferred<AdminOpenRouterDiscoveredModel[] | null>();
    const loadModels = vi.fn()
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(refresh.promise);
    const { result } = renderHook(() => useAdminOpenRouterDiscovery({
      loadEndpoints: vi.fn(),
      loadModels
    }));
    const currentIdentity = identity();

    let firstResult!: Promise<ReadonlyArray<AdminOpenRouterDiscoveredModel> | null>;
    let refreshResult!: Promise<ReadonlyArray<AdminOpenRouterDiscoveredModel> | null>;
    act(() => {
      firstResult = result.current.models.load(currentIdentity);
      refreshResult = result.current.models.refresh(currentIdentity);
    });
    await waitFor(() => expect(loadModels).toHaveBeenCalledTimes(2));

    refresh.resolve([model("vendor/new")]);
    await act(async () => {
      await refreshResult;
    });
    first.resolve([model("vendor/stale")]);
    await expect(firstResult).resolves.toBeNull();

    expect(result.current.models.get(currentIdentity)).toMatchObject({
      items: [{ id: "vendor/new" }],
      status: "success"
    });
  });

  it("caches endpoints independently for each model and credential source", async () => {
    const loadEndpoints = vi.fn((
      _connectionId: string,
      _credentialId: string,
      modelId: string
    ) => Promise.resolve([endpoint(`${modelId}-route`)]));
    const { result } = renderHook(() => useAdminOpenRouterDiscovery({
      loadEndpoints,
      loadModels: vi.fn()
    }));
    const modelAIdentity = openRouterEndpointDiscoveryIdentity(identity(), "vendor/model-a")!;
    const modelBIdentity = openRouterEndpointDiscoveryIdentity(identity(), "vendor/model-b")!;
    const activeModelAIdentity = openRouterEndpointDiscoveryIdentity(identity({
      kind: "active",
      version: 2,
      versionId: "active-2"
    }), "vendor/model-a")!;

    await act(async () => {
      await result.current.endpoints.load(modelAIdentity);
      await result.current.endpoints.load({ ...modelAIdentity });
      await result.current.endpoints.load(modelBIdentity);
      await result.current.endpoints.load(activeModelAIdentity);
    });

    expect(loadEndpoints).toHaveBeenCalledTimes(3);
    expect(result.current.endpoints.get(modelAIdentity).items[0]?.tag)
      .toBe("vendor/model-a-route");
    expect(result.current.endpoints.get(modelBIdentity).items[0]?.tag)
      .toBe("vendor/model-b-route");
  });
});

describe("openRouterModelDiscoveryIdentity", () => {
  const connection = { draftVersion: 4, id: "connection-1" };

  function credential(overrides: Partial<AdminProviderCredential>): AdminProviderCredential {
    return {
      activatedAt: null,
      activeVersion: null,
      createdAt: "2026-07-24T00:00:00.000Z",
      draftSecretConfigured: false,
      draftVersion: 2,
      enabled: true,
      id: "credential-1",
      label: "Primary",
      testedAt: null,
      updatedAt: "2026-07-24T00:00:00.000Z",
      ...overrides
    };
  }

  it("matches server precedence for draft, active, and unusable credentials", () => {
    expect(openRouterModelDiscoveryIdentity(connection, credential({
      activeVersion: {
        activatedAt: "2026-07-24T00:00:00.000Z",
        id: "active-1",
        revokedAt: null,
        testedAt: "2026-07-24T00:00:00.000Z",
        version: 1
      },
      draftSecretConfigured: true
    }))?.credentialVersion).toEqual({ kind: "draft", version: 2 });

    expect(openRouterModelDiscoveryIdentity(connection, credential({
      activeVersion: {
        activatedAt: "2026-07-24T00:00:00.000Z",
        id: "active-1",
        revokedAt: null,
        testedAt: "2026-07-24T00:00:00.000Z",
        version: 1
      }
    }))?.credentialVersion).toEqual({
      kind: "active",
      version: 1,
      versionId: "active-1"
    });

    expect(openRouterModelDiscoveryIdentity(connection, credential({
      activeVersion: {
        activatedAt: "2026-07-24T00:00:00.000Z",
        id: "active-1",
        revokedAt: "2026-07-24T01:00:00.000Z",
        testedAt: "2026-07-24T00:00:00.000Z",
        version: 1
      }
    }))).toBeNull();
  });
});
