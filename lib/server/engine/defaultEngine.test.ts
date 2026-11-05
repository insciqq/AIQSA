import type { PrismaClient } from "@prisma/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { normalizeArtifactOperation } from "../../contracts/artifacts";
import { RESEARCH_TIME_MS } from "../../contracts/research";
import { buildArtifactBundle } from "../artifacts/bundle";
import { createResearchClock } from "../research/clock";
import { NOOP_RESEARCH_PORTS, researchPorts, type ResearchRunScope } from "../research/ports";
import type { StorageAdapter } from "../uploads/storage";
import { defaultNativeEngineDeps } from "./defaultEngine";

vi.mock("../prisma", () => ({ prisma: {} }));

/**
 * What a real run gets. A port reaches production only from `research` here (`lib/server/research/ports.ts`), and a unit test of
 * the port itself cannot see one that was never wired: the last queue lost a real dependency that way.
 */
describe("the engine a real run gets", () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it("has the research clock as its time port, not the no-op", () => {
    const deps = defaultNativeEngineDeps({} as StorageAdapter, {} as PrismaClient);
    expect(deps.research?.ports?.time).toBe(createResearchClock);
    const extendTurn = vi.fn();
    const run: ResearchRunScope = { branchRunIds: [], chatId: "chat", extendTurn, now: () => Date.now(), researchRunId: "run", runId: "run", sources: { opened: async () => [] },
      turnEndsAt: () => Date.now() + 3_600_000, userFollowups: async () => [], userId: "user", userMessage: "" };
    const { time } = researchPorts(deps.research?.ports, run);
    expect(time).not.toBe(NOOP_RESEARCH_PORTS.time);
    time.planReleased();
    expect(extendTurn).toHaveBeenCalledExactlyOnceWith(Date.now() + RESEARCH_TIME_MS.hardEnd);
  });

  it("checks research pages through the artifact service, authorizing the owner and exact ready version before storage", async () => {
    const built = buildArtifactBundle(normalizeArtifactOperation({ entrypoint: "index.html", files: [{ mimeType: "text/html", path: "index.html",
      text: "<p>26 990 ₽</p>" }], intent: "create", kind: "html", title: "Synthetic options" }), []);
    const findFirst = vi.fn().mockResolvedValue({ artifactId: "artifact", bundleStorageKey: "synthetic-bundle", byteSize: built.bytes.length,
      checksum: built.checksum, id: "version" });
    const getObject = vi.fn(async () => ({ body: built.bytes, contentType: "application/json", storageKey: "synthetic-bundle" }));
    const deps = defaultNativeEngineDeps({ getObject } as unknown as StorageAdapter, { artifactVersion: { findFirst } } as unknown as PrismaClient);
    const run: ResearchRunScope = { branchRunIds: [], chatId: "chat", extendTurn: () => undefined, now: () => Date.now(), researchRunId: "run", runId: "run",
      sources: { opened: async () => [] }, turnEndsAt: () => Date.now(), userFollowups: async () => [], userId: "owner", userMessage: "" };
    const { page } = researchPorts(deps.research?.ports, run);
    expect(page).not.toBe(NOOP_RESEARCH_PORTS.page);
    const input = { caveats: [], page: { artifactId: "artifact", entrypoint: "index.html", title: "Synthetic options", versionId: "version" },
      report: "25 990 ₽", signal: new AbortController().signal };
    await expect(page.check(input)).resolves.toMatchObject({ kind: "mismatch", message: expect.stringContaining("26 990 ₽") });
    expect(findFirst).toHaveBeenCalledExactlyOnceWith({ where: { artifact: { archivedAt: null, ownerUserId: "owner" }, artifactId: "artifact", id: "version", status: "READY" } });
    expect(getObject).toHaveBeenCalledExactlyOnceWith("synthetic-bundle", { maxBytes: built.bytes.length });
    await expect(page.check({ ...input, report: "26 990 ₽" })).resolves.toEqual({ kind: "pass" });
    findFirst.mockResolvedValue(null);
    getObject.mockClear();
    await expect(page.check(input)).rejects.toThrow("research_page_source_unreadable");
    expect(getObject).not.toHaveBeenCalled();
  });
});
