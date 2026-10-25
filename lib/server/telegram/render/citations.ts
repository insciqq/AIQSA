import type { ThreadCitation } from "@/lib/contracts/chats";
import { safeExternalHref } from "@/lib/domain/links";
import type { TelegramRichText } from "../botApi";

export type TelegramAnswerOptions = Readonly<{
  /** Accepts artifactSummary.citations. */
  citations?: readonly ThreadCitation[];
  streaming?: boolean;
}>;

export function safeTelegramHref(value: unknown): string | null {
  const href = safeExternalHref(value);
  return href && /^https?:/iu.test(href) ? href : null;
}

/**
 * Telegram answers carry no Sources list (operator decision 2026-10-25): a
 * numbered list of every search result buried the answer on a phone. A search
 * citation the answer writes as `[N]` links to that source when
 * server-provided metadata has a safe URL for exactly that index; any other
 * text stays as the model wrote it. This never fetches evidence or turns an
 * internal reference into a URL.
 */
export function citationLinks(citations: readonly ThreadCitation[] = []): (value: string) => TelegramRichText {
  const urls = new Map<string, string>();
  for (const citation of citations) {
    const url = safeTelegramHref(citation.url);
    if (url) urls.set(String(citation.index), url);
  }
  return (value) => {
    const parts: TelegramRichText[] = [];
    let end = 0;
    for (const match of value.matchAll(/\[([1-9]\d*)\]/gu)) {
      const url = urls.get(match[1]!);
      if (!url) continue;
      if (match.index > end) parts.push(value.slice(end, match.index));
      parts.push({ type: "url", text: match[0], url });
      end = match.index + match[0].length;
    }
    if (!parts.length) return value;
    if (end < value.length) parts.push(value.slice(end));
    return parts;
  };
}
