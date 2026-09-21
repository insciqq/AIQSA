import { create } from "zustand";
import { ARTIFACT_KINDS, type ArtifactKind } from "@/lib/contracts/artifacts";
import { artifactRequest } from "@/components/artifacts/artifactClient";
import { deleteArtifactSavedState } from "@/components/artifacts/artifactBrowserStorage";

export type ArtifactLibraryItem = Readonly<{
  id: string;
  title: string;
  kind: ArtifactKind;
  currentVersionId: string;
  sourceChatId: string | null;
  publicationCount: number;
  updatedAt: string;
  byteSize?: number;
  version: Readonly<{ versionNumber: number }>;
}>;
type CatalogKey = "recent" | "archived";
type LoadState = "idle" | "loading" | "ready" | "error";
type State = {
  accountId: string | null;
  data: Record<CatalogKey, readonly ArtifactLibraryItem[] | null>;
  loadState: Record<CatalogKey, LoadState>;
  errors: Record<CatalogKey, string | null>;
  mutations: Readonly<Record<string, boolean>>;
};
const initialState = (): State => ({ accountId: null, data: { recent: null, archived: null },
  loadState: { recent: "idle", archived: "idle" }, errors: { recent: null, archived: null }, mutations: {} });
export const useArtifactLibraryStore = create<State>(initialState);
let epoch = 0;
const requests = new Map<CatalogKey, { controller: AbortController; promise: Promise<void> }>();

function validId(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 128 && !/[\u0000-\u001f\u007f]/u.test(value);
}

export function decodeArtifactLibraryItems(value: unknown): ArtifactLibraryItem[] {
  const invalid = () => new Error("The artifact list could not be read. Try again.");
  if (!Array.isArray(value)) throw invalid();
  return value.map((item: unknown) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) throw invalid();
    const row = item as Record<string, unknown>;
    const version = row.version as Record<string, unknown> | null;
    if (!validId(row.id) || typeof row.title !== "string" || !ARTIFACT_KINDS.includes(row.kind as ArtifactKind) ||
      !validId(row.currentVersionId) || row.sourceChatId !== null && !validId(row.sourceChatId) ||
      !Number.isSafeInteger(row.publicationCount) || Number(row.publicationCount) < 0 ||
      typeof row.updatedAt !== "string" || !Number.isFinite(Date.parse(row.updatedAt)) ||
      !version || !Number.isSafeInteger(version.versionNumber) || Number(version.versionNumber) < 1) throw invalid();
    if (row.byteSize !== undefined && (!Number.isSafeInteger(row.byteSize) || Number(row.byteSize) < 0)) throw invalid();
    return { id: row.id, title: row.title, kind: row.kind as ArtifactKind, currentVersionId: row.currentVersionId,
      sourceChatId: row.sourceChatId as string | null, publicationCount: Number(row.publicationCount),
      updatedAt: row.updatedAt, version: { versionNumber: Number(version.versionNumber) },
      ...(row.byteSize === undefined ? {} : { byteSize: Number(row.byteSize) }) };
  });
}

export function activateArtifactLibraryAccount(accountId: string | null): void {
  if (useArtifactLibraryStore.getState().accountId === accountId) return;
  epoch += 1;
  for (const request of requests.values()) request.controller.abort();
  requests.clear();
  useArtifactLibraryStore.setState({ ...initialState(), accountId }, true);
}

export async function refreshArtifactLibrary(archived = false, force = false): Promise<void> {
  const key: CatalogKey = archived ? "archived" : "recent";
  const current = useArtifactLibraryStore.getState();
  if (!current.accountId || !force && current.loadState[key] === "ready") return;
  const pending = requests.get(key);
  if (pending && !force) return pending.promise;
  pending?.controller.abort();
  const controller = new AbortController();
  const generation = epoch;
  useArtifactLibraryStore.setState(state => ({ loadState: { ...state.loadState, [key]: "loading" }, errors: { ...state.errors, [key]: null } }));
  const promise = artifactRequest(`/api/artifacts?archived=${archived}`, { signal: controller.signal })
    .then(body => {
      const data = decodeArtifactLibraryItems(body.artifacts);
      if (generation === epoch && !controller.signal.aborted) useArtifactLibraryStore.setState(state => ({
        data: { ...state.data, [key]: data }, loadState: { ...state.loadState, [key]: "ready" }
      }));
    }).catch((error: unknown) => {
      if (generation === epoch && !controller.signal.aborted) useArtifactLibraryStore.setState(state => ({
        errors: { ...state.errors, [key]: error instanceof Error ? error.message : "Could not load artifacts." },
        loadState: { ...state.loadState, [key]: "error" }
      }));
    }).finally(() => { if (requests.get(key)?.controller === controller) requests.delete(key); });
  requests.set(key, { controller, promise });
  return promise;
}

/** Mutation invalidates any earlier read before applying refreshed server truth. */
export async function mutateArtifactLibrary(id: string, change: { title: string } | { archived: boolean } | "delete" | "duplicate"): Promise<ArtifactLibraryItem | void> {
  const state = useArtifactLibraryStore.getState();
  if (!state.accountId || state.mutations[id]) return;
  const generation = epoch;
  useArtifactLibraryStore.setState({ mutations: { ...state.mutations, [id]: true } });
  try {
    const body = await artifactRequest(`/api/artifacts/${encodeURIComponent(id)}${change === "duplicate" ? "/duplicate" : ""}`,
      change === "duplicate" ? { method: "POST" } : change === "delete" ? { method: "DELETE" } : {
      method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify(change)
    });
    if (change === "delete") await deleteArtifactSavedState(id);
    if (generation !== epoch) return;
    const duplicate = change === "duplicate" ? decodeArtifactLibraryItems([body.artifact])[0] : undefined;
    const archivedLoaded = useArtifactLibraryStore.getState().data.archived !== null;
    await Promise.all([refreshArtifactLibrary(false, true), ...(archivedLoaded ? [refreshArtifactLibrary(true, true)] : [])]);
    if (generation === epoch && duplicate) {
      useArtifactLibraryStore.setState(current => ({ data: { ...current.data,
        recent: [duplicate, ...(current.data.recent ?? []).filter(item => item.id !== duplicate.id)] } }));
      return duplicate;
    }
  } finally {
    if (generation === epoch) useArtifactLibraryStore.setState(current => ({ mutations: { ...current.mutations, [id]: false } }));
  }
}
