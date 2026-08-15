import { useAssistantLibraryStore } from "@/components/app-shell/assistantLibraryStore";
import { deactivateArchivedChats } from "@/components/app-shell/archivedChatsStore";
import { useComposerControlStore } from "@/components/app-shell/composerControlStore";
import { useComposerSessionStore } from "@/components/app-shell/composerSessionStore";
import { useKnowledgeLibraryStore } from "@/components/app-shell/knowledgeLibraryStore";
import { deactivateMcpSettings } from "@/components/app-shell/mcpSettingsStore";
import { deactivateMemoryHealthAccount } from "@/components/app-shell/memoryHealthStore";
import { deactivateMemoryHistorySearchAccount } from "@/components/app-shell/memoryHistorySearchStore";
import { deactivateMemoryManager } from "@/components/app-shell/memoryManagerStore";
import { deactivateMemoryOperationsAccount } from "@/components/app-shell/memoryOperationsStore";
import { deactivateMemorySettings } from "@/components/app-shell/memorySettingsStore";
import { deactivatePermanentChatDeletionAccount } from "@/components/app-shell/permanentChatDeletionStore";
import { useRunLifecycleStore } from "@/components/app-shell/runLifecycleStore";
import { useRunSurfaceStore } from "@/components/app-shell/runSurfaceStore";
import { useThreadStore } from "@/components/app-shell/threadStore";
import { useWorkspaceStore } from "@/components/app-shell/workspaceStore";
import type { StoreApi } from "zustand";

function resetZustandStore<State>(store: Pick<StoreApi<State>, "getInitialState" | "setState">) {
  store.setState(store.getInitialState(), true);
}

export function resetAssistantLibraryStoreForTest(): void {
  resetZustandStore(useAssistantLibraryStore);
}

export function resetArchivedChatsStoreForTest(): void {
  deactivateArchivedChats();
}

export function resetComposerControlStoreForTest(): void {
  resetZustandStore(useComposerControlStore);
}

export function resetComposerSessionStoreForTest(): void {
  resetZustandStore(useComposerSessionStore);
}

export function resetKnowledgeLibraryStoreForTest(): void {
  resetZustandStore(useKnowledgeLibraryStore);
}

export function resetMcpSettingsStoreForTest(): void {
  deactivateMcpSettings();
}

export function resetMemoryHealthStoreForTest(): void {
  deactivateMemoryHealthAccount();
}

export function resetMemoryHistorySearchStoreForTest(): void {
  deactivateMemoryHistorySearchAccount();
}

export function resetMemoryManagerStoreForTest(): void {
  deactivateMemoryManager();
}

export function resetMemoryOperationsStoreForTest(): void {
  deactivateMemoryOperationsAccount();
  if (typeof window !== "undefined") {
    for (let index = window.sessionStorage.length - 1; index >= 0; index -= 1) {
      const key = window.sessionStorage.key(index);
      if (key?.startsWith("aiqsa:memory:operations:v3:")) {
        window.sessionStorage.removeItem(key);
      }
    }
  }
}

export function resetMemorySettingsStoreForTest(): void {
  deactivateMemorySettings();
}

export function resetPermanentChatDeletionStoreForTest(): void {
  deactivatePermanentChatDeletionAccount();
}

export function resetRunLifecycleStoreForTest(): void {
  resetZustandStore(useRunLifecycleStore);
}

export function resetRunSurfaceStoreForTest(): void {
  resetZustandStore(useRunSurfaceStore);
}

export function resetThreadStoreForTest(): void {
  resetZustandStore(useThreadStore);
}

export function resetWorkspaceStoreForTest(): void {
  resetZustandStore(useWorkspaceStore);
}
