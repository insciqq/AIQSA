/**
 * Answer Review is removed (operator decision 2026-10-25). A session recorded
 * before then (`AnswerReviewSession`, its steps' `Message.answerReviewSessionId`)
 * stays readable through this one read-only projection: it reads as its
 * source question followed only by its latest version, never its steps.
 */

/** The server-written turns of a session's steps (`MessageSystemTurnKind`); nothing writes them any more. */
export const ANSWER_REVIEW_REQUEST_KIND = "answer_review_request";
export const ANSWER_REVISION_REQUEST_KIND = "answer_revision_request";

export function isAnswerReviewTurnKind(value: unknown): boolean {
  return value === ANSWER_REVIEW_REQUEST_KIND || value === ANSWER_REVISION_REQUEST_KIND;
}

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
 * followed only by the group's latest version, the deepest complete revision
 * answer or else the source answer. A revision answer is any answer to one of
 * the session's revision requests, whatever its own session: the previous
 * release regenerated a version as a copy without one. The session's
 * server-written turns, its review answers and its other revision answers
 * leave; a later message whose parent left hangs from the version, and a
 * version of a session started on another session's version stands where
 * that one's source answer stood. Versions at the same depth (siblings, which
 * only a list of more than one path holds) resolve to the later one in
 * `messages`. A source answer outside `messages` leaves its session whole.
 */
export function collapseAnswerReviews(
  messages: readonly AnswerReviewTranscriptMessage[],
  sessions: readonly AnswerReviewTranscriptSession[]
): AnswerReviewCollapse {
  const byId = new Map(messages.map((message) => [message.id, message]));
  const removed = new Set<string>();
  /** The session's latest version for each message it removed; that version may itself be a later session's source. */
  const latestOf = new Map<string, string>();
  /** The source answer each kept version stands in for. */
  const placeOf = new Map<string, string>();
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
  /** The session whose revision request a message answers, if it answers one. */
  const revisionSessionOf = (message: AnswerReviewTranscriptMessage): string | null => {
    const parent = message.role === "assistant" && message.parentId ? byId.get(message.parentId) : undefined;
    return parent?.answerReviewSessionId && parent.systemTurnKind === ANSWER_REVISION_REQUEST_KIND
      ? parent.answerReviewSessionId : null;
  };
  // Each session's members in one pass, in `messages` order: a chat's tree reads one path per leaf, so a per-session
  // scan of every message would grow with sessions × path length × leaves.
  const membersOf = new Map<string, AnswerReviewTranscriptMessage[]>();
  const addMember = (sessionId: string, message: AnswerReviewTranscriptMessage) => {
    const list = membersOf.get(sessionId);
    if (list) list.push(message);
    else membersOf.set(sessionId, [message]);
  };
  for (const message of messages) {
    const own = message.answerReviewSessionId ?? null;
    const revision = revisionSessionOf(message);
    if (own) addMember(own, message);
    if (revision && revision !== own) addMember(revision, message);
  }
  for (const session of sessions) {
    const source = byId.get(session.sourceAssistantMessageId);
    if (!source) continue;
    const isRevisionAnswer = (message: AnswerReviewTranscriptMessage) => revisionSessionOf(message) === session.id;
    const members = (membersOf.get(session.id) ?? []).filter((message) => message.id !== source.id);
    let latest = source;
    let latestDepth = 0;
    for (const member of members) {
      if (member.status !== "complete" || !isRevisionAnswer(member)) continue;
      const depth = depthFrom(source.id, member);
      if (depth > 0 && depth >= latestDepth) {
        latest = member;
        latestDepth = depth;
      }
    }
    for (const member of [source, ...members]) {
      if (member.id === latest.id) continue;
      removed.add(member.id);
      latestOf.set(member.id, latest.id);
    }
    if (latest.id !== source.id) placeOf.set(latest.id, source.id);
  }
  /** The kept message standing for a removed one, through every session that removed its stand-in in turn. */
  const keptFor = (id: string): string | null => {
    const seen = new Set<string>();
    let current: string | undefined = id;
    while (current !== undefined && removed.has(current)) {
      if (seen.has(current)) return null;
      seen.add(current);
      current = latestOf.get(current);
    }
    return current ?? null;
  };
  const replacements = new Map<string, string>();
  for (const id of removed) {
    const kept = keptFor(id);
    if (kept) replacements.set(id, kept);
  }
  /** Where a kept message reads: a version where its source answer stood, anything else under its parent's stand-in. */
  const visibleParent = (message: AnswerReviewTranscriptMessage): string | null => {
    const seen = new Set<string>([message.id]);
    let place = message;
    for (let source = placeOf.get(place.id); source !== undefined; source = placeOf.get(place.id)) {
      const next = byId.get(source);
      if (!next || seen.has(next.id)) break;
      seen.add(next.id);
      place = next;
    }
    if (!place.parentId) return null;
    const parent = removed.has(place.parentId) ? keptFor(place.parentId) : place.parentId;
    return parent === message.id ? null : parent;
  };
  const parents = new Map<string, string | null>();
  for (const message of messages) {
    if (removed.has(message.id)) continue;
    const parent = visibleParent(message);
    if (parent !== message.parentId) parents.set(message.id, parent);
  }
  return { parents, removed, replacements };
}

/**
 * A whole message tree read as its paths read: a message stays when the path
 * to some leaf, or to one of `leafIds` (the chat's active leaf, which may lie
 * above a leaf), keeps it, and each kept message hangs from the parent those
 * paths give it. A session's version thus stands in its source answer's
 * place among its question's answers.
 */
export function collapseAnswerReviewTree(
  messages: readonly AnswerReviewTranscriptMessage[],
  sessions: readonly AnswerReviewTranscriptSession[],
  leafIds: readonly string[] = []
): Omit<AnswerReviewCollapse, "replacements"> {
  const kept = new Set<string>();
  const parents = new Map<string, string | null>();
  if (sessions.length === 0) {
    return { parents, removed: new Set() };
  }
  const byId = new Map(messages.map((message) => [message.id, message]));
  const withChildren = new Set(messages.flatMap((message) => message.parentId ? [message.parentId] : []));
  const ends = new Set([...messages.filter((message) => !withChildren.has(message.id)).map((message) => message.id),
    ...leafIds.filter((id) => byId.has(id))]);
  for (const end of ends) {
    const path = pathTo(byId, end);
    const collapse = collapseAnswerReviews(path, sessions);
    for (const message of path) {
      if (collapse.removed.has(message.id)) continue;
      kept.add(message.id);
      if (collapse.parents.has(message.id)) parents.set(message.id, collapse.parents.get(message.id) ?? null);
    }
  }
  return { parents, removed: new Set(messages.flatMap((message) => kept.has(message.id) ? [] : [message.id])) };
}

/** The stored path from the root to `id`, as far as `byId` holds it. */
function pathTo(byId: ReadonlyMap<string, AnswerReviewTranscriptMessage>, id: string): AnswerReviewTranscriptMessage[] {
  const path: AnswerReviewTranscriptMessage[] = [];
  const seen = new Set<string>();
  for (let current = byId.get(id); current && !seen.has(current.id);
    current = current.parentId ? byId.get(current.parentId) : undefined) {
    seen.add(current.id);
    path.push(current);
  }
  return path.reverse();
}

/** What deleting a message removes, as stored subtrees; see `answerReviewDeletionPlan`. */
export type AnswerReviewDeletionPlan = Readonly<{
  /** The chat's leaf afterwards: unchanged unless the deletion takes it, then the deleted message's parent as read. */
  leafId: string | null;
  /** Roots of the stored subtrees to delete, none inside another. */
  roots: readonly string[];
}>;

/**
 * Deleting `targetId` as a reader sees the chat (`collapseAnswerReviewTree`
 * with its active leaf): it removes the target and what the chat shows below
 * it, together with the hidden steps above them that nothing shown would
 * hang from any more, up to a session's source answer when that answer is
 * hidden too. A stored ancestor whose subtree still holds a message the chat
 * shows elsewhere stays, and so does a target whose own subtree holds one (a
 * source answer shown beside its version): it leaves the view because what
 * kept it there goes, as a source answer shown only for a branch under one of
 * its steps does when that branch goes. Nothing hidden comes back into view,
 * and no target stays in it; null when no deletion achieves that, which no
 * session the previous release recorded leaves. A hidden target (a step a tab
 * of that release names) deletes its subtree and the hidden steps above it.
 */
export function answerReviewDeletionPlan(
  messages: readonly AnswerReviewTranscriptMessage[],
  sessions: readonly AnswerReviewTranscriptSession[],
  activeLeafId: string | null,
  targetId: string
): AnswerReviewDeletionPlan | null {
  const byId = new Map(messages.map((message) => [message.id, message]));
  if (!byId.has(targetId)) return null;
  const view = collapseAnswerReviewTree(messages, sessions, activeLeafId ? [activeLeafId] : []);
  const shown = (id: string) => byId.has(id) && !view.removed.has(id);
  const viewParent = (id: string): string | null =>
    view.parents.has(id) ? view.parents.get(id) ?? null : byId.get(id)?.parentId ?? null;
  const storedChildren = new Map<string, string[]>();
  const viewChildren = new Map<string, string[]>();
  for (const message of messages) {
    if (message.parentId) storedChildren.set(message.parentId, [...(storedChildren.get(message.parentId) ?? []), message.id]);
    const parent = shown(message.id) ? viewParent(message.id) : null;
    if (parent) viewChildren.set(parent, [...(viewChildren.get(parent) ?? []), message.id]);
  }
  const below = (start: string, children: ReadonlyMap<string, readonly string[]>): Set<string> => {
    const found = new Set<string>([start]);
    for (const queue = [start]; queue.length > 0;) {
      for (const child of children.get(queue.shift()!) ?? []) {
        if (found.has(child)) continue;
        found.add(child);
        queue.push(child);
      }
    }
    return found;
  };
  const targetShown = shown(targetId);
  // What the reader deletes: the target with what the chat shows below it.
  const targets = targetShown ? below(targetId, viewChildren)
    : new Set([...below(targetId, storedChildren)].filter(shown));
  // Every stored ancestor of a message the chat keeps showing must stay.
  const holdsShown = new Set<string>();
  for (const message of messages) {
    if (!shown(message.id) || targets.has(message.id)) continue;
    for (let id: string | null = message.id; id && !holdsShown.has(id); id = byId.get(id)?.parentId ?? null) holdsShown.add(id);
  }
  const rootFor = (start: string): string | null => {
    if (holdsShown.has(start)) return null;
    const seen = new Set<string>([start]);
    let root = start;
    for (let parent = byId.get(root)?.parentId ?? null; parent && byId.has(parent) && !holdsShown.has(parent) && !seen.has(parent);
      parent = byId.get(root)?.parentId ?? null) {
      seen.add(parent);
      root = parent;
    }
    return root;
  };
  const candidates = new Set<string>();
  for (const start of [targetId, ...targets]) {
    const root = rootFor(start);
    if (root) candidates.add(root);
  }
  const deleted = new Set<string>();
  for (const root of candidates) for (const id of below(root, storedChildren)) deleted.add(id);
  const roots = [...candidates].filter((root) => {
    const parent = byId.get(root)?.parentId;
    return !parent || !deleted.has(parent);
  });
  let leafId = activeLeafId;
  if (activeLeafId && (deleted.has(activeLeafId) || targets.has(activeLeafId))) {
    if (targetShown) {
      leafId = viewParent(targetId);
    } else {
      leafId = null;
      const seen = new Set<string>([targetId]);
      for (let id = byId.get(targetId)?.parentId ?? null; id && !seen.has(id); id = byId.get(id)?.parentId ?? null) {
        seen.add(id);
        if (shown(id) && !targets.has(id) && !deleted.has(id)) {
          leafId = id;
          break;
        }
      }
    }
  }
  // The chat as it reads afterwards: no target in view, and nothing hidden back in it.
  const remaining = messages.filter((message) => !deleted.has(message.id));
  const after = collapseAnswerReviewTree(remaining, sessions.filter((session) => !deleted.has(session.sourceAssistantMessageId)),
    leafId ? [leafId] : []);
  for (const message of remaining) {
    if (!after.removed.has(message.id) && (targets.has(message.id) || !shown(message.id))) return null;
  }
  return { leafId, roots };
}
