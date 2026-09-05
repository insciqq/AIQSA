import { shellFetch } from "@/components/app-shell/shellApi";
import {
  decodeAttachmentLibraryResponse,
  decodeUploadAttachmentResponse,
  type AttachmentLibraryResponseWire
} from "@/lib/contracts/uploads";
import { create } from "zustand";

type FileLibraryLoadState = "error" | "idle" | "loading" | "ready";

type FileLibraryStore = Readonly<{
  data: AttachmentLibraryResponseWire | null;
  error: string | null;
  loadState: FileLibraryLoadState;
  mutations: Readonly<Record<string, "saving" | "saved" | "removing" | "error">>;
}>;

export const useFileLibraryStore = create<FileLibraryStore>(() => ({
  data: null,
  error: null,
  loadState: "idle",
  mutations: {}
}));

let refreshGeneration = 0;
let loadPromise: Promise<AttachmentLibraryResponseWire> | null = null;

export function resetFileLibraryStoreForTest(): void {
  refreshGeneration = 0;
  loadPromise = null;
  useFileLibraryStore.setState({ data: null, error: null, loadState: "idle", mutations: {} }, true);
}

function setFileMutation(id: string, state: FileLibraryStore["mutations"][string] | null) {
  useFileLibraryStore.setState((current) => {
    const mutations = { ...current.mutations };
    if (state) mutations[id] = state;
    else delete mutations[id];
    return { mutations };
  });
}

export async function saveFileToLibrary(attachmentId: string): Promise<void> {
  const state = useFileLibraryStore.getState().mutations[attachmentId];
  if (state === "saving" || state === "saved") return;
  setFileMutation(attachmentId, "saving");
  try {
    const response = await shellFetch(`/api/uploads/${encodeURIComponent(attachmentId)}/save`, { method: "POST" });
    const value: unknown = await response.json().catch(() => null);
    if (!response.ok || !decodeUploadAttachmentResponse(value)) throw new Error("file_save_failed");
    setFileMutation(attachmentId, "saved");
  } catch {
    setFileMutation(attachmentId, "error");
    return;
  }
  // A save can overlap an already-running catalog read. Wait for it before
  // refreshing so the successful mutation cannot leave a stale list behind.
  await loadPromise?.catch(() => undefined);
  await refreshFileLibrary(true).catch(() => undefined);
}

export async function removeFileFromLibrary(attachmentId: string): Promise<void> {
  if (useFileLibraryStore.getState().mutations[attachmentId] === "removing") return;
  setFileMutation(attachmentId, "removing");
  try {
    const response = await shellFetch(`/api/uploads/${encodeURIComponent(attachmentId)}/save`, { method: "DELETE" });
    if (response.status !== 204) throw new Error("file_remove_failed");
    // Source buttons may refer to this saved copy. Let the server resolve a
    // subsequent explicit save instead of retaining stale client success.
    useFileLibraryStore.setState((current) => ({
      mutations: Object.fromEntries(Object.entries(current.mutations).filter(
        ([id, state]) => id !== attachmentId && state !== "saved"
      ))
    }));
  } catch {
    setFileMutation(attachmentId, "error");
    return;
  }
  await loadPromise?.catch(() => undefined);
  await refreshFileLibrary(true).catch(() => undefined);
}

export async function refreshFileLibrary(force = false, cursor: string | null = null): Promise<AttachmentLibraryResponseWire> {
  const current = useFileLibraryStore.getState();
  if (!force && current.data && current.loadState === "ready") return current.data;
  if (loadPromise) return loadPromise;
  const generation = ++refreshGeneration;
  useFileLibraryStore.setState({ error: null, loadState: "loading" });
  const promise = shellFetch(cursor ? `/api/uploads?cursor=${encodeURIComponent(cursor)}` : "/api/uploads")
    .then(async (response) => {
      const value: unknown = await response.json().catch(() => null);
      if (!response.ok) throw new Error("file_library_request_failed");
      const page = decodeAttachmentLibraryResponse(value);
      if (!page) throw new Error("file_library_response_invalid");
      const data = cursor && current.data ? {
        files: [...current.data.files, ...page.files.filter((file) => !current.data!.files.some((old) => old.id === file.id))],
        nextCursor: page.nextCursor
      } : page;
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

export function loadMoreFileLibrary(): Promise<AttachmentLibraryResponseWire> | undefined {
  const state = useFileLibraryStore.getState();
  return state.data?.nextCursor && state.loadState !== "loading"
    ? refreshFileLibrary(true, state.data.nextCursor) : undefined;
}
