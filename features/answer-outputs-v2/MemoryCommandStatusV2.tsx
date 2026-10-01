"use client";

import { memoryUiCopy } from "@/components/app-shell/memoryUiCopy";
import { UiV2Button } from "@/components/ui-v2";
import type { MemoryCommandFeedback } from "@/lib/contracts/memoryCommand";

type VisibleMemoryCommand = MemoryCommandFeedback & Readonly<{
  status: "AMBIGUOUS" | "COMMITTED" | "PENDING" | "RUNNING";
}>;

/** Users see only recognized pending work, a committed receipt or a needed
 * choice; failed, unknown, stale and rejected outcomes stay silent. */
export function memoryCommandIsVisible(command: MemoryCommandFeedback): command is VisibleMemoryCommand {
  return command.operation !== "UNKNOWN" &&
    (command.status === "PENDING" || command.status === "RUNNING" ||
      command.status === "COMMITTED" || command.status === "AMBIGUOUS");
}

function message(command: VisibleMemoryCommand): string {
  switch (command.status) {
    case "PENDING":
    case "RUNNING": return memoryUiCopy("command.pending");
    case "COMMITTED": return memoryUiCopy(command.operation === "SAVE"
      ? "action.saved" : command.operation === "UPDATE" ? "action.updated" : "action.forgotten");
    case "AMBIGUOUS": return memoryUiCopy("command.ambiguous");
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
