import type { ThreadArtifactSummary, ThreadKnowledgeCitation } from "@/lib/contracts/chats";
import { safeExternalHref } from "@/lib/domain/links";
import type { TelegramInputRichBlock, TelegramRichText } from "../botApi";

/** Search sources pass through directly; Knowledge sources can supply a handle and no URL. */
export type TelegramAnswerSource = Readonly<{
  title: string;
  url?: string | null;
  handle?: string;
  rank?: number;
}>;

/**
 * Accepts artifactSummary.citations and/or artifactSummary.knowledgeCitations.
 * Knowledge handles have no title/URL in that summary: the caller may attach
 * already-authorized metadata here or in sources with the same handle. This
 * renderer never fetches evidence or turns an internal reference into a URL.
 */
export type TelegramAnswerCitation = ThreadArtifactSummary["citations"][number] |
  (ThreadKnowledgeCitation & Readonly<{ title?: string; url?: string | null }>);

export type TelegramAnswerOptions = Readonly<{
  citations?: readonly TelegramAnswerCitation[];
  /** Accepts artifactSummary.sources, plus optionally resolved Knowledge sources. */
  sources?: readonly TelegramAnswerSource[];
  streaming?: boolean;
}>;

export function safeTelegramHref(value: unknown): string | null {
  const href = safeExternalHref(value);
  return href && /^https?:/iu.test(href) ? href : null;
}

export function citationRenderer(options: TelegramAnswerOptions) {
  const known = new Map<string, TelegramAnswerSource>();
  const sourcesByHandle = new Map(options.sources?.filter(source => source.handle).map(source => [source.handle, source]));
  for (const citation of options.citations ?? []) {
    if ("handle" in citation) {
      if (citation.deleted) continue;
      const source = sourcesByHandle.get(citation.handle);
      known.set(citation.handle, {
        title: citation.title ?? source?.title ?? `Source ${citation.handle}`,
        url: citation.url ?? source?.url,
        handle: citation.handle
      });
    } else {
      known.set(String(citation.index), citation);
    }
  }
  const used = new Map<string, number>();
  const ordered: TelegramAnswerSource[] = [];
  const reference = (handle: string): string | null => {
    const source = known.get(handle);
    if (!source) return null;
    let number = used.get(handle);
    if (number === undefined) {
      number = ordered.push(source);
      used.set(handle, number);
    }
    return `[${number}]`;
  };
  return {
    reference,
    // Search citations are numeric text in the existing parser, unlike Knowledge
    // nodes. Resolve only indices actually present in server-provided metadata.
    text: (value: string) => value.replace(/\[([1-9]\d*)\]/gu, (source, index: string) => reference(index) ?? source),
    footer: (): TelegramInputRichBlock[] => {
      const seenUrls = new Set(ordered.map(source => safeTelegramHref(source.url)).filter(Boolean));
      const seenHandles = new Set(ordered.map(source => source.handle).filter(Boolean));
      for (const source of options.sources ?? []) {
        const url = safeTelegramHref(source.url);
        if ((source.handle && seenHandles.has(source.handle)) || (url && seenUrls.has(url))) continue;
        ordered.push(source);
        if (url) seenUrls.add(url);
        if (source.handle) seenHandles.add(source.handle);
      }
      if (!ordered.length) return [];
      const text: TelegramRichText[] = [{ type: "bold", text: "Sources" }];
      ordered.forEach((source, index) => {
        const url = safeTelegramHref(source.url);
        text.push(`\n[${index + 1}] `, url ? { type: "url", text: source.title, url } : source.title);
      });
      return [{ type: "footer", text }];
    }
  };
}
