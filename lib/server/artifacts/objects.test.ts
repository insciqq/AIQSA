// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";
import type { PrismaClient } from "@prisma/client";
import { normalizeArtifactOperation } from "@/lib/contracts/artifacts";
import type { StorageAdapter, StoredObjectInput } from "../uploads/storage";
import { ARTIFACT_RENDERER_VERSION, buildArtifactBundle } from "./bundle";
import { ArtifactToolError } from "./errors";
import { ARTIFACT_LARGE_WORK_BYTES, ARTIFACT_PAGE_RENDER_CACHE_BYTES, ArtifactPublicBusyError, boundedArtifactCreation, boundedArtifactWork, createArtifactObjects } from "./objects";

type RenderRow = { id: string; versionId: string; rendererVersion: number; page: string; renderedStorageKey: string; renderedByteSize: number; renderedChecksum: string; contentType: string };

const page = (title: string, extra = "") => `<!doctype html><html><head><title>${title}</title></head><body><h1>${title}</h1>${extra}</body></html>`;
const built = buildArtifactBundle(normalizeArtifactOperation({ intent: "create", kind: "html", title: "Site", entrypoint: "index.html", files: [
  { path: "index.html", mimeType: "text/html", text: page("Home", '<a href="about.html">About</a>') },
  { path: "about.html", mimeType: "text/html", text: page("About", '<a href="docs/guide.html#part">Guide</a>') },
  { path: "docs/guide.html", mimeType: "text/html", text: page("Guide") },
  { path: "data.json", mimeType: "application/json", text: '{"visits":3}' }
] }), []);
const row = { id: "version", artifactId: "artifact", ownerUserId: "owner", bundleStorageKey: "bundle", byteSize: built.bytes.byteLength, checksum: built.checksum };

function fixture(options: { cachedPageBytes?: number } = {}) {
  const renders: RenderRow[] = [];
  const objects = new Map<string, StoredObjectInput>([["bundle", { storageKey: "bundle", contentType: "application/json", body: built.bytes }]]);
  let gate: Promise<void> | null = null;
  const reads = vi.fn();
  const storage: StorageAdapter = {
    async putObject(value) { objects.set(value.storageKey, { ...value, body: Buffer.from(value.body) }); },
    async getObject(key) {
      reads(key);
      if (key === "bundle" && gate) await gate;
      const value = objects.get(key);
      if (!value) throw new Error("missing_object");
      return { ...value, body: Buffer.from(value.body) };
    },
    async deleteObject(key) { objects.delete(key); }
  };
  const same = (render: RenderRow, key: { versionId: string; rendererVersion: number; page: string }) =>
    render.versionId === key.versionId && render.rendererVersion === key.rendererVersion && render.page === key.page;
  const db = {
    artifactRender: {
      findUnique: vi.fn(async ({ where }: { where: { versionId_rendererVersion_page: { versionId: string; rendererVersion: number; page: string } } }) =>
        renders.find(render => same(render, where.versionId_rendererVersion_page)) ?? null),
      aggregate: vi.fn(async ({ where }: { where: { versionId: string; rendererVersion: number } }) => ({ _sum: { renderedByteSize: (options.cachedPageBytes ?? 0) +
        renders.filter(render => render.versionId === where.versionId && render.rendererVersion === where.rendererVersion && render.page !== "")
          .reduce((sum, render) => sum + render.renderedByteSize, 0) } })),
      create: vi.fn(async ({ data }: { data: Omit<RenderRow, "id"> }) => { const render = { id: `render-${renders.length}`, ...data }; renders.push(render); return render; }),
      deleteMany: vi.fn(async ({ where }: { where: { versionId: string; rendererVersion: { not: number } } }) => {
        const stale = renders.filter(render => render.versionId === where.versionId && render.rendererVersion !== where.rendererVersion.not);
        for (const render of stale) renders.splice(renders.indexOf(render), 1);
        return { count: stale.length };
      })
    },
    attachmentDeletionJob: { create: vi.fn(async () => ({})), upsert: vi.fn(async () => ({})) },
    artifactVersion: { findFirst: vi.fn(async () => ({ id: row.id })) },
    artifactVersionBlob: { findMany: vi.fn(async () => []) },
    // The registration claims its cleanup job and locks the artifact; both succeed here.
    $queryRaw: vi.fn(async (query: TemplateStringsArray | { strings?: readonly string[] }) =>
      (Array.isArray(query) ? query.join("") : (query as { strings?: readonly string[] }).strings?.join("") ?? "").includes("AttachmentDeletionJob") ? [{ id: "job" }] : []),
    $transaction: async (callback: (tx: unknown) => Promise<unknown>) => callback(db)
  };
  return { renders, objects, reads, db, store: createArtifactObjects(db as unknown as PrismaClient, storage),
    hold() { let release!: () => void; gate = new Promise(resolve => { release = resolve; }); return () => { gate = null; release(); }; } };
}
const renderKeys = (objects: Map<string, StoredObjectInput>) => [...objects.keys()].filter(key => key.startsWith("artifact-renders/"));

afterEach(() => { vi.useRealTimers(); });

describe("artifact render cache", () => {
  it("renders each page once per renderer version and shares one cold render between concurrent requests", async () => {
    const f = fixture();
    const release = f.hold();
    const first = f.store.rendered(row);
    const second = f.store.rendered(row);
    await vi.waitFor(() => expect(f.reads).toHaveBeenCalledWith("bundle"));
    release();
    const [entry, again] = await Promise.all([first, second]);
    expect(entry.body.equals(again.body)).toBe(true);
    expect(entry.body.toString()).toContain("<h1>Home</h1>");
    expect(f.renders).toEqual([expect.objectContaining({ versionId: "version", rendererVersion: ARTIFACT_RENDERER_VERSION, page: "" })]);
    expect(f.reads.mock.calls.filter(([key]) => key === "bundle")).toHaveLength(1);

    const about = await f.store.rendered(row, { page: "about.html" });
    expect(about.body.toString()).toContain("<h1>About</h1>");
    expect(about.body.toString()).not.toContain("<h1>Home</h1>");
    const guide = await f.store.rendered(row, { page: "docs/guide.html" });
    expect(guide.body.toString()).toContain("<h1>Guide</h1>");
    expect(f.renders.map(render => render.page)).toEqual(["", "about.html", "docs/guide.html"]);
    expect(renderKeys(f.objects)).toHaveLength(3);

    // Cached pages are read back, verified, and never rendered again.
    const cached = await f.store.rendered(row, { page: "about.html" });
    expect(cached.body.equals(about.body)).toBe(true);
    expect(f.reads.mock.calls.filter(([key]) => key === "bundle")).toHaveLength(3);
    expect(f.db.artifactRender.create).toHaveBeenCalledTimes(3);
    const aboutRender = f.renders.find(render => render.page === "about.html")!;
    f.objects.set(aboutRender.renderedStorageKey, { ...f.objects.get(aboutRender.renderedStorageKey)!, body: Buffer.from("tampered") });
    await expect(f.store.rendered(row, { page: "about.html" })).rejects.toThrow("artifact_render_unavailable");
  });

  it("replaces every page of an older renderer version when a page renders again", async () => {
    const f = fixture();
    await f.store.rendered(row);
    await f.store.rendered(row, { page: "about.html" });
    for (const render of f.renders) render.rendererVersion = ARTIFACT_RENDERER_VERSION - 1;
    await f.store.rendered(row);
    expect(f.renders).toEqual([expect.objectContaining({ page: "", rendererVersion: ARTIFACT_RENDERER_VERSION })]);
    expect(f.db.artifactRender.deleteMany).toHaveBeenLastCalledWith({ where: { versionId: "version", rendererVersion: { not: ARTIFACT_RENDERER_VERSION } } });
  });

  it("serves pages past the per-version page budget without storing them, and always stores the entry page", async () => {
    const f = fixture({ cachedPageBytes: ARTIFACT_PAGE_RENDER_CACHE_BYTES });
    const about = await f.store.rendered(row, { page: "about.html" });
    expect(about.body.toString()).toContain("<h1>About</h1>");
    expect(f.renders).toEqual([]); expect(renderKeys(f.objects)).toEqual([]);
    expect(f.db.attachmentDeletionJob.create).not.toHaveBeenCalled();
    await f.store.rendered(row);
    expect(f.renders.map(render => render.page)).toEqual([""]);
  });

  it("reports a page that is not part of the version as its typed error and stores nothing", async () => {
    const f = fixture();
    await expect(f.store.rendered(row, { page: "missing.html" })).rejects.toMatchObject({ code: "artifact_page_not_found" });
    await expect(f.store.rendered(row, { page: "data.json" })).rejects.toMatchObject({ code: "artifact_page_not_found" });
    expect(f.renders).toEqual([]); expect(renderKeys(f.objects)).toEqual([]);
  });
});

describe("bounded heavy artifact work", () => {
  it("runs large work one at a time in arrival order while small work proceeds", async () => {
    const order: string[] = [];
    let releaseFirst!: () => void;
    const first = boundedArtifactWork(async () => { order.push("first:start"); await new Promise<void>(resolve => { releaseFirst = resolve; }); order.push("first:end"); },
      ARTIFACT_LARGE_WORK_BYTES + 1);
    await vi.waitFor(() => expect(order).toEqual(["first:start"]));
    const second = boundedArtifactWork(async () => { order.push("second"); }, ARTIFACT_LARGE_WORK_BYTES + 1);
    const third = boundedArtifactWork(async () => { order.push("third"); }, 32 * 1024 * 1024);
    await expect(boundedArtifactWork(async () => "small", ARTIFACT_LARGE_WORK_BYTES)).resolves.toBe("small");
    await Promise.resolve();
    expect(order).toEqual(["first:start"]);
    releaseFirst();
    await Promise.all([first, second, third]);
    expect(order).toEqual(["first:start", "first:end", "second", "third"]);
    await expect(boundedArtifactWork(async () => "free again", ARTIFACT_LARGE_WORK_BYTES + 1)).resolves.toBe("free again");
  });

  it("lets general work wait for one of four turns in arrival order and refuses a turn not granted in time", async () => {
    vi.useFakeTimers();
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const active = Array.from({ length: 4 }, () => boundedArtifactWork(() => gate));
    const order: number[] = [];
    const queued = [1, 2].map(number => boundedArtifactWork(async () => { order.push(number); }));
    await vi.advanceTimersByTimeAsync(9_000);
    expect(order).toEqual([]);
    release(); await Promise.all([...active, ...queued]);
    expect(order).toEqual([1, 2]);
    let hold!: () => void;
    const blocker = new Promise<void>(resolve => { hold = resolve; });
    const busy = Array.from({ length: 4 }, () => boundedArtifactWork(() => blocker));
    const late = boundedArtifactWork(async () => "late").catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(await late).toBeInstanceOf(ArtifactPublicBusyError);
    hold(); await Promise.all(busy);
    await expect(boundedArtifactWork(async () => "free")).resolves.toBe("free");
  });

  it("refuses large work past the waiting room or the wait, and releases the turn after failure", async () => {
    vi.useFakeTimers();
    let release!: () => void;
    const holder = boundedArtifactWork(() => new Promise<void>(resolve => { release = resolve; }), ARTIFACT_LARGE_WORK_BYTES + 1);
    const waiting = Array.from({ length: 4 }, () => boundedArtifactWork(async () => "late", ARTIFACT_LARGE_WORK_BYTES + 1));
    const settled = waiting.map(promise => promise.then(() => "ran", (error: unknown) => error instanceof ArtifactPublicBusyError ? "busy" : "failed"));
    await expect(boundedArtifactWork(async () => "overflow", ARTIFACT_LARGE_WORK_BYTES + 1)).rejects.toBeInstanceOf(ArtifactPublicBusyError);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(await Promise.all(settled)).toEqual(["busy", "busy", "busy", "busy"]);
    release(); await holder;
    await expect(boundedArtifactWork(async () => { throw new Error("synthetic failure"); }, ARTIFACT_LARGE_WORK_BYTES + 1)).rejects.toThrow("synthetic failure");
    await expect(boundedArtifactWork(async () => "available", ARTIFACT_LARGE_WORK_BYTES + 1)).resolves.toBe("available");
  });
});

describe("bounded artifact creation", () => {
  /** Four creations that run until released, counting how many run at once. */
  function holders() {
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const state = { running: 0, peak: 0 };
    const work = async () => { state.running += 1; state.peak = Math.max(state.peak, state.running); await gate; state.running -= 1; };
    return { state, release, work, done: Promise.all(Array.from({ length: 4 }, () => boundedArtifactCreation(work))) };
  }
  const busyCode = (error: unknown) => error instanceof ArtifactToolError ? error.code : error;

  it("runs four at once and hands turns to waiters in arrival order", async () => {
    const held = holders();
    const order: number[] = [];
    const queued = [1, 2, 3].map(number => boundedArtifactCreation(async () => { order.push(number); await held.work(); }));
    await vi.waitFor(() => expect(held.state.running).toBe(4));
    expect(order).toEqual([]);
    held.release(); await Promise.all([held.done, ...queued]);
    expect(order).toEqual([1, 2, 3]);
    expect(held.state.peak).toBe(4);
  });

  it("refuses past eight waiting or thirty seconds with a typed busy error, before the work starts", async () => {
    vi.useFakeTimers();
    const held = holders();
    const work = vi.fn(async () => "ran");
    const waiting = Array.from({ length: 8 }, () => boundedArtifactCreation(work).catch(busyCode));
    const overflow = await boundedArtifactCreation(work).catch((error: unknown) => error);
    expect(overflow).toBeInstanceOf(ArtifactToolError);
    expect(overflow).toMatchObject({ code: "artifact_server_busy", hint: expect.stringContaining("Retry the same call once") });
    await vi.advanceTimersByTimeAsync(29_999);
    expect(work).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(await Promise.all(waiting)).toEqual(Array(8).fill("artifact_server_busy"));
    expect(work).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
    held.release(); await held.done;
    await expect(boundedArtifactCreation(async () => "free")).resolves.toBe("free");
  });

  it("removes an aborted waiter with its signal's reason and keeps the slot accounting", async () => {
    vi.useFakeTimers();
    const held = holders();
    const controller = new AbortController();
    const work = vi.fn(async () => "aborted ran");
    const aborted = boundedArtifactCreation(work, controller.signal).catch((error: unknown) => error);
    const waiting = Array.from({ length: 7 }, () => boundedArtifactCreation(async () => "waited"));
    const reason = new Error("run_stopped");
    controller.abort(reason);
    expect(await aborted).toBe(reason);
    expect(vi.getTimerCount()).toBe(7);
    // The freed place in the waiting room takes one more creation; the next one overflows.
    const last = boundedArtifactCreation(async () => "last");
    await expect(boundedArtifactCreation(async () => "overflow")).rejects.toMatchObject({ code: "artifact_server_busy" });
    await expect(boundedArtifactCreation(async () => "stopped", AbortSignal.abort(reason))).rejects.toBe(reason);
    held.release(); await held.done;
    expect(await Promise.all([...waiting, last])).toEqual([...Array(7).fill("waited"), "last"]);
    expect(work).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("releases the turn when the work fails", async () => {
    await Promise.all(Array.from({ length: 4 }, () =>
      expect(boundedArtifactCreation(async () => { throw new Error("synthetic failure"); })).rejects.toThrow("synthetic failure")));
    const held = holders();
    await vi.waitFor(() => expect(held.state.running).toBe(4));
    held.release(); await held.done;
  });
});
