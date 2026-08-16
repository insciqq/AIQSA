import { afterEach, describe, expect, it, vi } from "vitest";
import {
  loadMoreSkillLibrary,
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
  afterEach(() => {
    resetSkillLibraryStoreForTest();
    vi.unstubAllGlobals();
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
});
