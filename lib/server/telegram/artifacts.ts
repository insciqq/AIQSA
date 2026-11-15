import type { ThreadArtifactSummary } from "../../contracts/chats";
import { getAuthConfig } from "../auth/config";
import { logEvent } from "../observability";
import type { TelegramInputRichMessage } from "./botApi";
import type { TelegramDelivery, TelegramKeyboard, TelegramOutbound } from "./outbound";
import type { TelegramMessageRefOwner } from "./store/messageRefs";
import type { TelegramFailure } from "./transport";

/**
 * The artifacts an answer shows (pages, charts, slides, a Deep research
 * page) in Telegram (operator decision 2026-11-16: Telegram gets what the web
 * chat can do where Telegram can). Telegram cannot run an artifact, so each
 * one becomes one message after the answer's text and files: its title and an
 * "Open" button to the installation's own address of that exact version
 * (`app/artifacts/[artifactId]/versions/[versionId]`). The address carries no
 * secret: the app asks for sign-in and shows the artifact only to its owner,
 * in its viewer with its CSP and sandbox. A button Telegram refuses (an
 * address it does not accept, such as a local one) goes once more as the
 * title with the address in plain text, since a refused message never
 * reached Telegram. A message Telegram may have received is never sent
 * again. Logs carry codes and counts, never titles or ids.
 */

export const TELEGRAM_ARTIFACT_COPY = { open: "Open", untitled: "Artifact" } as const;

/** Every code this module logs besides Telegram's transport codes. */
export const TELEGRAM_ARTIFACT_LOG_CODES = ["telegram_artifact_failed", "telegram_artifact_link_invalid"] as const;

const TITLE_MAX_LENGTH = 256;
// Control, format and invisible characters (bidirectional overrides included) never reach a shown title.
const TITLE_INVISIBLE = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu;

export type TelegramAnswerArtifact = Readonly<{ artifactId: string; title: string; versionId: string }>;

/** The installation's web address the links start from (`AIQSA_APP_BASE_URL`), read when a message goes. */
export type TelegramAppBaseUrl = () => string;

export function defaultTelegramAppBaseUrl(): string {
  return getAuthConfig().appBaseUrl;
}

/** Content-free: codes, counts and HTTP status. */
function log(fields: Readonly<{ code: string; count?: number; httpStatus?: number; outcome: "degraded" | "failed" }>): void {
  logEvent("service_operation", {
    code: fields.code, ...(fields.count === undefined ? {} : { count: fields.count }),
    ...(fields.httpStatus ? { httpStatus: fields.httpStatus } : {}), outcome: fields.outcome, stage: "dispatch", subsystem: "telegram"
  });
}

/** The artifacts a settled answer shows, in its order, each version once. */
export function telegramAnswerArtifacts(summary: Pick<ThreadArtifactSummary, "generatedArtifacts"> | null | undefined): TelegramAnswerArtifact[] {
  const seen = new Set<string>();
  const artifacts: TelegramAnswerArtifact[] = [];
  for (const artifact of summary?.generatedArtifacts ?? []) {
    if (seen.has(artifact.versionId)) continue;
    seen.add(artifact.versionId);
    artifacts.push({ artifactId: artifact.artifactId, title: artifact.title, versionId: artifact.versionId });
  }
  return artifacts;
}

/** The title as one bounded line without invisible characters; a generic name when nothing is left. */
export function telegramArtifactTitle(title: string): string {
  const line = title.normalize("NFC").replace(TITLE_INVISIBLE, " ").replace(/\s+/gu, " ").trim();
  const characters = Array.from(line);
  if (characters.length === 0) return TELEGRAM_ARTIFACT_COPY.untitled;
  return characters.length <= TITLE_MAX_LENGTH ? line : `${characters.slice(0, TITLE_MAX_LENGTH - 1).join("").trimEnd()}…`;
}

/**
 * The web address that opens this artifact version in the signed-in app, on
 * the installation's own origin; null when the base address is not a plain
 * http(s) origin (then no link goes anywhere).
 */
export function telegramArtifactUrl(appBaseUrl: string, artifact: Pick<TelegramAnswerArtifact, "artifactId" | "versionId">): string | null {
  let base: URL;
  try {
    base = new URL(appBaseUrl);
  } catch {
    return null;
  }
  if ((base.protocol !== "https:" && base.protocol !== "http:") || base.username || base.password) return null;
  return new URL(`/artifacts/${encodeURIComponent(artifact.artifactId)}/versions/${encodeURIComponent(artifact.versionId)}`, base.origin)
    .toString();
}

/** One artifact's message: its title in bold. */
export function telegramArtifactMessage(artifact: Pick<TelegramAnswerArtifact, "title">): TelegramInputRichMessage {
  return { blocks: [{ type: "paragraph", text: { type: "bold", text: telegramArtifactTitle(artifact.title) } }] };
}

/** The message's one button: Open, to the artifact's web address. */
export function telegramArtifactKeyboard(url: string): TelegramKeyboard {
  return [[{ text: TELEGRAM_ARTIFACT_COPY.open, url }]];
}

/** Telegram may have received it: never sent again. */
export function ambiguousTelegramFailure(failure: TelegramFailure): boolean {
  return failure.kind === "timeout" || failure.kind === "network_after_send";
}

/**
 * Sends one artifact's message, referenced to the answer's chat so a reply
 * continues it: the title with the Open button, or, when Telegram refuses that
 * message, the title with the address as text, once.
 */
export async function sendTelegramArtifact(input: Readonly<{
  outbound: Pick<TelegramOutbound, "sendContent" | "sendText">;
  chatId: number;
  owner: TelegramMessageRefOwner;
  artifact: TelegramAnswerArtifact;
  url: string;
  authorize?: () => Promise<boolean>;
}>): Promise<TelegramDelivery> {
  const authority = input.authorize ? { authorize: input.authorize } : {};
  const delivery = await input.outbound.sendContent({
    ...authority, chatId: input.chatId, keyboard: telegramArtifactKeyboard(input.url), messages: [telegramArtifactMessage(input.artifact)],
    owner: input.owner
  });
  // Only a message Telegram refused itself (its button's address), with nothing of it in the chat, goes again.
  if (delivery.ok || delivery.messageIds.length > 0 || delivery.failure.kind !== "telegram" || delivery.failure.errorCode !== 400) {
    return delivery;
  }
  log({ code: "telegram_artifact_link_invalid", httpStatus: delivery.failure.status, outcome: "degraded" });
  return input.outbound.sendText({
    ...authority, chatId: input.chatId, owner: input.owner, text: `${telegramArtifactTitle(input.artifact.title)}\n${input.url}`
  });
}

/**
 * An answer's artifacts after its files, in order. A chat that may no longer
 * receive them ends them; a chat that refuses one ends them too (the rest
 * stays in AIQSA); one Telegram may have received is never sent again and the
 * next one still goes. Returns the versions that certainly did not reach
 * Telegram.
 */
export async function deliverTelegramArtifacts(input: Readonly<{
  outbound: Pick<TelegramOutbound, "sendContent" | "sendText">;
  chatId: number;
  owner: TelegramMessageRefOwner;
  artifacts: readonly TelegramAnswerArtifact[];
  appBaseUrl: string;
  authorize?: () => Promise<boolean>;
}>): Promise<readonly string[]> {
  const unsent: string[] = [];
  for (const [index, artifact] of input.artifacts.entries()) {
    const url = telegramArtifactUrl(input.appBaseUrl, artifact);
    if (!url) {
      // The installation's address is not usable: no artifact can be linked.
      log({ code: "telegram_artifact_link_invalid", count: input.artifacts.length - index, outcome: "failed" });
      return [...unsent, ...input.artifacts.slice(index).map((item) => item.versionId)];
    }
    const delivery = await sendTelegramArtifact({ ...input, artifact, url });
    if (delivery.ok) continue;
    const rest = input.artifacts.slice(index + 1).map((item) => item.versionId);
    if (delivery.failure.kind === "unreachable") return [...unsent, ...(delivery.messageIds.length === 0 ? [artifact.versionId] : []), ...rest];
    // The outbound logged the failure itself.
    if (ambiguousTelegramFailure(delivery.failure)) continue;
    if (delivery.messageIds.length === 0) unsent.push(artifact.versionId);
    log({ code: "telegram_artifact_failed", count: input.artifacts.length - index, outcome: "failed" });
    return [...unsent, ...rest];
  }
  return unsent;
}

/** Remembered runs whose artifacts went. */
const MEMORY_LIMIT = 1_000;

export type TelegramRunArtifacts = Readonly<{
  /**
   * Sends the artifacts of a run's answer that this process has not sent for
   * that run yet, so a second delivery of the same answer repeats none.
   */
  send(input: Readonly<{
    runId: string;
    outbound: Pick<TelegramOutbound, "sendContent" | "sendText">;
    chatId: number;
    owner: TelegramMessageRefOwner;
    artifacts: readonly TelegramAnswerArtifact[];
    authorize: () => Promise<boolean>;
  }>): Promise<void>;
}>;

export function createTelegramRunArtifacts(deps: Readonly<{ appBaseUrl?: TelegramAppBaseUrl }> = {}): TelegramRunArtifacts {
  const appBaseUrl = deps.appBaseUrl ?? defaultTelegramAppBaseUrl;
  /** Versions sent, or possibly received, per run. */
  const sent = new Map<string, Set<string>>();
  return Object.freeze({
    async send(input) {
      const seen = sent.get(input.runId) ?? new Set<string>();
      sent.delete(input.runId);
      sent.set(input.runId, seen);
      while (sent.size > MEMORY_LIMIT) sent.delete(sent.keys().next().value as string);
      const fresh = input.artifacts.filter((artifact) => !seen.has(artifact.versionId));
      if (fresh.length === 0) return;
      for (const artifact of fresh) seen.add(artifact.versionId);
      const unsent = await deliverTelegramArtifacts({ ...input, appBaseUrl: appBaseUrl(), artifacts: fresh });
      // Only what certainly never reached Telegram may go with a later delivery.
      for (const versionId of unsent) seen.delete(versionId);
    }
  });
}
