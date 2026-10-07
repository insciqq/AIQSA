// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";
import { logEvent } from "../observability";
import { WORKSPACE_DEFAULT_IMAGE_REF } from "./config";
import {
  createMicrosandboxImageStore,
  evictUnusedWorkspaceImages,
  workspaceImageRepository,
  type WorkspaceImageStore
} from "./guestImageCache";

const sdk = vi.hoisted(() => {
  class ImageInUseError extends Error {}
  class ImageNotFoundError extends Error {}
  return { ImageInUseError, ImageNotFoundError, get: vi.fn(), list: vi.fn(), listSandboxes: vi.fn(), remove: vi.fn() };
});

vi.mock("microsandbox", () => ({
  Image: { get: sdk.get, list: sdk.list, remove: sdk.remove },
  Sandbox: { listWith: sdk.listSandboxes },
  ImageInUseError: sdk.ImageInUseError,
  ImageNotFoundError: sdk.ImageNotFoundError
}));
vi.mock("../observability", async (importOriginal) => ({
  ...await importOriginal<typeof import("../observability")>(),
  logEvent: vi.fn()
}));

type CachedEntry = Readonly<{ createdAt?: number; digest: string | null; layers?: readonly string[]; reference: string }>;

/**
 * The runtime cache as microsandbox keeps it: references name manifests,
 * manifests own layer files, and an existing sandbox's root disk pins its
 * manifest so that no reference to it can be removed without force.
 */
function fakeCache(entries: readonly CachedEntry[], pinnedDigests: readonly string[] = [],
  sandboxImages: readonly Readonly<{ manifestDigest: string | null; reference: string | null }>[] = []) {
  const references = new Map(entries.map((entry) => [entry.reference, entry]));
  const manifests = new Map(entries.flatMap((entry) => entry.digest ? [[entry.digest, entry.layers ?? [`${entry.digest}-layer`]] as const] : []));
  const layerFiles = new Set([...manifests.values()].flat());
  const pinned = new Set(pinnedDigests);
  const view = (entry: CachedEntry) => ({
    createdAt: entry.createdAt === undefined ? null : new Date(entry.createdAt),
    manifestDigest: entry.digest,
    reference: entry.reference
  });
  const store = {
    find: vi.fn(async (reference: string) => {
      const entry = references.get(reference);
      return entry ? view(entry) : null;
    }),
    list: vi.fn(async () => [...references.values()].map(view)),
    remove: vi.fn(async (reference: string) => {
      const entry = references.get(reference);
      if (!entry) return "missing" as const;
      if (entry.digest && pinned.has(entry.digest)) return "in_use" as const;
      references.delete(reference);
      if (entry.digest && ![...references.values()].some((other) => other.digest === entry.digest)) {
        manifests.delete(entry.digest);
        const live = new Set([...manifests.values()].flat());
        for (const layer of [...layerFiles]) if (!live.has(layer)) layerFiles.delete(layer);
      }
      return "removed" as const;
    }),
    sandboxImages: vi.fn(async () => sandboxImages)
  } satisfies WorkspaceImageStore;
  return { layerFiles, references, store };
}

beforeEach(() => {
  vi.mocked(logEvent).mockClear();
  sdk.get.mockReset();
  sdk.list.mockReset();
  sdk.listSandboxes.mockReset();
  sdk.remove.mockReset();
});

describe("Workspace guest image eviction", () => {
  it("evicts older guest versions no sandbox pins, keeping the current, previous and retained-disk guests", async () => {
    const cache = fakeCache([
      { createdAt: 1, digest: "sha256:m28", reference: "aiqsa-workspace:0.1.28" },
      { createdAt: 2, digest: "sha256:m29", reference: "aiqsa-workspace:0.1.29" },
      { createdAt: 3, digest: "sha256:m30", reference: "aiqsa-workspace:0.1.30" },
      { createdAt: 4, digest: "sha256:m31", reference: WORKSPACE_DEFAULT_IMAGE_REF },
      { createdAt: 0, digest: "sha256:other", reference: "python:3.12" }
    ], ["sha256:m29"]);

    await expect(evictUnusedWorkspaceImages({ imageRef: WORKSPACE_DEFAULT_IMAGE_REF, store: cache.store })).resolves.toEqual({
      candidates: 2, deferred: 0, failed: 0, inUse: 1, outcome: "completed", removed: 1
    });
    // A stopped session's retained disk still finds its base layers on resume.
    expect([...cache.references.keys()].sort()).toEqual(
      ["aiqsa-workspace:0.1.29", "aiqsa-workspace:0.1.30", WORKSPACE_DEFAULT_IMAGE_REF, "python:3.12"]);
    expect([...cache.layerFiles].sort()).toEqual(["sha256:m29-layer", "sha256:m30-layer", "sha256:m31-layer", "sha256:other-layer"]);
    expect(cache.store.remove.mock.calls.map(([reference]) => reference)).toEqual(["aiqsa-workspace:0.1.28", "aiqsa-workspace:0.1.29"]);
  });

  it("keeps a guest that any sandbox record names, even one whose first boot never bound a disk", async () => {
    const entries = [
      { createdAt: 1, digest: "sha256:m27", reference: "aiqsa-workspace:0.1.27" },
      { createdAt: 2, digest: "sha256:m28", reference: "aiqsa-workspace:0.1.28" },
      { createdAt: 3, digest: "sha256:m29", reference: "aiqsa-workspace:0.1.29" },
      { createdAt: 4, digest: "sha256:m30", reference: "aiqsa-workspace:0.1.30" }
    ];
    // The runtime would let both go: no disk pins either manifest.
    const cache = fakeCache(entries, [], [
      { manifestDigest: null, reference: "aiqsa-workspace:0.1.27" },
      { manifestDigest: "sha256:m28", reference: "registry.example/guest:renamed" }
    ]);

    await expect(evictUnusedWorkspaceImages({ imageRef: WORKSPACE_DEFAULT_IMAGE_REF, store: cache.store })).resolves.toEqual({
      candidates: 3, deferred: 0, failed: 0, inUse: 2, outcome: "completed", removed: 1
    });
    expect(cache.store.remove.mock.calls.map(([reference]) => reference)).toEqual(["aiqsa-workspace:0.1.29"]);
    expect([...cache.references.keys()]).toEqual(["aiqsa-workspace:0.1.27", "aiqsa-workspace:0.1.28", "aiqsa-workspace:0.1.30"]);

    const unlisted = fakeCache(entries);
    unlisted.store.sandboxImages.mockRejectedValueOnce(new Error("database locked"));
    await expect(evictUnusedWorkspaceImages({ imageRef: WORKSPACE_DEFAULT_IMAGE_REF, store: unlisted.store }))
      .resolves.toMatchObject({ outcome: "degraded", removed: 0 });
    expect(unlisted.store.remove).not.toHaveBeenCalled();
  });

  it("keeps aliases of a custom configured image and evicts both repositories' older versions", async () => {
    const cache = fakeCache([
      { createdAt: 0, digest: "sha256:m0", reference: "registry.example:5000/guest:0" },
      { createdAt: 0, digest: "sha256:m0", reference: "aiqsa-workspace:0.1.29" },
      { createdAt: 1, digest: "sha256:m1", reference: "registry.example:5000/guest:1" },
      { createdAt: 1, digest: "sha256:m1", reference: "aiqsa-workspace:0.1.30" },
      { createdAt: 2, digest: "sha256:m2", reference: "registry.example:5000/guest:2" },
      // The bundled archive's own reference names the configured guest too.
      { createdAt: 2, digest: "sha256:m2", reference: "aiqsa-workspace:0.1.31" }
    ]);

    await expect(evictUnusedWorkspaceImages({ imageRef: "registry.example:5000/guest:2", store: cache.store }))
      .resolves.toMatchObject({ candidates: 2, outcome: "completed", removed: 2 });
    expect([...cache.references.keys()].sort()).toEqual([
      "aiqsa-workspace:0.1.30", "aiqsa-workspace:0.1.31", "registry.example:5000/guest:1", "registry.example:5000/guest:2"
    ]);
    expect([...cache.layerFiles].sort()).toEqual(["sha256:m1-layer", "sha256:m2-layer"]);
  });

  it("evicts before a newly configured guest version is loaded, keeping the release it replaces", async () => {
    const cache = fakeCache([
      { createdAt: 1, digest: "sha256:m29", reference: "aiqsa-workspace:0.1.29" },
      { createdAt: 2, digest: "sha256:m30", reference: "aiqsa-workspace:0.1.30" },
      { createdAt: 3, digest: "sha256:m31", reference: "aiqsa-workspace:0.1.31" }
    ], ["sha256:m30"]);

    await expect(evictUnusedWorkspaceImages({ imageRef: "aiqsa-workspace:0.1.32", store: cache.store })).resolves.toEqual({
      candidates: 2, deferred: 0, failed: 0, inUse: 1, outcome: "completed", removed: 1
    });
    expect([...cache.references.keys()]).toEqual(["aiqsa-workspace:0.1.30", "aiqsa-workspace:0.1.31"]);
  });

  it("keeps a lone previous version and the current guest when nothing older is cached", async () => {
    const cache = fakeCache([
      { createdAt: 1, digest: "sha256:m30", reference: "aiqsa-workspace:0.1.30" },
      { createdAt: 2, digest: "sha256:m31", reference: WORKSPACE_DEFAULT_IMAGE_REF }
    ]);
    await expect(evictUnusedWorkspaceImages({ imageRef: WORKSPACE_DEFAULT_IMAGE_REF, store: cache.store })).resolves.toEqual({
      candidates: 0, deferred: 0, failed: 0, inUse: 0, outcome: "completed", removed: 0
    });
    expect(cache.store.remove).not.toHaveBeenCalled();
  });

  it("bounds a pass by attempts and by time, oldest versions first", async () => {
    const entries = [6, 3, 1, 5, 4, 2].map((age) => ({ createdAt: age, digest: `sha256:m${age}`, reference: `aiqsa-workspace:0.1.${age}` }));
    const counted = fakeCache(entries);
    await expect(evictUnusedWorkspaceImages({ imageRef: WORKSPACE_DEFAULT_IMAGE_REF, maxAttempts: 2, store: counted.store }))
      .resolves.toEqual({ candidates: 5, deferred: 3, failed: 0, inUse: 0, outcome: "completed", removed: 2 });
    expect(counted.store.remove.mock.calls.map(([reference]) => reference)).toEqual(["aiqsa-workspace:0.1.1", "aiqsa-workspace:0.1.2"]);

    // Each clock read advances ten seconds: the third removal would start at the budget.
    const timed = fakeCache(entries);
    let clock = 0;
    const now = () => {
      const value = clock;
      clock += 10_000;
      return value;
    };
    await expect(evictUnusedWorkspaceImages({ budgetMs: 30_000, imageRef: WORKSPACE_DEFAULT_IMAGE_REF, now, store: timed.store }))
      .resolves.toEqual({ candidates: 5, deferred: 3, failed: 0, inUse: 0, outcome: "completed", removed: 2 });
    expect(timed.store.remove).toHaveBeenCalledTimes(2);
  });

  it("removes nothing when the cache cannot be read or the current guest cannot be identified", async () => {
    // A readable cache would lose 0.1.29 in this pass.
    const entries = [
      { createdAt: 1, digest: "sha256:m29", reference: "aiqsa-workspace:0.1.29" },
      { createdAt: 2, digest: "sha256:m30", reference: "aiqsa-workspace:0.1.30" }
    ];
    const unreadable = fakeCache(entries);
    unreadable.store.list.mockRejectedValueOnce(new Error("database locked"));
    const unidentified = fakeCache([...entries, { digest: null, reference: WORKSPACE_DEFAULT_IMAGE_REF }]);
    const unresolved = fakeCache(entries);
    unresolved.store.find.mockRejectedValueOnce(new Error("database locked"));

    for (const cache of [unreadable, unidentified, unresolved]) {
      await expect(evictUnusedWorkspaceImages({ imageRef: WORKSPACE_DEFAULT_IMAGE_REF, store: cache.store })).resolves.toEqual({
        candidates: 0, deferred: 0, failed: 0, inUse: 0, outcome: "degraded", removed: 0
      });
      expect(cache.store.remove).not.toHaveBeenCalled();
    }
  });

  it("stops the pass at the first failed removal and never touches entries without a manifest identity", async () => {
    const cache = fakeCache([
      { createdAt: 1, digest: "sha256:m28", reference: "aiqsa-workspace:0.1.28" },
      { createdAt: 2, digest: "sha256:m29", reference: "aiqsa-workspace:0.1.29" },
      { createdAt: 3, digest: "sha256:m30", reference: "aiqsa-workspace:0.1.30" },
      { createdAt: 0, digest: null, reference: "aiqsa-workspace:dangling" }
    ]);
    cache.store.remove.mockRejectedValueOnce(new Error("disk i/o"));

    await expect(evictUnusedWorkspaceImages({ imageRef: WORKSPACE_DEFAULT_IMAGE_REF, store: cache.store })).resolves.toEqual({
      candidates: 2, deferred: 1, failed: 1, inUse: 0, outcome: "degraded", removed: 0
    });
    expect(cache.store.remove).toHaveBeenCalledTimes(1);
    expect(cache.references.has("aiqsa-workspace:dangling")).toBe(true);
  });

  it("records only content-free counts", async () => {
    const cache = fakeCache([
      { createdAt: 1, digest: "sha256:m28", reference: "aiqsa-workspace:0.1.28" },
      { createdAt: 2, digest: "sha256:m29", reference: "aiqsa-workspace:0.1.29" },
      { createdAt: 3, digest: "sha256:m30", reference: "aiqsa-workspace:0.1.30" }
    ], ["sha256:m29"]);
    await evictUnusedWorkspaceImages({ imageRef: WORKSPACE_DEFAULT_IMAGE_REF, now: () => 0, store: cache.store });
    expect(logEvent).toHaveBeenCalledExactlyOnceWith("runtime_lifecycle", {
      completed_count: 1, count: 2, duration_ms: 0, failed_count: 0, outcome: "completed",
      pending_count: 1, stage: "evict", subsystem: "workspace"
    });

    const unreadable = fakeCache([]);
    unreadable.store.list.mockRejectedValueOnce(new Error("database locked"));
    await evictUnusedWorkspaceImages({ imageRef: WORKSPACE_DEFAULT_IMAGE_REF, now: () => 0, store: unreadable.store });
    expect(logEvent).toHaveBeenLastCalledWith("runtime_lifecycle", expect.objectContaining({
      action: "degrade", code: "workspace_image_eviction_failed", outcome: "degraded"
    }));
    expect(JSON.stringify(vi.mocked(logEvent).mock.calls)).not.toMatch(/aiqsa-workspace|sha256/u);
  });

  it.each([
    ["aiqsa-workspace:0.1.31", "aiqsa-workspace"],
    ["aiqsa-workspace", "aiqsa-workspace"],
    ["registry.example:5000/team/guest:2", "registry.example:5000/team/guest"],
    ["registry.example:5000/team/guest", "registry.example:5000/team/guest"],
    ["guest:1@sha256:abc", "guest"],
    ["@sha256:abc", null]
  ])("derives the repository of %s", (reference, repository) => {
    expect(workspaceImageRepository(reference)).toBe(repository);
  });
});

describe("Microsandbox guest image store", () => {
  it("never forces a removal and reports pinned or missing images", async () => {
    const store = createMicrosandboxImageStore();
    sdk.remove.mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new sdk.ImageInUseError("pinned"))
      .mockRejectedValueOnce(new sdk.ImageNotFoundError("gone"))
      .mockRejectedValueOnce(new Error("disk i/o"));

    await expect(store.remove("aiqsa-workspace:0.1.28")).resolves.toBe("removed");
    await expect(store.remove("aiqsa-workspace:0.1.29")).resolves.toBe("in_use");
    await expect(store.remove("aiqsa-workspace:0.1.30")).resolves.toBe("missing");
    await expect(store.remove("aiqsa-workspace:0.1.30")).rejects.toThrow("disk i/o");
    expect(sdk.remove.mock.calls.every(([, options]) => options?.force === false)).toBe(true);
  });

  it("reads every sandbox record's image across pages and refuses unreadable or unbounded inventories", async () => {
    const record = (config: unknown) => ({ configJson: typeof config === "string" ? config : JSON.stringify(config) });
    const pages = [
      { nextCursor: "page-2", sandboxes: [
        record({ image: { Oci: { reference: "aiqsa-workspace:0.1.29", rootDisk: { kind: "managed" } } }, manifestDigest: null }),
        record({ image: { Bind: "/srv/rootfs" }, manifestDigest: null })
      ] },
      { sandboxes: [record({ image: { Oci: { reference: "aiqsa-workspace:0.1.30" } }, manifestDigest: "sha256:m30" })] }
    ];
    const requests: Record<string, unknown>[] = [];
    sdk.listSandboxes.mockImplementation(async (configure: (list: unknown) => unknown) => {
      const options: Record<string, unknown> = {};
      const list = { cursor: (value: string) => { options.cursor = value; return list; }, limit: (value: number) => { options.limit = value; return list; } };
      configure(list);
      requests.push(options);
      return pages[requests.length - 1];
    });
    const store = createMicrosandboxImageStore();
    await expect(store.sandboxImages()).resolves.toEqual([
      { manifestDigest: null, reference: "aiqsa-workspace:0.1.29" },
      { manifestDigest: "sha256:m30", reference: "aiqsa-workspace:0.1.30" }
    ]);
    expect(requests).toEqual([{ limit: 100 }, { cursor: "page-2", limit: 100 }]);
    sdk.listSandboxes.mockReset();

    sdk.listSandboxes.mockResolvedValueOnce({ sandboxes: [record("{not json")] });
    await expect(store.sandboxImages()).rejects.toThrow();
    sdk.listSandboxes.mockResolvedValue({ nextCursor: "again", sandboxes: [] });
    await expect(store.sandboxImages()).rejects.toThrow("workspace_sandbox_inventory_too_large");
  });

  it("maps cached handles and treats only a missing image as absent", async () => {
    const handle = { createdAt: new Date(1), manifestDigest: "sha256:m31", reference: WORKSPACE_DEFAULT_IMAGE_REF, sizeBytes: 1 };
    sdk.get.mockResolvedValueOnce(handle)
      .mockRejectedValueOnce(new sdk.ImageNotFoundError("absent"))
      .mockRejectedValueOnce(new Error("database locked"));
    sdk.list.mockResolvedValueOnce([handle]);
    const store = createMicrosandboxImageStore();
    const cached = { createdAt: new Date(1), manifestDigest: "sha256:m31", reference: WORKSPACE_DEFAULT_IMAGE_REF };

    await expect(store.find(WORKSPACE_DEFAULT_IMAGE_REF)).resolves.toEqual(cached);
    await expect(store.find("aiqsa-workspace:0.1.32")).resolves.toBeNull();
    await expect(store.find(WORKSPACE_DEFAULT_IMAGE_REF)).rejects.toThrow("database locked");
    await expect(store.list()).resolves.toEqual([cached]);
  });
});
