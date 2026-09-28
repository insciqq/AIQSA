"use client";

import { UiV2Icon } from "@/components/ui-v2";
import { AssistantAvatarV2 } from "@/components/ui-v2/AssistantAvatarV2";
import type { AssistantAvatarRecipe, AssistantIdentity } from "@/lib/contracts/assistants";

/** An answer's accepted Assistant snapshot: null without one, undefined while unknown (a live answer before its re-read). */
type AnswerIdentitySource = Readonly<{ assistantIdentity?: AssistantIdentity | null }>;

export type AnswerIdentityV2 =
  | Readonly<{ avatar: AssistantAvatarRecipe; kind: "assistant"; label: string }>
  | Readonly<{ kind: "none"; label: "No Assistant" }>;

function sameAvatar(left: AssistantAvatarRecipe, right: AssistantAvatarRecipe): boolean {
  return left.kind === right.kind &&
    left.paletteId === right.paletteId &&
    left.recipeVersion === right.recipeVersion &&
    left.backgroundShape === right.backgroundShape &&
    left.foregroundShape === right.foregroundShape &&
    left.rotations[0] === right.rotations[0] &&
    left.rotations[1] === right.rotations[1] &&
    left.accents.length === right.accents.length &&
    left.accents.every((accent, index) => accent === right.accents[index]);
}

function sameIdentity(left: AssistantIdentity | null, right: AssistantIdentity | null): boolean {
  if (!left || !right) return left === right;
  return left.name === right.name && sameAvatar(left.avatar, right.avatar);
}

/**
 * The identity chip shows only where the Assistant changes (PRD 10.6):
 * on the first answer of the branch when it has an Assistant, and wherever
 * the `{name, avatar}` snapshot differs from the previous visible answer's,
 * including a change to no Assistant ("No Assistant"). Accepted snapshots
 * carry no id, so a renamed Assistant counts as a change. An answer whose
 * snapshot is still unknown shows nothing until its re-read settles it.
 * Provider, raw model, revision and opaque ids never become answer chrome.
 */
export function answerIdentityV2(
  message: AnswerIdentitySource,
  previous: AnswerIdentitySource | null
): AnswerIdentityV2 | null {
  const identity = message.assistantIdentity;
  if (identity === undefined) return null;
  const previousIdentity = previous?.assistantIdentity ?? null;
  if (previous ? sameIdentity(identity, previousIdentity) : !identity) return null;
  return identity
    ? { avatar: identity.avatar, kind: "assistant", label: identity.name }
    : { kind: "none", label: "No Assistant" };
}

/**
 * The previous visible answer with a known snapshot for every answer of the
 * branch, keyed by answer id; null for the branch's first such answer.
 */
export function previousVisibleAnswersV2<Message extends AnswerIdentitySource & Readonly<{ id: string; role: string }>>(
  messages: readonly Message[]
): ReadonlyMap<string, Message | null> {
  const previousById = new Map<string, Message | null>();
  let previous: Message | null = null;
  for (const message of messages) {
    if (message.role !== "assistant") continue;
    previousById.set(message.id, previous);
    if (message.assistantIdentity !== undefined) previous = message;
  }
  return previousById;
}

/** Quiet lead of an answer: avatar and name, or the neutral "No Assistant". */
export function AnswerIdentityChipV2({ identity }: Readonly<{ identity: AnswerIdentityV2 }>) {
  return (
    <div className="v2-answer-lead">
      <span className="v2-answer-identity" data-identity={identity.kind} data-testid="answer-assistant-identity">
        {identity.kind === "assistant"
          ? <AssistantAvatarV2 recipe={identity.avatar} size={20} />
          : <span className="v2-answer-identity-none" aria-hidden="true"><UiV2Icon name="assistant" /></span>}
        <span>{identity.label}</span>
      </span>
    </div>
  );
}
