import { useCallback, useEffect, useRef, useState } from "react";
import { decodeWorkspaceExportPage, type WorkspaceExportEntry } from "@/lib/contracts/workspaceExports";
import { shellFetch } from "./shellApi";

type State = { busy: boolean; error: boolean; exports: readonly WorkspaceExportEntry[]; nextCursor: string | null; source: string };

export function useWorkspaceExports(chatId: string, branchKey: string | null) {
  const source = `${chatId}\u0000${branchKey ?? ""}`;
  const [state, setState] = useState<State>({ busy: true, error: false, exports: [], nextCursor: null, source });
  const request = useRef<AbortController | null>(null);
  const load = useCallback((cursor: string | null) => {
    request.current?.abort();
    const controller = new AbortController();
    request.current = controller;
    const readPage = async () => {
      const suffix = cursor ? `?cursor=${encodeURIComponent(cursor)}` : "";
      const response = await shellFetch(`/api/chats/${encodeURIComponent(chatId)}/workspace/exports${suffix}`, { signal: controller.signal });
      const page = decodeWorkspaceExportPage(await response.json().catch(() => null));
      if (!response.ok || !page) throw new Error("export_history_unavailable");
      return page;
    };
    void readPage().then((page) => {
      if (controller.signal.aborted) return;
      setState((current) => ({
        busy: false, error: false, source,
        exports: cursor ? [...current.exports, ...page.exports.filter((entry) => !current.exports.some((old) => old.messageId === entry.messageId))] : page.exports,
        nextCursor: page.nextCursor
      }));
    }, () => {
      if (!controller.signal.aborted) setState((current) => ({
        busy: false, error: true, source, nextCursor: cursor,
        exports: current.source === source ? current.exports : []
      }));
    });
  }, [chatId, source]);
  useEffect(() => {
    void load(null);
    return () => request.current?.abort();
  }, [load]);
  const current = state.source === source ? state : { busy: true, error: false, exports: [], nextCursor: null, source };
  return {
    ...current,
    refresh() {
      setState((value) => ({ ...value, busy: true, error: false }));
      void load(null);
    },
    loadMore() {
      if (current.busy || !current.nextCursor) return;
      setState((value) => ({ ...value, busy: true, error: false }));
      void load(current.nextCursor);
    }
  };
}
