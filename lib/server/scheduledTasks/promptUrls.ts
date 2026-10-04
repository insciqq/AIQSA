import { extractFetchUrls, fetchUrlDigest } from "../webFetch/urls";

/**
 * Which links in a scheduled task's prompt its runs may read with
 * `fetch_url`. A prompt's text authorizes nothing by itself: the model can
 * write one without confirmation (`create_scheduled_task`), so an injected
 * page could plant an attacker URL for the next unattended run. Every write
 * of a prompt therefore stores this snapshot with it, computed here and
 * nowhere else, and a scheduled run freezes it at admission.
 */
export const SCHEDULED_PROMPT_URL_LIMIT = 100;

/**
 * Who wrote the prompt text of one write. `owner`: the owner API (create, or
 * an edit that sends the prompt) — every link in it is the owner's. `tool`: a
 * chat tool writing for the owner — only links already authorized by
 * user-authored text of the creating run (`FetchUrlPlan.userUrlDigests`),
 * never Search results. Any future tool that writes or edits a prompt must
 * pass `tool` with its run's user digests.
 */
export type ScheduledPromptAuthorship =
  | Readonly<{ kind: "owner" }>
  | Readonly<{ kind: "tool"; userUrlDigests: readonly string[] }>;

declare const promptUrlDigestsBrand: unique symbol;
/** Digests only this module mints; the store refuses a prompt change without them. */
export type ScheduledPromptUrlDigests = readonly string[] & { readonly [promptUrlDigestsBrand]: true };

export function scheduledPromptUrlDigests(prompt: string, authorship: ScheduledPromptAuthorship): ScheduledPromptUrlDigests {
  const allowed = authorship.kind === "tool" ? new Set(authorship.userUrlDigests) : null;
  const digests: string[] = [];
  for (const url of extractFetchUrls(prompt)) {
    const digest = fetchUrlDigest(url);
    if (allowed && !allowed.has(digest)) continue;
    digests.push(digest);
    if (digests.length >= SCHEDULED_PROMPT_URL_LIMIT) break;
  }
  return digests as unknown as ScheduledPromptUrlDigests;
}

/**
 * Whether the prompt holds links its stored snapshot does not allow: exactly
 * what an owner save of the same text would add, so saving always clears it.
 * Tasks saved before page reading have an empty snapshot; a tool-written
 * prompt may hold links the creating run's user text did not authorize.
 */
export function scheduledPromptLinksPending(prompt: string, storedDigests: readonly string[]): boolean {
  const stored = new Set(storedDigests);
  return scheduledPromptUrlDigests(prompt, { kind: "owner" }).some((digest) => !stored.has(digest));
}
