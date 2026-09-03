export const defaultChatTitle = "New Chat";
const maxGeneratedTitleLength = 48;

function textBlocksFromContent(content: unknown): string[] {
  if (typeof content !== "object" || content === null || !("blocks" in content)) {
    return [];
  }

  const blocks = (content as { blocks?: unknown }).blocks;
  if (!Array.isArray(blocks)) {
    return [];
  }

  return blocks.flatMap((block) =>
    typeof block === "object" &&
    block !== null &&
    "type" in block &&
    block.type === "text" &&
    "text" in block &&
    typeof block.text === "string"
      ? [block.text]
      : []
  );
}

function stripFencedCode(value: string): string {
  let fence: Readonly<{ length: number; marker: "`" | "~" }> | null = null;

  return value
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((line) => {
      const match = /^\s*(?:>\s*)*(`{3,}|~{3,})(.*)$/u.exec(line);
      const run = match?.[1] ?? "";
      const marker = run[0];
      if (fence === null && (marker === "`" || marker === "~")) {
        fence = { length: run.length, marker };
        return "";
      }
      if (fence !== null) {
        if (
          marker === fence.marker &&
          run.length >= fence.length &&
          (match?.[2] ?? "").trim() === ""
        ) {
          fence = null;
        }
        return "";
      }
      return line;
    })
    .join("\n");
}

function stripMarkdownLine(value: string): string {
  let line = value.trim();
  let previous = "";
  const inlineCode: string[] = [];

  // A quote can contain a list item which can contain a heading. Peel each
  // block marker independently so none of those structural markers becomes
  // part of the persisted heuristic title.
  while (line !== previous) {
    previous = line;
    line = line.replace(/^(?:>\s*|#{1,6}\s+|[-+*]\s+|\d+[.)]\s+)/u, "").trimStart();
  }

  line = line.replace(/(`+)([^`]*?)\1/gu, (_match, _ticks: string, code: string) => {
    const index = inlineCode.push(code) - 1;
    return `\u0000${index}\u0000`;
  });

  return line
    .replace(/!\[([^\]]*)\]\((?:[^()]|\([^()]*\))*\)/gu, "$1")
    .replace(/\[([^\]]+)\]\((?:[^()]|\([^()]*\))*\)/gu, "$1")
    .replace(/\*\*([^*]+)\*\*/gu, "$1")
    .replace(/(?<![\p{Letter}\p{Number}])__([^_]+)__(?![\p{Letter}\p{Number}])/gu, "$1")
    .replace(/~~([^~]+)~~/gu, "$1")
    .replace(/\*([^*]+)\*/gu, "$1")
    .replace(/(?<![\p{Letter}\p{Number}_])_([^_]+)_(?![\p{Letter}\p{Number}_])/gu, "$1")
    .replace(/\\([\\`*_[\]{}()#+.!>~-])/gu, "$1")
    .replace(/\u0000(\d+)\u0000/gu, (_match, index: string) => inlineCode[Number(index)] ?? "")
    .replace(/\s+/g, " ")
    .trim();
}

function firstSentence(value: string): string {
  return /^.*?(?:[.!?](?=\s|$)|[。！？])/u.exec(value)?.[0]?.trim() ?? value;
}

function boundTitle(value: string): string {
  const characters = Array.from(value);
  if (characters.length <= maxGeneratedTitleLength) {
    return value;
  }

  const bounded = characters.slice(0, maxGeneratedTitleLength).join("");
  if (characters[maxGeneratedTitleLength] === " " || bounded.endsWith(" ")) {
    return bounded.trimEnd();
  }

  const lastWordBoundary = bounded.lastIndexOf(" ");
  return lastWordBoundary > 0 ? bounded.slice(0, lastWordBoundary).trimEnd() : bounded;
}

export function messageTextFromContent(content: unknown): string {
  return textBlocksFromContent(content)
    .join(" ")
    .trim();
}

export function titleFromMessageContent(content: unknown): string {
  const firstLine = stripFencedCode(textBlocksFromContent(content).join("\n"))
    .split("\n")
    .map(stripMarkdownLine)
    .find(Boolean);
  if (!firstLine) {
    return defaultChatTitle;
  }

  return boundTitle(firstSentence(firstLine));
}
