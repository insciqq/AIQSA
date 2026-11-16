import type { ThreadArtifactSummary } from "../../contracts/chats";
import { telegramAnswerArtifacts } from "../telegram/artifacts";
import { logDiscordBridgeFailure } from "./bridge/journal";
import { redactOutgoing } from "./redaction";
import { discordInlineText } from "./render";

/**
 * The artifacts a Discord answer made, published by public link (operator
 * decision 2026-11-16, an exception to "publishing beyond the user needs the
 * user's confirmation"; precedent: the automatic share behind Open in AIQSA,
 * PRD D-21). Each version the answer made is published as the service
 * account with no expiry, like the thread's chat share, and linked under the
 * answer as an "Open <title>" button, or as a line where the installation has
 * no https address. Nobody signs in as the service account and Discord
 * members have no AIQSA account (PRD O-06), so the owner page Telegram links
 * to would open for nobody.
 *
 * Answer first: publication runs beside the answer's files and is bounded
 * (`DISCORD_ARTIFACT_PUBLISH_TIMEOUT_MS`); a failure, a refusal or the bound
 * leaves that artifact "only in AIQSA" in a line under the answer, and the
 * answer goes. Only the token's hash is stored, so a link cannot be rebuilt:
 * a process remembers the links it made (`createDiscordArtifactPublisher`),
 * so a retried delivery repeats them, and a delivery after a restart
 * publishes the same immutable version again under a new link. A publication
 * that finishes after the bound is not shown with this answer: only a retried
 * delivery of it in this process may show it, otherwise nobody holds its token.
 * Titles are redacted before they go out (PRD D-22); the artifact's content
 * is published as made (accepted risk, `agent_docs/SECURITY.md`). Logs carry
 * codes only, never titles, ids or links.
 */

/**
 * The bound of an answer's publications, all at once. Publishing copies the
 * version's bundle (at most `ARTIFACT_LIMITS.maxBundleBytes`, read twice and
 * written once in the private object store) and renders its entry page; a
 * typical page takes well under a second. The status keeps its clock while
 * it waits, and a stuck store holds the answer at most this long.
 */
export const DISCORD_ARTIFACT_PUBLISH_TIMEOUT_MS = 15_000;

/** Discord takes 5 rows of 5 link buttons; the first row stays for Open in AIQSA, so artifacts get 4 rows. */
export const DISCORD_ARTIFACT_BUTTONS_PER_ROW = 5;
export const DISCORD_ARTIFACT_BUTTON_ROWS = 4;
export const DISCORD_ARTIFACT_LINKS_MAX = DISCORD_ARTIFACT_BUTTONS_PER_ROW * DISCORD_ARTIFACT_BUTTON_ROWS;
/** Discord's button label and link limits (`lib/server/discord/rest.ts`). */
export const DISCORD_ARTIFACT_LABEL_MAX = 80;
export const DISCORD_ARTIFACT_BUTTON_URL_MAX = 512;
/** Characters an answer gives its artifact lines on a plain-http installation; the rest stay only in AIQSA. */
export const DISCORD_ARTIFACT_LINES_MAX_CHARS = 600;

const OPEN = "Open";
const UNTITLED = "artifact";
/** Remembered links of this process. */
const MEMORY_LIMIT = 1_000;
// Control, format and invisible characters (bidirectional overrides included) never reach a label.
const INVISIBLE = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu;
const PUBLIC_PATH = /^\/a\/[A-Za-z0-9_-]{32,128}$/u;

/** Publishes one artifact version as the service account; its absolute public link, or null when it may not or could not. */
export type DiscordArtifactPublisher = (input: Readonly<{ userId: string; artifactId: string; versionId: string }>) => Promise<string | null>;

export type DiscordArtifactLink = Readonly<{ title: string; url: string }>;

/** What goes under an answer: the links made in time, and how many artifacts stay only in AIQSA. */
export type DiscordAnswerArtifacts = Readonly<{ links: readonly DiscordArtifactLink[]; onlyInAiqsa: number }>;

export const DISCORD_NO_ANSWER_ARTIFACTS: DiscordAnswerArtifacts = Object.freeze({ links: [], onlyInAiqsa: 0 });

/** An absolute http(s) link without credentials, or null. */
function usableUrl(value: string | null): string | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    return (url.protocol === "https:" || url.protocol === "http:") && !url.username && !url.password ? url.toString() : null;
  } catch {
    return null;
  }
}

/**
 * Publishes the versions an answer made, at most `DISCORD_ARTIFACT_LINKS_MAX`, side by side within the bound.
 * Never throws and never waits past `timeoutMs`; what is not linked counts as only in AIQSA.
 */
export async function publishDiscordAnswerArtifacts(input: Readonly<{
  summary: Pick<ThreadArtifactSummary, "generatedArtifacts"> | null | undefined;
  userId: string;
  runId: string;
  publish: DiscordArtifactPublisher;
  timeoutMs?: number;
}>): Promise<DiscordAnswerArtifacts> {
  const artifacts = telegramAnswerArtifacts(input.summary);
  if (artifacts.length === 0) return DISCORD_NO_ANSWER_ARTIFACTS;
  // Only what can be shown is published: a link nobody is given is never made.
  const chosen = artifacts.slice(0, DISCORD_ARTIFACT_LINKS_MAX);
  const urls: (string | null)[] = chosen.map(() => null);
  let failed = 0;
  const all = Promise.all(chosen.map(async (artifact, index) => {
    try {
      const url = usableUrl(await input.publish({ artifactId: artifact.artifactId, userId: input.userId, versionId: artifact.versionId }));
      if (!url) failed += 1;
      urls[index] = url;
    } catch (error) {
      failed += 1;
      logDiscordBridgeFailure({ code: "discord_artifact_publish_failed", error, outcome: "degraded", runId: input.runId, stage: "settle" });
    }
  }));
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timedOut = await Promise.race([
    all.then(() => false),
    new Promise<boolean>((resolve) => {
      timer = setTimeout(() => resolve(true), Math.max(0, input.timeoutMs ?? DISCORD_ARTIFACT_PUBLISH_TIMEOUT_MS));
      timer.unref?.();
    })
  ]);
  clearTimeout(timer);
  // A snapshot at the bound: a publication finishing later is not shown with this answer.
  const links = chosen.flatMap((artifact, index) => {
    const url = urls[index];
    return url ? [{ title: artifact.title, url }] : [];
  });
  if (timedOut) logDiscordBridgeFailure({ code: "discord_artifact_publish_timeout", outcome: "degraded", runId: input.runId, stage: "settle" });
  else if (failed > 0) logDiscordBridgeFailure({ code: "discord_artifact_publish_failed", outcome: "degraded", runId: input.runId, stage: "settle" });
  return { links, onlyInAiqsa: artifacts.length - links.length };
}

/** The title as one line without invisible characters, secrets replaced; nothing left becomes a generic name. */
function plainTitle(title: string): Readonly<{ text: string; redactions: number }> {
  const line = String(title ?? "").normalize("NFC").replace(INVISIBLE, " ").replace(/\s+/gu, " ").trim();
  const redacted = redactOutgoing(line);
  return { redactions: redacted.count, text: redacted.text.trim() || UNTITLED };
}

/** A button label `Open <title>`: plain text in Discord (no Markdown), redacted, at most 80 characters with `…` when cut. */
export function discordArtifactLabel(title: string): Readonly<{ label: string; redactions: number }> {
  const plain = plainTitle(title);
  const full = `${OPEN} ${plain.text}`;
  if (full.length <= DISCORD_ARTIFACT_LABEL_MAX) return { label: full, redactions: plain.redactions };
  // Cut by whole code points (never half a surrogate pair), with room for the ellipsis.
  const characters = Array.from(plain.text);
  let kept = "";
  for (const character of characters) {
    if (`${OPEN} ${kept}${character}…`.length > DISCORD_ARTIFACT_LABEL_MAX) break;
    kept += character;
  }
  return { label: `${OPEN} ${kept.trimEnd()}…`, redactions: plain.redactions };
}

/** A line `Open <title>: <url>` for a plain-http installation: the title redacted and escaped as Markdown, the preview suppressed. */
export function discordArtifactLine(title: string, url: string): Readonly<{ content: string; redactions: number }> {
  const plain = plainTitle(title);
  const inline = discordInlineText(plain.text, DISCORD_ARTIFACT_LABEL_MAX);
  return { content: `${OPEN} ${inline.content || UNTITLED}: <${url}>`, redactions: plain.redactions + inline.redactions };
}

/** Whether a link may go as a button: https only and within Discord's link limit. */
export function discordArtifactButtonUrl(url: string): boolean {
  return url.startsWith("https://") && url.length <= DISCORD_ARTIFACT_BUTTON_URL_MAX;
}

export type DiscordArtifactPublishService = Readonly<{
  publish(input: Readonly<{ artifactId: string; ownerUserId: string; versionId: string }>): Promise<Readonly<{ publicPath: string }>>;
}>;

/**
 * The publisher the bridge uses: rechecks that the account is still the bot's
 * service account, publishes through the artifact service (no expiry: none
 * is passed), and builds the link on the installation's address. A process
 * keeps the links it made, so a retried delivery repeats them and never
 * publishes the same version again.
 */
export function createDiscordArtifactPublisher(deps: Readonly<{
  /** Whether this account is still the active bot's service account. */
  allowed(userId: string): Promise<boolean>;
  load(): Promise<Readonly<{ service: DiscordArtifactPublishService; appBaseUrl(): string }>>;
}>): DiscordArtifactPublisher {
  const made = new Map<string, Promise<string | null>>();
  return async (input) => {
    const key = `${input.userId}\u0000${input.versionId}`;
    const known = made.get(key);
    if (known) return known;
    const pending = (async () => {
      if (!await deps.allowed(input.userId)) return null;
      const loaded = await deps.load();
      const published = await loaded.service.publish({ artifactId: input.artifactId, ownerUserId: input.userId, versionId: input.versionId });
      if (typeof published.publicPath !== "string" || !PUBLIC_PATH.test(published.publicPath)) return null;
      return usableUrl(new URL(published.publicPath, loaded.appBaseUrl()).toString());
    })();
    made.set(key, pending);
    while (made.size > MEMORY_LIMIT) made.delete(made.keys().next().value as string);
    // Only a link made is remembered: a refusal or a failure may be tried again by a later delivery.
    void pending.then((url) => { if (!url && made.get(key) === pending) made.delete(key); },
      () => { if (made.get(key) === pending) made.delete(key); });
    return pending;
  };
}
