import type { Prisma } from "@prisma/client";
import { decodeThreadGeneratedImage, type ThreadGeneratedImage } from "../../contracts/imageGeneration";

/**
 * The images an answer lists: its own run's image outputs, and those its background sub-agents drew. A background
 * sub-agent's own run answers nothing, so its image joins the answer of the main-agent run behind its turn
 * (`runBindingOwner`, `lib/server/images/service.ts`), as a foreground sub-agent's does in that run itself. Reached only
 * through the turns that run started, one level of children included (`lib/server/subagents/nesting.ts`), and only those
 * on that answer's message, such an image is never another answer's, chat's or user's.
 */

const IMAGE_OUTPUTS = {
  orderBy: [{ createdAt: "asc" }, { id: "asc" }],
  select: { createdAt: true, id: true, messageId: true, metadata: true, origin: true },
  where: { origin: "IMAGE_OUTPUT" }
} satisfies Prisma.AttachmentFindManyArgs;

/** What an answer's run selects, beside its own produced attachments, for the images its background sub-agents drew. */
export const BACKGROUND_SUBAGENT_IMAGES_SELECT = {
  subagentTurnsStarted: { select: { executionRun: { select: {
    subagentTurnsStarted: { select: { executionRun: { select: { workspaceProducedAttachments: IMAGE_OUTPUTS } } }, where: { mode: "background" } },
    workspaceProducedAttachments: IMAGE_OUTPUTS
  } } }, where: { mode: "background" } }
} satisfies Prisma.ModelRunSelect;

type ImageRow = Readonly<{ createdAt?: Date; id: string; messageId?: string | null; metadata?: unknown; origin?: string }>;
type ImageTurn = Readonly<{
  executionRun: Readonly<{ subagentTurnsStarted?: readonly ImageTurn[]; workspaceProducedAttachments: readonly ImageRow[] }> | null;
}>;

/** An answer's run as `answerGeneratedImages` reads it; without `BACKGROUND_SUBAGENT_IMAGES_SELECT`, its own images alone. */
export type AnswerImageRun = Readonly<{
  assistantMessageId?: string | null;
  subagentTurnsStarted?: readonly ImageTurn[];
  workspaceProducedAttachments?: readonly ImageRow[];
}>;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** An answer's generated images in the order they were made, each once. */
export function answerGeneratedImages(run: AnswerImageRun): ThreadGeneratedImage[] {
  const own = (run.workspaceProducedAttachments ?? []).filter((row) => row.origin === "IMAGE_OUTPUT");
  const answer = run.assistantMessageId;
  const drawn = (turns: readonly ImageTurn[]): ImageRow[] => turns.flatMap((turn) => turn.executionRun
    ? [...turn.executionRun.workspaceProducedAttachments.filter((row) => row.origin === "IMAGE_OUTPUT" && row.messageId === answer),
      ...drawn(turn.executionRun.subagentTurnsStarted ?? [])]
    : []);
  const background = answer ? drawn(run.subagentTurnsStarted ?? []) : [];
  const seen = new Set(own.map((row) => row.id));
  const rows = background.length === 0 ? own : [...own, ...background.filter((row) => !seen.has(row.id) && Boolean(seen.add(row.id)))]
    .sort((a, b) => (a.createdAt?.getTime() ?? 0) - (b.createdAt?.getTime() ?? 0) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return rows.flatMap((row) => {
    const image = isRecord(row.metadata) ? decodeThreadGeneratedImage(row.metadata.image) : null;
    return image && image.attachmentId === row.id ? [image] : [];
  });
}
