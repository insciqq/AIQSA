import type { ConnectorRunAnswer } from "../../connectors/runGateway";
import { DISCORD_COPY, discordFailureStatus } from "../copy";
import { discordInlineText, DISCORD_MESSAGE_MAX_CHARS, renderDiscordAnswer } from "../render";
import type { DiscordLinkButton } from "../rest";
import type { DiscordUploadFile } from "../transport";
import type { DiscordFinalMessage } from "./status";

/**
 * The final Discord message of an answer (PRD D-20, D-21, D-22, O-18): the
 * model's Markdown rendered into at most 2000 characters with every secret
 * replaced first; an answer that had to be cut gets an **Open in AIQSA** link
 * button to a read-only share of the chat at that answer (or the link as a
 * line, where the installation has no https address). Answer files and their
 * "only in AIQSA" line come from the files hook (`lib/server/discord/files.ts`).
 */

export type DiscordAnswerFiles = Readonly<{
  files: readonly DiscordUploadFile[];
  /** A line under the answer, such as "2 files are only in AIQSA". */
  note: string | null;
  /** The line in place of `note` when Discord refuses the files (every file stays in AIQSA); the answer then goes without them. */
  fallbackNote?: string | null;
}>;

/** Outgoing files of a delivered answer (`dc-files`); the default attaches nothing. */
export type DiscordAnswerFilesHook = (input: Readonly<{
  userId: string;
  chatId: string;
  runId: string;
  answer: ConnectorRunAnswer;
  test: boolean;
}>) => Promise<DiscordAnswerFiles>;

export const discordNoAnswerFiles: DiscordAnswerFilesHook = async () => ({ files: [], note: null });

export type DiscordComposedAnswer = DiscordFinalMessage & Readonly<{
  truncated: boolean;
  /** Whether the share link went with it. */
  shared: boolean;
  redactions: number;
}>;

/** A share link of the chat at the answer: an absolute URL, or null when none could be made. */
export type DiscordShareLink = () => Promise<string | null>;

export async function composeDiscordAnswer(input: Readonly<{
  answer: Pick<ConnectorRunAnswer, "text" | "artifactSummary">;
  share: DiscordShareLink;
  files: DiscordAnswerFiles;
}>): Promise<DiscordComposedAnswer> {
  const note = input.files.note ? discordInlineText(input.files.note, 200) : null;
  const fallback = input.files.files.length > 0 && input.files.fallbackNote ? discordInlineText(input.files.fallbackNote, 200) : null;
  const reserve = Math.max(note?.content ? note.content.length + 2 : 0, fallback?.content ? fallback.content.length + 2 : 0);
  const rendered = renderDiscordAnswer({
    citations: input.answer.artifactSummary?.citations ?? [], markdown: input.answer.text, maxChars: DISCORD_MESSAGE_MAX_CHARS, reserve
  });
  const redactions = rendered.redactions + (note?.redactions ?? 0);
  let content = rendered.content;
  let buttons: (readonly DiscordLinkButton[])[] | undefined;
  let shared = false;
  if (rendered.truncated) {
    const url = await input.share().catch(() => null);
    if (url && url.startsWith("https://") && url.length <= 512) {
      buttons = [[{ label: DISCORD_COPY.openInAiqsa, url }]];
      shared = true;
    } else if (url) {
      // A plain-http installation: Discord's link buttons need https, so the link rides as a line, preview suppressed.
      const line = `${DISCORD_COPY.openInAiqsa}: <${url}>`;
      if (content.length + line.length + 2 + reserve <= DISCORD_MESSAGE_MAX_CHARS) {
        content = `${content}\n\n${line}`;
        shared = true;
      }
    }
  }
  // Discord may refuse the files (no Attach Files permission, a file it will not take): the answer then goes alone.
  const withoutFiles = fallback?.content ? (content ? `${content}\n\n${fallback.content}` : fallback.content) : undefined;
  if (note?.content) content = content ? `${content}\n\n${note.content}` : note.content;
  // A complete answer with nothing to show is no answer: the question is not left blank.
  if (!content.trim() && input.files.files.length === 0) content = discordFailureStatus(DISCORD_COPY.somethingWrong);
  return {
    ...(buttons ? { buttons } : {}), content, ...(input.files.files.length > 0 ? { files: input.files.files } : {}), redactions,
    shared, truncated: rendered.truncated, ...(withoutFiles !== undefined ? { withoutFiles } : {})
  };
}
