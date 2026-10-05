import { ImageModelApiError, loadUserImageModels, saveUserImageModel } from "@/components/app-shell/imageModelApi";
import type { UserImageModelSettings } from "@/lib/contracts/imageModels";
import { create } from "zustand";

export type ImageModelLoadState = "error" | "idle" | "loading" | "ready";

type ImageModelStore = {
  /** Server truth from the last successful read or save. */
  settings: UserImageModelSettings | null;
  loadState: ImageModelLoadState;
  saving: boolean;
  /** Stable error codes; views own the copy. */
  loadError: string | null;
  saveError: string | null;
};

const initialState: ImageModelStore = { settings: null, loadState: "idle", saving: false, loadError: null, saveError: null };

/** One owner for the user's image model choice; the Chat defaults row reads it. */
export const useImageModelStore = create<ImageModelStore>(() => initialState);

let generation = 0;
let loadRequest: Readonly<{ generation: number; promise: Promise<void> }> | null = null;

const code = (error: unknown) => error instanceof ImageModelApiError ? error.code : "image_models_unavailable";

export function resetImageModelStoreForTest(): void {
  generation += 1;
  loadRequest = null;
  useImageModelStore.setState(initialState, true);
}

/** One read at a time; a later save makes an older read stale. */
export function loadImageModels(): Promise<void> {
  if (loadRequest?.generation === generation) return loadRequest.promise;
  const requestGeneration = generation;
  useImageModelStore.setState((state) => ({ loadError: null, loadState: state.settings ? state.loadState : "loading" }));
  const promise = loadUserImageModels().then((settings) => {
    if (requestGeneration === generation) useImageModelStore.setState({ settings, loadState: "ready", loadError: null });
  }, (error: unknown) => {
    if (requestGeneration === generation) {
      useImageModelStore.setState((state) => ({ loadError: code(error), loadState: state.settings ? state.loadState : "error" }));
    }
  }).finally(() => {
    if (loadRequest?.generation === requestGeneration) loadRequest = null;
  });
  loadRequest = { generation: requestGeneration, promise };
  return promise;
}

/** Saves one published model, or null to follow the organization default. */
export async function selectImageModel(providerModelId: string | null): Promise<boolean> {
  if (useImageModelStore.getState().saving) return false;
  generation += 1;
  const saveGeneration = generation;
  loadRequest = null;
  useImageModelStore.setState({ saving: true, saveError: null });
  try {
    const settings = await saveUserImageModel(providerModelId);
    if (saveGeneration === generation) useImageModelStore.setState({ settings, loadState: "ready", saving: false, saveError: null });
    return true;
  } catch (error) {
    if (saveGeneration !== generation) return false;
    useImageModelStore.setState({ saving: false, saveError: code(error) });
    // A withdrawn model means the list is stale: show the current one.
    if (code(error) === "image_model_not_published") void loadImageModels();
    return false;
  }
}
