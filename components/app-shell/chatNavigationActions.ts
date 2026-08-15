import {
  listChatNavigation,
  searchChatNavigation
} from "@/components/app-shell/chatNavigationApi";
import { useWorkspaceStore } from "@/components/app-shell/workspaceStore";

let listGeneration = 0;
let searchGeneration = 0;

function readableError(error: unknown): string {
  return error instanceof Error && error.message ? error.message : "chat_navigation_failed";
}

export async function loadChatNavigation(options: {
  append?: boolean;
  signal?: AbortSignal;
} = {}): Promise<boolean> {
  const append = options.append ?? false;
  const state = useWorkspaceStore.getState();
  if (state.navigationLoading || (append && !state.navigationNextCursor)) return false;
  const generation = ++listGeneration;
  state.setNavigationLoading(true);
  state.setNavigationError(null);
  try {
    const page = await listChatNavigation({
      cursor: append ? state.navigationNextCursor : null,
      signal: options.signal
    });
    if (generation !== listGeneration) return false;
    useWorkspaceStore.getState().applyNavigationPage(page, append);
    return true;
  } catch (error) {
    if (generation !== listGeneration || options.signal?.aborted) return false;
    const current = useWorkspaceStore.getState();
    current.setNavigationLoading(false);
    current.setNavigationError(readableError(error));
    return false;
  }
}

export async function loadChatNavigationSearch(options: {
  append?: boolean;
  query: string;
  signal?: AbortSignal;
}): Promise<boolean> {
  const query = options.query.trim();
  const append = options.append ?? false;
  const state = useWorkspaceStore.getState();
  if (!query || (append && !state.navigationSearchNextCursor)) return false;
  const generation = ++searchGeneration;
  if (!append) state.setNavigationSearchQuery(query);
  state.setNavigationSearchLoading(true);
  state.setNavigationSearchError(null);
  try {
    const page = await searchChatNavigation({
      cursor: append ? state.navigationSearchNextCursor : null,
      query,
      signal: options.signal
    });
    const current = useWorkspaceStore.getState();
    if (
      generation !== searchGeneration ||
      current.navigationSearchQuery !== query
    ) return false;
    current.applyNavigationSearchPage(page, append);
    return true;
  } catch (error) {
    if (generation !== searchGeneration || options.signal?.aborted) return false;
    const current = useWorkspaceStore.getState();
    current.setNavigationSearchLoading(false);
    current.setNavigationSearchError(readableError(error));
    return false;
  }
}

export function clearChatNavigationSearch(): void {
  searchGeneration += 1;
  useWorkspaceStore.getState().setNavigationSearchQuery("");
}
