"use client";

import { memoryUiCopy } from "@/components/app-shell/memoryUiCopy";
import { UiV2Button } from "@/components/ui-v2";
import { memoryCommandSaveNotCommitted, type MemoryCommandFeedback } from "@/lib/contracts/memoryCommand";

/** Users see recognized pending work, a committed receipt, a needed choice,
 * and an explicit save that committed nothing (operator decision 2026-10-25).
 * Every other failed, unknown, stale and rejected outcome stays silent. */
export function memoryCommandIsVisible(command: MemoryCommandFeedback): boolean {
  return command.operation !== "UNKNOWN" &&
    (command.status === "PENDING" || command.status === "RUNNING" ||
      command.status === "COMMITTED" || command.status === "AMBIGUOUS" ||
      memoryCommandSaveNotCommitted(command));
}

function message(command: MemoryCommandFeedback): string {
  switch (command.status) {
    case "PENDING":
    case "RUNNING": return memoryUiCopy("command.pending");
    case "COMMITTED": return memoryUiCopy(command.operation === "SAVE"
      ? "action.saved" : command.operation === "UPDATE" ? "action.updated" : "action.forgotten");
    case "AMBIGUOUS": return memoryUiCopy("command.ambiguous");
    case "FAILED":
    case "REJECTED":
    case "STALE":
    case "UNKNOWN": return memoryUiCopy("command.notSaved");
  }
}

export function MemoryCommandStatusV2({ command, onOpenMemory }: Readonly<{
  command: MemoryCommandFeedback;
  onOpenMemory?(): void;
}>) {
  if (!memoryCommandIsVisible(command)) return null;
  const pending = command.status === "PENDING" || command.status === "RUNNING";
  return (
    <aside className="v2-memory-action-confirmation v2-memory-command-status"
      data-status={command.status} data-testid="memory-command-status" role="status">
      <p>{message(command)}</p>
      {!pending && onOpenMemory ? (
        <UiV2Button onClick={onOpenMemory}>
          {memoryUiCopy("settings.manageLabel")}
        </UiV2Button>
      ) : null}
    </aside>
  );
}
