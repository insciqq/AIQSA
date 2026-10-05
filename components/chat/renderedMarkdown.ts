/** Serialize only the known, inert MarkdownMessage DOM as plain text that keeps block structure. Never copies HTML. */
const omitted = "button, [aria-hidden='true'], .sr-only, .v2-sr-only, .katex-html, [data-markdown-chrome], [data-knowledge-citation]";
const withoutCitations = (text: string) => text.replace(/\[K[1-9]\d{0,3}(?:\.[1-9]\d?)?\]/gu, "");
const trimEmptyLines = (text: string) => text.replace(/^(?:[\t ]*\n)+|(?:\n[\t ]*)+$/gu, "");

function fenceFor(code: string) {
  return "`".repeat(Math.max(3, ...[...code.matchAll(/`+/gu)].map(match => match[0].length + 1)));
}

function children(node: Node): string {
  return [...node.childNodes].map(serialize).join("");
}

function table(element: Element): string {
  const rows = [...element.querySelectorAll("tr")].map(row => [...row.children]
    .filter(cell => cell.matches("th, td"))
    .map(cell => children(cell).trim().replace(/\|/gu, "\\|").replace(/\n+/gu, " ")));
  if (!rows.length || !rows.some(row => row.some(Boolean))) return "";
  const width = Math.max(...rows.map(row => row.length));
  const format = (row: string[]) => `| ${Array.from({ length: width }, (_, index) => row[index] ?? "").join(" | ")} |`;
  return `${[format(rows[0]), format(Array<string>(width).fill("---")), ...rows.slice(1).map(format)].join("\n")}\n\n`;
}

const listItemBlock = "p, div, ul, ol, blockquote, pre, table, hr, h1, h2, h3, h4, h5, h6";

/** Inline runs and block children (nested lists, code, paragraphs) each start their own line. */
function listItem(item: Element, separator: string): string {
  const parts: string[] = [];
  let inline = "";
  for (const child of item.childNodes) {
    if (child instanceof Element && child.matches(listItemBlock)) {
      parts.push(inline.trim(), serialize(child).trim());
      inline = "";
    } else {
      inline += serialize(child);
    }
  }
  parts.push(inline.trim());
  return parts.filter(Boolean).join(separator);
}

function serialize(node: Node): string {
  if (node.nodeType === Node.TEXT_NODE) return withoutCitations(node.textContent ?? "");
  if (!(node instanceof Element)) return children(node);
  if (node.matches(omitted)) return "";
  if (node.hasAttribute("data-math-display")) {
    const source = node.querySelector('annotation[encoding="application/x-tex"]')?.textContent ?? node.getAttribute("data-math-source");
    if (source) return node.getAttribute("data-math-display") === "true" ? `$$\n${source}\n$$\n\n` : `$${source}$`;
  }
  if (node.hasAttribute("data-markdown-code-language") || node.tagName === "PRE") {
    const code = node.querySelector("pre code") ?? node.querySelector("code");
    const text = code?.textContent ?? node.getAttribute("data-markdown-code-source") ?? (node.tagName === "PRE" ? node.textContent : "");
    if (!text) return "";
    const fence = fenceFor(text);
    return `${fence}${node.getAttribute("data-markdown-code-language") ?? ""}\n${text}${text.endsWith("\n") ? "" : "\n"}${fence}\n\n`;
  }
  if (node.tagName === "TABLE") return table(node);
  // Inline code, including inert links, quotes as its raw text: a citation-shaped literal is data, not a citation.
  if (node.tagName === "CODE") return node.textContent ?? "";
  if (node.tagName === "UL" || node.tagName === "OL") {
    const start = Number(node.getAttribute("start") ?? 1);
    const items = [...node.children].filter(child => child.tagName === "LI");
    // Loose items render paragraphs as <p>; blank lines keep them loose when the quote renders again.
    const loose = items.some(item => [...item.children].some(child => child.tagName === "P"));
    return items.map((item, index) => {
      const prefix = node.tagName === "OL" ? `${start + index}. ` : "- ";
      const text = listItem(item, loose ? "\n\n" : "\n");
      return text ? prefix + text.replace(/\n/gu, `\n${" ".repeat(prefix.length)}`) : "";
    }).filter(Boolean).join(loose ? "\n\n" : "\n") + "\n\n";
  }
  const text = children(node);
  if (/^H[1-6]$/u.test(node.tagName)) return `${text.trim()}\n\n`;
  if (node.tagName === "P") return `${text}\n\n`;
  if (node.tagName === "BR") return "\n";
  if (node.tagName === "HR") return "---\n\n";
  if (node.tagName === "BLOCKQUOTE") return `${text.trim().split("\n").map(line => line ? `> ${line}` : ">").join("\n")}\n\n`;
  // Links (label only), emphasis, strike and other inline elements quote as their plain text.
  return text;
}

/** The selected text of one code block, or null when the selection is not inside one block or covers all of its code. */
function partialCodeText(range: Range, root: HTMLElement): string | null {
  const common = range.commonAncestorContainer instanceof Element ? range.commonAncestorContainer : range.commonAncestorContainer.parentElement;
  const block = common?.closest("[data-markdown-code-language], pre");
  if (!block || !root.contains(block)) return null;
  const code = block.querySelector("pre code") ?? block.querySelector("code") ?? (block.tagName === "PRE" ? block : null);
  if (!code || !range.intersectsNode(code)) return null;
  const selected = range.cloneRange();
  if (!code.contains(range.startContainer)) selected.setStart(code, 0);
  if (!code.contains(range.endContainer)) selected.setEnd(code, code.childNodes.length);
  const text = selected.toString().replace(/\r\n?/gu, "\n");
  return text.trim() === (code.textContent ?? "").replace(/\r\n?/gu, "\n").trim() ? null : text;
}

/**
 * A partial Range omits its shared ancestors; retain their formatting, never their unselected text.
 * A fragment inside one code block quotes as plain text; only the whole block or a selection leaving it keeps the fence.
 */
export function serializeRenderedMarkdownSelection(range: Range, root: HTMLElement): string {
  if (!root.contains(range.startContainer) || !root.contains(range.endContainer) || range.collapsed) return "";
  const code = partialCodeText(range, root);
  if (code !== null) return trimEmptyLines(code);
  let selected: Node = range.cloneContents();
  let ancestor = range.commonAncestorContainer instanceof Element ? range.commonAncestorContainer : range.commonAncestorContainer.parentElement;
  while (ancestor && ancestor !== root) {
    const wrapper = ancestor.cloneNode(false);
    wrapper.appendChild(selected);
    selected = wrapper;
    ancestor = ancestor.parentElement;
  }
  return trimEmptyLines(serialize(selected).replace(/\r\n?/gu, "\n"));
}

/** Preserve the existing draft byte for byte and append whole Markdown block quotes. */
export function appendSelectionQuote(draft: string, selection: string): string {
  const normalized = trimEmptyLines(selection.replace(/\r\n?/gu, "\n"));
  if (!normalized.trim()) return draft;
  const quote = normalized.split("\n").map(line => line.trim() ? `> ${line}` : ">").join("\n");
  const separator = draft ? draft.endsWith("\n\n") ? "" : draft.endsWith("\n") ? "\n" : "\n\n" : "";
  return `${draft}${separator}${quote}\n\n`;
}
