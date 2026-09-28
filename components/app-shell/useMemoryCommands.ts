"use client";

import { useEffect, useState } from "react";
import { decodeMemoryCommandListResponse, memoryCommandIsPending, type MemoryCommandFeedback } from "@/lib/contracts/memoryCommand";

const EMPTY = new Map<string, MemoryCommandFeedback>();

/** Polls the independent command projection only while a background command
 * remains pending. Navigation/account changes discard any late response. */
export function useMemoryCommands(input: Readonly<{
  accountId: string | null;
  chatId: string | null;
  enabled: boolean;
  messageKey: string;
}>): ReadonlyMap<string, MemoryCommandFeedback> {
  const { accountId, chatId, enabled, messageKey } = input;
  const scope = `${accountId ?? ""}:${chatId ?? ""}`;
  const [state, setState] = useState<Readonly<{ scope: string; commands: ReadonlyMap<string, MemoryCommandFeedback> }> | null>(null);
  useEffect(() => {
    if (!accountId || !chatId || !enabled || !messageKey) return;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let failures = 0;
    let emptyPolls = 0;
    const currentMessageId = messageKey.split(",").filter(Boolean).at(-1);
    async function poll() {
      try {
        const response = await fetch(`/api/me/chats/${encodeURIComponent(chatId!)}/memory-commands`, {
          cache: "no-store", credentials: "same-origin", signal: controller.signal
        });
        if (controller.signal.aborted) return;
        if (response.status === 401 || response.status === 403 || response.status === 404) {
          setState({ scope, commands: EMPTY });
          return;
        }
        if (!response.ok) throw new Error("memory_commands_unavailable");
        const result = decodeMemoryCommandListResponse(await response.json());
        if (!result) throw new Error("memory_commands_invalid");
        if (controller.signal.aborted) return;
        setState({ scope, commands: new Map(result.commands.map(({ messageId, feedback }) => [messageId, feedback])) });
        failures = 0;
        const currentMessageHasCommand = result.commands.some(({ messageId }) =>
          messageId === currentMessageId);
        if (currentMessageHasCommand) emptyPolls = 0;
        const commandPending = result.commands.some(({ feedback }) => memoryCommandIsPending(feedback));
        // Acceptance and command enqueue commit together, but the first poll
        // can race that commit or the persisted message-id refresh. Allow a
        // short bounded grace window without keeping a chat on a hot poll.
        if (commandPending || (!currentMessageHasCommand && emptyPolls++ < 3)) {
          timer = setTimeout(() => void poll(), 1_500);
        }
      } catch {
        if (!controller.signal.aborted && ++failures <= 3) {
          timer = setTimeout(() => void poll(), 3_000);
        }
      }
    }
    void poll();
    return () => { controller.abort(); if (timer) clearTimeout(timer); };
  }, [accountId, chatId, enabled, messageKey, scope]);
  return enabled && state?.scope === scope ? state.commands : EMPTY;
}
