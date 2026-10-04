import { afterEach, describe, expect, it, vi } from "vitest";
import { loadImageModels, resetImageModelStoreForTest, selectImageModel, useImageModelStore } from "./imageModelStore";

const model = { id: "image-1", displayName: "GPT Image 2", providerName: "OpenAI", generation: true, editing: true, unavailableReason: null };
const following = { models: [model, { ...model, id: "image-2", displayName: "Second" }], organizationDefaultId: "image-1",
  selectedId: null, effective: { id: "image-1", source: "organization" } };
const chosen = { ...following, selectedId: "image-2", effective: { id: "image-2", source: "personal" } };

const json = (body: unknown, status = 200) => Response.json(body, { status });

describe("image model store", () => {
  afterEach(() => {
    resetImageModelStoreForTest();
    vi.unstubAllGlobals();
  });

  it("loads once at a time and keeps server truth from a save over an older read", async () => {
    const reads: Array<(response: Response) => void> = [];
    const fetchMock = vi.fn((_input: RequestInfo | URL, init?: RequestInit) => init?.method === "PATCH"
      ? Promise.resolve(json({ imageModel: chosen }))
      : new Promise<Response>((resolve) => { reads.push(resolve); }));
    vi.stubGlobal("fetch", fetchMock);
    const first = loadImageModels();
    expect(loadImageModels()).toBe(first);
    expect(useImageModelStore.getState().loadState).toBe("loading");
    expect(await selectImageModel("image-2")).toBe(true);
    reads[0]!(json({ imageModel: following }));
    await first;
    expect(useImageModelStore.getState()).toMatchObject({ settings: chosen, loadState: "ready", saving: false, saveError: null });
    expect(fetchMock).toHaveBeenCalledWith("/api/me/image-models", expect.objectContaining({ method: "PATCH",
      body: JSON.stringify({ providerModelId: "image-2" }) }));
  });

  it("keeps a failed read visible as an error instead of an empty list", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => json({ error: "image_models_unavailable" }, 503)));
    await loadImageModels();
    expect(useImageModelStore.getState()).toMatchObject({ settings: null, loadState: "error", loadError: "image_models_unavailable" });
    vi.stubGlobal("fetch", vi.fn(async () => json({ imageModel: { ...following, organizationDefaultId: "guessed" } })));
    await loadImageModels();
    expect(useImageModelStore.getState()).toMatchObject({ settings: null, loadState: "error", loadError: "image_models_response_invalid" });
  });

  it("reports a withdrawn choice and refreshes the published list", async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => init?.method === "PATCH"
      ? json({ error: "image_model_not_published" }, 409) : json({ imageModel: following }));
    vi.stubGlobal("fetch", fetchMock);
    expect(await selectImageModel("withdrawn")).toBe(false);
    await vi.waitFor(() => expect(useImageModelStore.getState().settings).toEqual(following));
    expect(useImageModelStore.getState()).toMatchObject({ saving: false, saveError: "image_model_not_published" });
    expect(fetchMock.mock.calls.map(([, init]) => init?.method)).toEqual(["PATCH", "GET"]);
  });
});
