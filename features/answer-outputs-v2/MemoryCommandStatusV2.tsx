"use client";

import { memoryUiCopy } from "@/components/app-shell/memoryUiCopy";
import { UiV2Button } from "@/components/ui-v2";
import type { MemoryCommandFeedback } from "@/lib/contracts/memoryCommand";

function message(command: MemoryCommandFeedback): string {
  switch (command.status) {
    case "PENDING":
    case "RUNNING": return memoryUiCopy("command.pending");
    case "COMMITTED": return memoryUiCopy(command.operation === "SAVE"
      ? "action.saved" : command.operation === "UPDATE" ? "action.updated" : "action.forgotten");
    case "REJECTED": return memoryUiCopy("command.rejected");
    case "AMBIGUOUS": return memoryUiCopy("command.ambiguous");
    case "FAILED": return memoryUiCopy("command.failed");
    case "UNKNOWN": return memoryUiCopy("command.unknown");
    case "STALE": return memoryUiCopy("command.stale");
  }
}

export function MemoryCommandStatusV2({ command, onOpenMemory }: Readonly<{
  command: MemoryCommandFeedback;
  onOpenMemory?(): void;
}>) {
  // Ordinary messages stay quiet; an interrupted classifier still needs an
  // honest terminal notice, even when its operation could not be established.
  if (command.operation === "UNKNOWN" &&
    ["PENDING", "RUNNING", "REJECTED"].includes(command.status)) return null;
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
