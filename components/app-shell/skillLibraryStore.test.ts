import { afterEach, describe, expect, it, vi } from "vitest";
import {
  enableAllSkills,
  setSkillEnabled,
  loadMoreSkillLibrary,
  exportSkills,
  importSkills,
  loadSkillDetail,
  loadSkillFile,
  SkillRequestError,
  refreshSkillLibrary,
  resetSkillLibraryStoreForTest,
  useSkillLibraryStore
} from "./skillLibraryStore";

function skill(id: string, name = id) {
  return {
    archived: false,
    description: `${name} description`,
    id,
    instructionCharacterCount: 20,
    name,
    owned: true,
    ownerDisplayName: "Viewer",
    scope: { kind: "owner" },
    updatedAt: "2026-08-16T00:00:00.000Z",
    version: 1
  };
}

function page(skills: ReturnType<typeof skill>[], nextCursor: string | null): Response {
  return Response.json({
    nextCursor,
    publishableWorkspaces: [],
    skills,
    viewer: { canPublishInstallation: false }
  });
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((next) => {
    resolve = next;
  });
  return { promise, resolve };
}

describe("skillLibraryStore", () => {
  it("enables the full library in one request while preserving the current search", async () => {
    let enabled = false;
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === "POST") {
        enabled = true;
        return Response.json({ enabledCount: 60 });
      }
      return page([{ ...skill("review"), enabled } as ReturnType<typeof skill>], null);
    });
    vi.stubGlobal("fetch", fetchMock);
    await refreshSkillLibrary(true, "review");
    expect(await enableAllSkills()).toBe(60);
    const writes = fetchMock.mock.calls.filter(([, init]) => init?.method === "POST");
    expect(writes).toHaveLength(1);
    expect(writes[0]?.[0]).toBe("/api/me/skills/enable-all");
    expect(writes[0]?.[1]?.body).toBeUndefined();
    expect(useSkillLibraryStore.getState()).toMatchObject({ query: "review", data: { skills: [{ id: "review", enabled: true }] } });
    expect(String(fetchMock.mock.calls.at(-1)?.[0])).toContain("q=review");
  });

  it("keeps preferences unchanged when enabling the library fails", async () => {
    vi.stubGlobal("fetch", vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => init?.method === "POST"
      ? Response.json({ error: "skill_preference_failed" }, { status: 503 })
      : page([{ ...skill("review"), enabled: false } as ReturnType<typeof skill>], null)));
    await refreshSkillLibrary();
    await expect(enableAllSkills()).rejects.toThrow("skill_preference_failed");
    expect(useSkillLibraryStore.getState().data?.skills[0]?.enabled).toBe(false);
  });

  afterEach(() => {
    resetSkillLibraryStoreForTest();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it("persists Enabled without a revision edit and fences an older list response", async () => {
    const stale = deferred<Response>();
    let listRequests = 0;
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === "PATCH") return Response.json({ skillId: "review", enabled: false });
      if (++listRequests === 1) return stale.promise;
      return page([{ ...skill("review"), enabled: false } as ReturnType<typeof skill>], null);
    });
    vi.stubGlobal("fetch", fetchMock);
    const loading = refreshSkillLibrary();
    expect(await setSkillEnabled("review", false)).toBe(false);
    stale.resolve(page([skill("review")], null));
    await loading;
    expect(useSkillLibraryStore.getState().data?.skills[0]?.enabled).toBe(false);
    const mutation = fetchMock.mock.calls.find(([, init]) => init?.method === "PATCH")!;
    expect(String(mutation[0])).toBe("/api/me/skills/review/preference");
    expect(JSON.parse(String(mutation[1]!.body))).toEqual({ enabled: false });
  });

  it("sends search to the server and appends cursor pages without duplicates", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      return url.includes("cursor=cursor-1")
        ? page([skill("skill-1"), skill("skill-2")], null)
        : page([skill("skill-1")], "cursor-1");
    });
    vi.stubGlobal("fetch", fetchMock);

    await refreshSkillLibrary(true, "careful review");
    await loadMoreSkillLibrary();

    expect(String(fetchMock.mock.calls[0]?.[0])).toContain("q=careful+review");
    expect(String(fetchMock.mock.calls[1]?.[0])).toContain("cursor=cursor-1");
    expect(String(fetchMock.mock.calls[1]?.[0])).toContain("q=careful+review");
    expect(useSkillLibraryStore.getState().data?.skills.map(({ id }) => id)).toEqual([
      "skill-1",
      "skill-2"
    ]);
  });

  it("ignores a slower response from an obsolete search", async () => {
    const oldResponse = deferred<Response>();
    const newResponse = deferred<Response>();
    vi.stubGlobal("fetch", vi.fn((input: RequestInfo | URL) =>
      String(input).includes("q=old") ? oldResponse.promise : newResponse.promise));

    const oldLoad = refreshSkillLibrary(true, "old");
    const newLoad = refreshSkillLibrary(true, "new");
    newResponse.resolve(page([skill("skill-new", "New result")], null));
    await newLoad;
    oldResponse.resolve(page([skill("skill-old", "Old result")], null));
    await oldLoad;

    expect(useSkillLibraryStore.getState()).toMatchObject({
      data: { skills: [expect.objectContaining({ id: "skill-new" })] },
      loadState: "ready",
      query: "new"
    });
  });

  it("preserves folder paths and per-skill import results when the follow-up list fails", async () => {
    const file = new File(["# Notes"], "notes.md", { type: "text/markdown" });
    Object.defineProperty(file, "webkitRelativePath", { value: "review/references/notes.md" });
    const result = { ignoredFiles: 1, results: [
      { name: "Review", outcome: "created", skillId: "review" },
      { name: "Long", outcome: "failed", error: { code: "skill_field_too_long", field: "description", actual: 1025, limit: 1024 } }
    ] };
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => init?.method === "POST"
      ? Response.json(result) : Response.json({ error: "unavailable" }, { status: 503 }));
    vi.stubGlobal("fetch", fetchMock);
    expect(await importSkills([file])).toEqual(result);
    const form = fetchMock.mock.calls[0]?.[1]?.body as FormData;
    expect([...form.keys()]).toEqual(["review/references/notes.md"]);
    expect((form.get("review/references/notes.md") as File).name).toBe("notes.md");
    expect(useSkillLibraryStore.getState().loadState).toBe("error");
  });

  it("refreshes past a list request that started before an accepted import", async () => {
    const oldResponse = deferred<Response>();
    let listRequests = 0;
    vi.stubGlobal("fetch", vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === "POST") return Response.json({ results: [{ name: "New", outcome: "created", skillId: "new" }], ignoredFiles: 0 });
      return ++listRequests === 1 ? oldResponse.promise : page([skill("new")], null);
    }));
    const stale = refreshSkillLibrary();
    await importSkills([new File(["---"], "SKILL.md")]);
    oldResponse.resolve(page([], null));
    await stale;
    expect(useSkillLibraryStore.getState().data?.skills.map(({ id }) => id)).toEqual(["new"]);
  });

  it("rejects malformed import results instead of reporting a partial success", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ ignoredFiles: 0, results: [
      { name: "Review", outcome: "failed", error: { code: "skill_field_too_long", actual: -1 } }
    ] })));
    await expect(importSkills([new File(["zip"], "skills.zip")])).rejects.toThrow("skill_response_invalid");
  });

  it("decodes bundle metadata and checks file identity before showing text", async () => {
    const detail = { ...skill("bundle"), instructionApproxTokens: 400, fileCount: 2, hasExecutables: true,
      assistantUsageCount: 0, audiences: [], canDelete: true, canEdit: true, canPublish: true, canUnshare: true,
      instructions: "Review", owner: { displayName: "Viewer" }, workspaceUsageCount: 0,
      files: [{ path: "scripts/check.sh", byteSize: 12, kind: "text", executable: true }],
      bundle: { fileCount: 2, totalBytes: 20, hasExecutables: true } };
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => String(input).includes("/files?")
      ? Response.json({ path: "different.txt", content: "wrong revision" }) : Response.json({ skill: detail }));
    vi.stubGlobal("fetch", fetchMock);
    expect(await loadSkillDetail("bundle")).toMatchObject({ instructionApproxTokens: 400, files: detail.files, bundle: detail.bundle });
    await expect(loadSkillFile("bundle", "scripts/check.sh")).rejects.toThrow("skill_response_invalid");
    expect(String(fetchMock.mock.calls[1]?.[0])).toContain("path=scripts%2Fcheck.sh");
  });

  it("downloads a complete ZIP from the single and all-owned endpoints", async () => {
    vi.useFakeTimers();
    const urls: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      urls.push(String(input));
      return new Response("zip", { headers: { "content-type": "application/zip" } });
    }));
    const createObjectURL = vi.fn(() => "blob:skill-export");
    vi.stubGlobal("URL", class extends URL { static createObjectURL = createObjectURL; });
    const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => undefined);
    await exportSkills();
    await exportSkills("skill/id");
    expect(urls).toEqual(["/api/me/skills/export", "/api/me/skills/skill%2Fid/export"]);
    expect(createObjectURL).toHaveBeenCalledTimes(2);
    expect(click).toHaveBeenCalledTimes(2);
    expect(document.querySelector('a[download="skills.zip"]')).toBeNull();
  });

  it("preserves concrete export limits and never downloads a failed archive", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ error: "skill_field_too_long", field: "archiveBytes", actual: 101, limit: 100 }, { status: 400 })));
    const failure = await exportSkills().catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(SkillRequestError);
    expect((failure as SkillRequestError).issue).toEqual({ code: "skill_field_too_long", field: "archiveBytes", actual: 101, limit: 100 });
  });
});
