/** Serialize only the known, inert MarkdownMessage DOM. Never copies HTML. */
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
    const text = code?.textContent ?? (node.tagName === "PRE" ? node.textContent : "");
    if (!text) return "";
    const fence = fenceFor(text);
    return `${fence}${node.getAttribute("data-markdown-code-language") ?? ""}\n${text}${text.endsWith("\n") ? "" : "\n"}${fence}\n\n`;
  }
  if (node.tagName === "TABLE") return table(node);
  if (node.tagName === "CODE") {
    const text = node.textContent ?? "";
    const marker = "`".repeat(Math.max(1, ...[...text.matchAll(/`+/gu)].map(match => match[0].length + 1)));
    return text ? `${marker}${text}${marker}` : "";
  }
  if (node.tagName === "UL" || node.tagName === "OL") {
    const start = Number(node.getAttribute("start") ?? 1);
    return [...node.children].filter(child => child.tagName === "LI").map((item, index) => {
      const prefix = node.tagName === "OL" ? `${start + index}. ` : "- ";
      const text = [...item.childNodes].map(child => child instanceof Element && (child.matches("ul, ol") || child.querySelector(":scope > ul, :scope > ol"))
        ? `\n${serialize(child).trim()}` : serialize(child)).join("").trim();
      return text ? prefix + text.replace(/\n/gu, `\n${" ".repeat(prefix.length)}`) : "";
    }).filter(Boolean).join("\n") + "\n\n";
  }
  const text = children(node);
  if (/^H[1-6]$/u.test(node.tagName)) return `${"#".repeat(Number(node.getAttribute("data-markdown-heading") ?? node.tagName[1]))} ${text.trim()}\n\n`;
  if (node.tagName === "P") return `${text}\n\n`;
  if (node.tagName === "BR") return "\n";
  if (node.tagName === "HR") return "---\n\n";
  if (node.tagName === "BLOCKQUOTE") return `${text.trim().split("\n").map(line => line ? `> ${line}` : ">").join("\n")}\n\n`;
  if (node.tagName === "A") {
    const href = node.getAttribute("href");
    return href && text ? `[${text}](${href.replace(/ /gu, "%20").replace(/\(/gu, "%28").replace(/\)/gu, "%29")})` : text;
  }
  if (node.tagName === "STRONG" || node.tagName === "B") return text ? `**${text}**` : "";
  if (node.tagName === "EM" || node.tagName === "I") return text ? `*${text}*` : "";
  if (node.tagName === "DEL" || node.tagName === "S") return text ? `~~${text}~~` : "";
  return text;
}

/** A partial Range omits its shared ancestors; retain their formatting, never their unselected text. */
export function serializeRenderedMarkdownSelection(range: Range, root: HTMLElement): string {
  if (!root.contains(range.startContainer) || !root.contains(range.endContainer) || range.collapsed) return "";
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
