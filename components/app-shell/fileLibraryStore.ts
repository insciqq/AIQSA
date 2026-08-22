import { shellFetch } from "@/components/app-shell/shellApi";
import {
  decodeAttachmentLibraryResponse,
  type AttachmentLibraryResponseWire
} from "@/lib/contracts/uploads";
import { create } from "zustand";

type FileLibraryLoadState = "error" | "idle" | "loading" | "ready";

type FileLibraryStore = Readonly<{
  data: AttachmentLibraryResponseWire | null;
  error: string | null;
  loadState: FileLibraryLoadState;
}>;

export const useFileLibraryStore = create<FileLibraryStore>(() => ({
  data: null,
  error: null,
  loadState: "idle"
}));

let refreshGeneration = 0;
let loadPromise: Promise<AttachmentLibraryResponseWire> | null = null;

export function resetFileLibraryStoreForTest(): void {
  refreshGeneration = 0;
  loadPromise = null;
  useFileLibraryStore.setState({ data: null, error: null, loadState: "idle" }, true);
}

export async function refreshFileLibrary(force = false): Promise<AttachmentLibraryResponseWire> {
  const current = useFileLibraryStore.getState();
  if (!force && current.data && current.loadState === "ready") return current.data;
  if (loadPromise) return loadPromise;
  const generation = ++refreshGeneration;
  useFileLibraryStore.setState({ error: null, loadState: "loading" });
  const promise = shellFetch("/api/uploads")
    .then(async (response) => {
      const value: unknown = await response.json().catch(() => null);
      if (!response.ok) throw new Error("file_library_request_failed");
      const data = decodeAttachmentLibraryResponse(value);
      if (!data) throw new Error("file_library_response_invalid");
      if (generation === refreshGeneration) {
        useFileLibraryStore.setState({ data, error: null, loadState: "ready" });
      }
      return data;
    })
    .catch((error: unknown) => {
      if (generation === refreshGeneration) {
        useFileLibraryStore.setState({
          error: error instanceof Error ? error.message : "file_library_request_failed",
          loadState: "error"
        });
      }
      throw error;
    })
    .finally(() => {
      if (loadPromise === promise) loadPromise = null;
    });
  loadPromise = promise;
  return promise;
}
