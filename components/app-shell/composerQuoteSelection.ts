import { appendSelectionQuote } from "@/components/chat/renderedMarkdown";
import { RUN_FOLLOWUP_MAX_CHARS } from "@/lib/contracts/runFollowups";
import { useComposerSessionStore, type ComposerSessionKey } from "./composerSessionStore";
import { buildComposerMessage } from "./composerComments";

export function quoteSelectionInComposer(input: Readonly<{
  followup: boolean;
  markdown: string;
  sessionKey: ComposerSessionKey;
}>): string | null {
  const store = useComposerSessionStore.getState();
  const session = store.sessionsByKey[input.sessionKey];
  if (store.activeSessionKey !== input.sessionKey || !session || session.editingMessageId) {
    return "Finish editing or return to this conversation to quote its text.";
  }
  const draft = appendSelectionQuote(session.draft, input.markdown);
  if (input.followup && buildComposerMessage(draft, session.comments).length > RUN_FOLLOWUP_MAX_CHARS) {
    return `The quote would exceed the ${RUN_FOLLOWUP_MAX_CHARS.toLocaleString("en-US")}-character follow-up limit. Shorten the draft or select less text.`;
  }
  store.updateSession(input.sessionKey, { draft });
  return null;
}
