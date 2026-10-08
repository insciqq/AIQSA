import { ANSWER_REVISION_REQUEST_KIND } from "../contracts/answerReviews";

export type AnswerReviewTranscriptMessage = Readonly<{
  answerReviewSessionId?: string | null;
  id: string;
  parentId: string | null;
  role: string;
  status: string;
  systemTurnKind?: string | null;
}>;

export type AnswerReviewTranscriptSession = Readonly<{ id: string; sourceAssistantMessageId: string }>;

/** How a transcript reads with each answer review session collapsed into its latest version. */
export type AnswerReviewCollapse = Readonly<{
  /** Kept messages whose parent changed: the version takes its source answer's place. */
  parents: ReadonlyMap<string, string | null>;
  /** Messages that leave the transcript. */
  removed: ReadonlySet<string>;
  /** The kept version standing for each removed message. */
  replacements: ReadonlyMap<string, string>;
}>;

/**
 * Each answer review session read as one answer: its source question
 * followed only by the group's latest version, the newest complete revision
 * or else the source answer. The session's server-written turns, its review
 * answers and superseded versions leave; a later message whose parent left
 * hangs from the version. `keepSessionId` is left whole (a step of that
 * session sees its full chain) and `keepMessageIds` never leave (a run's own
 * current turn). A source answer outside `messages` leaves its session whole.
 */
export function collapseAnswerReviews(
  messages: readonly AnswerReviewTranscriptMessage[],
  sessions: readonly AnswerReviewTranscriptSession[],
  options: Readonly<{ keepMessageIds?: ReadonlySet<string>; keepSessionId?: string | null }> = {}
): AnswerReviewCollapse {
  const byId = new Map(messages.map((message) => [message.id, message]));
  const removed = new Set<string>();
  const parents = new Map<string, string | null>();
  const replacements = new Map<string, string>();
  /** How far a version lies below its source answer; -1 when it does not descend from it. */
  const depthFrom = (sourceId: string, message: AnswerReviewTranscriptMessage): number => {
    const seen = new Set<string>();
    let depth = 0;
    for (let current: AnswerReviewTranscriptMessage | undefined = message; current;
      current = current.parentId ? byId.get(current.parentId) : undefined) {
      if (current.id === sourceId) return depth;
      if (seen.has(current.id)) return -1;
      seen.add(current.id);
      depth += 1;
    }
    return -1;
  };
  for (const session of sessions) {
    if (session.id === options.keepSessionId) continue;
    const source = byId.get(session.sourceAssistantMessageId);
    if (!source) continue;
    const members = messages.filter((message) => message.answerReviewSessionId === session.id);
    const versions = members.filter((message) => {
      const parent = message.parentId ? byId.get(message.parentId) : undefined;
      return message.role === "assistant" && message.status === "complete" &&
        parent?.answerReviewSessionId === session.id && parent.systemTurnKind === ANSWER_REVISION_REQUEST_KIND;
    });
    let latest = source;
    let latestDepth = 0;
    for (const version of versions) {
      const depth = depthFrom(source.id, version);
      if (depth > latestDepth) {
        latest = version;
        latestDepth = depth;
      }
    }
    for (const member of [source, ...members]) {
      if (member.id === latest.id || options.keepMessageIds?.has(member.id)) continue;
      removed.add(member.id);
      replacements.set(member.id, latest.id);
    }
    if (latest.id !== source.id && removed.has(source.id)) parents.set(latest.id, source.parentId);
  }
  for (const message of messages) {
    if (removed.has(message.id) || parents.has(message.id) || !message.parentId || !removed.has(message.parentId)) continue;
    parents.set(message.id, replacements.get(message.parentId) ?? null);
  }
  return { parents, removed, replacements };
}
