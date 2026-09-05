import { safeExternalHref } from "./links";
import { GEMINI_SEARCH_SUGGESTIONS_LIMITS } from "./geminiSearchSuggestions";

export type GroundingDisplay = {
  provider: "gemini";
  suggestionsHtml: string;
  citations: {
    startIndex: number;
    endIndex: number;
    url: string;
    title: string;
  }[];
};

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Shape/URL boundary shared by live and reloaded output. HTML additionally
 * passes the server structural validator and the browser renderer allowlist. */
export function decodeGroundingDisplay(value: unknown): GroundingDisplay | null {
  if (!record(value) || value.provider !== "gemini" ||
    typeof value.suggestionsHtml !== "string" || !value.suggestionsHtml ||
    new TextEncoder().encode(value.suggestionsHtml).byteLength >
      GEMINI_SEARCH_SUGGESTIONS_LIMITS.maxHtmlBytes ||
    !Array.isArray(value.citations) || value.citations.length > 100) return null;
  const citations: GroundingDisplay["citations"] = [];
  for (const candidate of value.citations) {
    if (!record(candidate) ||
      typeof candidate.startIndex !== "number" ||
      !Number.isSafeInteger(candidate.startIndex) || candidate.startIndex < 0 ||
      typeof candidate.endIndex !== "number" ||
      !Number.isSafeInteger(candidate.endIndex) || candidate.endIndex < candidate.startIndex ||
      candidate.endIndex > 10_000_000 ||
      typeof candidate.url !== "string" || candidate.url.length > 2_048 ||
      typeof candidate.title !== "string" || candidate.title.length > 512 ||
      /[\u0000-\u001f\u007f]/u.test(candidate.title)) return null;
    if (/[\u0000-\u001f\u007f]/u.test(candidate.url)) return null;
    const url = safeExternalHref(candidate.url);
    if (!url || !/^https?:\/\//u.test(url)) return null;
    const parsed = new URL(url);
    if (parsed.username || parsed.password) return null;
    citations.push({ startIndex: candidate.startIndex, endIndex: candidate.endIndex,
      title: candidate.title.trim(), url });
  }
  return { provider: "gemini", suggestionsHtml: value.suggestionsHtml, citations };
}
