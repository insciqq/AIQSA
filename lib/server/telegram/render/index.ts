import { parseMarkdown, type MarkdownBlock, type MarkdownInline } from "@/lib/domain/markdown/parser";
import type {
  TelegramInputRichBlock, TelegramInputRichMessage, TelegramRichListItem, TelegramRichTableCell, TelegramRichText
} from "../botApi";
import { citationRenderer, safeTelegramHref, type TelegramAnswerOptions } from "./citations";
import { limitBlockDepth, plainBlock, plainText, RICH_LIMITS, TEXT_LIMIT } from "./richText";
import { draftMessage, packBlocks, splitText } from "./split";

export type { TelegramAnswerCitation, TelegramAnswerOptions, TelegramAnswerSource } from "./citations";
export type TelegramRenderedAnswer = Readonly<{
  messages: TelegramInputRichMessage[];
  /** Send verbatim, with no parse mode; empty answers have no fallback chunks. */
  plainFallback: string[];
}>;

/** Model Markdown is data: only this allowlisted block conversion reaches Telegram. */
export function renderTelegramAnswer(markdown: string, options: TelegramAnswerOptions = {}): TelegramRenderedAnswer {
  const citations = citationRenderer(options);
  const inline = (nodes: readonly MarkdownInline[], inLink = false): TelegramRichText => {
    const parts = nodes.map((node): TelegramRichText => {
      switch (node.type) {
        case "text": return inLink ? node.value : citations.text(node.value);
        case "break": return "\n";
        case "inlineCode": return { type: "code", text: node.value };
        case "inlineMath": return { type: "mathematical_expression", expression: node.source };
        case "citation": return (!inLink && citations.reference(node.handle)) || node.source;
        case "strong": return { type: "bold", text: inline(node.children, inLink) };
        case "emphasis": return { type: "italic", text: inline(node.children, inLink) };
        case "delete": return { type: "strikethrough", text: inline(node.children, inLink) };
        case "link": {
          const url = safeTelegramHref(node.url);
          return url ? { type: "url", url, text: inline(node.children, true) } : node.source;
        }
      }
    }).filter(part => part !== "");
    return parts.length === 1 ? parts[0] : parts;
  };
  const blocks = (nodes: readonly MarkdownBlock[]): TelegramInputRichBlock[] => nodes.map((node): TelegramInputRichBlock => {
    switch (node.type) {
      case "paragraph": return { type: "paragraph", text: inline(node.children) };
      case "heading": return { type: "heading", size: node.level as 1 | 2 | 3 | 4 | 5 | 6, text: inline(node.children) };
      case "literal": return { type: "paragraph", text: node.value };
      case "thematicBreak": return { type: "divider" };
      case "math": return { type: "mathematical_expression", expression: node.source };
      case "code": return {
        type: "pre", text: node.code,
        ...(/^[a-z0-9][a-z0-9_+.#-]{0,31}$/iu.test(node.language) ? { language: node.language } : {})
      };
      case "blockquote": return { type: "blockquote", blocks: nonempty(blocks(node.children)) };
      case "list": return {
        type: "list", items: node.items.map((item, index): TelegramRichListItem => ({
          blocks: nonempty(blocks(item)),
          ...(node.ordered ? { type: "1", value: (node.start ?? 1) + index } : {})
        }))
      };
      case "table": {
        const cells = [node.header, ...node.rows].map((row, index) => row.map((cell): TelegramRichTableCell => ({
          text: inline(cell), align: "left", valign: "top", ...(index === 0 ? { is_header: true } : {})
        })));
        if (cells.some(row => row.length > RICH_LIMITS.columns)) {
          // Widths come from content, but padding is capped to avoid quadratic expansion.
          const rows = cells.map(row => row.map(cell => plainText(cell.text ?? "")));
          const widths = node.header.map((_, column) => Math.min(40, Math.max(...rows.map(row => row[column]?.length ?? 0))));
          return { type: "pre", text: rows.map(row => row.map((cell, column) => cell.padEnd(widths[column])).join(" | ")).join("\n") };
        }
        return { type: "table", cells, is_bordered: true };
      }
    }
  });
  const document = parseMarkdown(markdown, { streaming: options.streaming });
  const answer = document ? blocks(document.blocks) : [{ type: "paragraph" as const, text: markdown }];
  if (document?.overflow) answer.push({ type: "paragraph", text: document.overflow });
  answer.push(...citations.footer());
  const plainFallback = splitText(answer.map(block => plainBlock(block, true)).join("\n\n"), TEXT_LIMIT);
  const bounded = answer.map(block => limitBlockDepth(block));
  return {
    messages: options.streaming ? [draftMessage(bounded)] : packBlocks(bounded),
    plainFallback
  };
}

/**
 * One rendered message as plain text, links written out, in chunks a plain
 * message takes: what replaces exactly that part when Telegram refuses its
 * rich form. Empty when the part shows no text.
 */
export function plainTelegramMessage(message: TelegramInputRichMessage): string[] {
  return splitText(message.blocks.map(block => plainBlock(block, true)).join("\n\n"), TEXT_LIMIT)
    .filter(chunk => chunk.trim().length > 0);
}

function nonempty(blocks: TelegramInputRichBlock[]): TelegramInputRichBlock[] {
  return blocks.length ? blocks : [{ type: "paragraph", text: "" }];
}
