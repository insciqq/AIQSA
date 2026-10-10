/**
 * Downloads an artifact asks its viewer to save. Firefox and WebKit refuse every download
 * from the sandboxed frame under the viewer's `frame-src 'none'`, so the frame's bridge
 * hands the bytes it can already read to this window instead. The viewer saves them only
 * right after a user gesture in the focused frame (a click in the artifact activates its
 * ancestors too) and within a small rate; otherwise the user confirms the file. This module
 * has no dependencies, so the artifact runtime stand bundles it into its host page.
 */

export const ARTIFACT_DOWNLOAD_LIMITS = Object.freeze({
  /** A bundle file always fits: a rendered page is at most 64 MiB. */
  maxBytes: 64 * 1024 * 1024,
  /** Characters of a requested name; a longer one is refused, not cut. */
  maxRequestedNameCharacters: 1024,
  /** Characters (code points) of the saved name. */
  maxNameCharacters: 120,
  /** Saves without asking: at most `burst` within `burstWindowMs` and `perMinute` within a minute, per tab. */
  burst: 3,
  burstWindowMs: 10_000,
  perMinute: 12,
  /** The object URL of a saved copy lives this long, for browsers that read it after the click. */
  revokeAfterMs: 60_000
});

export type ArtifactDownloadRequest = Readonly<{ name: string; blob: Blob }>;
/** `save` at once after a user gesture, `ask` the user first, or refuse a file `too_large` to save. */
export type ArtifactDownloadDecision = "save" | "ask" | "too_large";

const RESERVED_NAME = /^(?:con|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³])$/iu;

/**
 * A file name safe to offer the browser: no control, format (bidi overrides, zero-width) or
 * separator characters, nothing Windows reserves, no leading or trailing dots, a bounded length
 * that keeps a short extension, and "download" when nothing usable is left.
 */
export function artifactDownloadName(value: string): string {
  let name = value.normalize("NFC")
    .replace(/[\p{Cc}\p{Cf}\p{Cs}\p{Co}]/gu, "")
    .replace(/[\\/:*?"<>|]/gu, "_")
    .replace(/\s+/gu, " ")
    .replace(/^[\s.]+|[\s.]+$/gu, "");
  const characters = Array.from(name);
  if (characters.length > ARTIFACT_DOWNLOAD_LIMITS.maxNameCharacters) {
    const dot = name.lastIndexOf(".");
    const extension = dot > 0 && Array.from(name.slice(dot)).length <= 16 ? Array.from(name.slice(dot)) : [];
    name = characters.slice(0, ARTIFACT_DOWNLOAD_LIMITS.maxNameCharacters - extension.length).join("").replace(/[\s.]+$/u, "") + extension.join("");
  }
  if (!name) return "download";
  return RESERVED_NAME.test(name.split(".")[0]!.trim()) ? `_${name}` : name;
}

/** The frame's request, or null for anything else: exact fields, a Blob and a bounded name. */
export function parseArtifactDownloadMessage(value: unknown): ArtifactDownloadRequest | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const input = value as Record<string, unknown>;
  if (input.type !== "aiqsa_artifact_download" || Object.keys(input).length !== 3 || !Object.hasOwn(input, "name") ||
    !Object.hasOwn(input, "blob") || typeof input.name !== "string" ||
    input.name.length > ARTIFACT_DOWNLOAD_LIMITS.maxRequestedNameCharacters || typeof Blob !== "function" || !(input.blob instanceof Blob)) return null;
  return { name: artifactDownloadName(input.name), blob: input.blob };
}

/** Whether this window has transient user activation; browsers without the API never save without asking. */
export function artifactUserActivation(): "active" | "inactive" | "unsupported" {
  const activation = typeof navigator === "undefined" ? undefined : (navigator as Navigator & { userActivation?: { isActive?: unknown } }).userActivation;
  if (!activation || typeof activation.isActive !== "boolean") return "unsupported";
  return activation.isActive ? "active" : "inactive";
}

/** Times of saves made without asking in this tab, shared by every artifact frame. */
export function createArtifactDownloadTurns() {
  let saves: number[] = [];
  return {
    /** Takes a turn for a save without asking at `now` (ms), or returns false past the burst or minute limit. */
    take(now: number): boolean {
      saves = saves.filter(time => now - time < 60_000 && time <= now);
      const recent = saves.filter(time => now - time < ARTIFACT_DOWNLOAD_LIMITS.burstWindowMs).length;
      if (recent >= ARTIFACT_DOWNLOAD_LIMITS.burst || saves.length >= ARTIFACT_DOWNLOAD_LIMITS.perMinute) return false;
      saves.push(now);
      return true;
    },
    reset() { saves = []; }
  };
}

export const artifactDownloadTurns = createArtifactDownloadTurns();

/**
 * What to do with a request that arrived now. Saving without asking needs this window's user
 * activation while the asking frame holds focus: typing or clicking elsewhere in the app also
 * activates this window, but leaves focus outside the frame. Such a save consumes a turn.
 */
export function artifactDownloadDecision(request: ArtifactDownloadRequest, now: number, frameFocused: boolean,
  turns: Pick<ReturnType<typeof createArtifactDownloadTurns>, "take"> = artifactDownloadTurns): ArtifactDownloadDecision {
  if (request.blob.size > ARTIFACT_DOWNLOAD_LIMITS.maxBytes) return "too_large";
  return frameFocused && artifactUserActivation() === "active" && turns.take(now) ? "save" : "ask";
}

/**
 * Saves a copy through this document. The copy is always `application/octet-stream`, so the
 * app origin never holds a navigable HTML or SVG blob, and its object URL is revoked later.
 */
export function saveArtifactDownload(request: ArtifactDownloadRequest): void {
  const address = URL.createObjectURL(new Blob([request.blob], { type: "application/octet-stream" }));
  const anchor = document.createElement("a");
  anchor.href = address;
  anchor.download = request.name;
  anchor.rel = "noopener";
  anchor.hidden = true;
  document.body.append(anchor);
  try { anchor.click(); }
  finally {
    anchor.remove();
    setTimeout(() => URL.revokeObjectURL(address), ARTIFACT_DOWNLOAD_LIMITS.revokeAfterMs);
  }
}
