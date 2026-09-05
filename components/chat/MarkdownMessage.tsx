"use client";

import { writeClipboardText } from "@/components/clipboard/writeClipboardText";
import { safeExternalHref } from "@/lib/domain/links";
import { Check, Copy } from "lucide-react";
import { memo, useEffect, useRef, useState, type ReactNode } from "react";
import { highlightCodeBlock, resolveCodeLanguage } from "./codeHighlighting";
import { renderMathExpression } from "./mathRendering";

type MarkdownPart =
  | {
      code: string;
      language: string;
      type: "code";
    }
  | {
      text: string;
      type: "text";
    };

type ListBlock = {
  items: ListItem[];
  ordered: boolean;
};

type ListItem = {
  children: ListBlock[];
  content: string;
};

type ListLine = {
  content: string;
  indent: number;
  ordered: boolean;
};

type DisplayMathBlock = {
  nextIndex: number;
  raw: string;
  source: string;
};

function splitMarkdown(markdown: string): MarkdownPart[] {
  const parts: MarkdownPart[] = [];
  const codeBlock = /^ {0,3}(`{3,})([a-zA-Z0-9_-]*)[ \t]*\r?\n([\s\S]*?)^ {0,3}\1`*[ \t]*(?=\r?$)/gm;
  let lastIndex = 0;
  let match = codeBlock.exec(markdown);

  while (match) {
    if (match.index > lastIndex) {
      parts.push({ text: markdown.slice(lastIndex, match.index), type: "text" });
    }

    parts.push({
      code: match[3],
      language: match[2],
      type: "code"
    });
    lastIndex = match.index + match[0].length;
    match = codeBlock.exec(markdown);
  }

  if (lastIndex < markdown.length) {
    parts.push({ text: markdown.slice(lastIndex), type: "text" });
  }

  return parts.length > 0 ? parts : [{ text: markdown, type: "text" }];
}

function MathExpression({ displayMode, raw, source }: { displayMode: boolean; raw: string; source: string }) {
  const [rendered, setRendered] = useState<{ html: string | null; key: string } | null>(null);
  const renderKey = `${displayMode ? "display" : "inline"}\0${source}`;
  const renderedHtml = rendered?.key === renderKey ? rendered.html : null;

  useEffect(() => {
    let cancelled = false;

    void renderMathExpression(source, displayMode).then((result) => {
      if (!cancelled) {
        setRendered({ html: result?.html ?? null, key: renderKey });
      }
    });

    return () => {
      cancelled = true;
    };
  }, [displayMode, renderKey, source]);

  if (!displayMode) {
    return renderedHtml ? (
      <span
        className="inline-block max-w-full align-middle text-ink"
        data-math-display="false"
        dangerouslySetInnerHTML={{ __html: renderedHtml }}
      />
    ) : (
      <span data-math-display="false">{raw}</span>
    );
  }

  return (
    <div
      className="max-w-full overflow-x-auto overflow-y-hidden py-1 text-ink outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-focus [&_.katex-display]:!my-0"
      data-math-display="true"
      role="region"
      aria-label="Scrollable mathematical formula"
      tabIndex={0}
    >
      {renderedHtml ? <div dangerouslySetInnerHTML={{ __html: renderedHtml }} /> : <span className="whitespace-pre-wrap">{raw}</span>}
    </div>
  );
}

export type MarkdownCitationRenderer = (handle: string, key: string) => ReactNode | null;

function decodePlainTextEntities(text: string): string {
  // Decode the literal encoder's entities once, after Markdown recognition.
  // These remain React text and cannot create HTML or an active citation.
  return text.replace(/&(amp|lt|gt);/g, (entity) => {
    if (entity === "&amp;") return "&";
    return entity === "&lt;" ? "<" : ">";
  });
}

function renderPlainInline(
  text: string,
  keyPrefix: string,
  renderCitation?: MarkdownCitationRenderer
): ReactNode[] {
  if (!renderCitation) return [decodePlainTextEntities(text)];
  const nodes: ReactNode[] = [];
  const citationPattern = /\[(K[1-9]\d{0,3}(?:\.[1-9]\d?)?)\]/gu;
  let lastIndex = 0;
  let match = citationPattern.exec(text);
  while (match) {
    if (match.index > lastIndex) nodes.push(decodePlainTextEntities(text.slice(lastIndex, match.index)));
    const nestedLinkLabel = text[match.index - 1] === "[" &&
      text.slice(match.index + match[0].length, match.index + match[0].length + 2) === "](";
    const rendered = nestedLinkLabel
      ? null
      : renderCitation(match[1], `${keyPrefix}-citation-${match.index}`);
    nodes.push(rendered ?? match[0]);
    lastIndex = match.index + match[0].length;
    match = citationPattern.exec(text);
  }
  if (lastIndex < text.length) nodes.push(decodePlainTextEntities(text.slice(lastIndex)));
  return nodes;
}

function renderInline(
  text: string,
  keyPrefix: string,
  renderCitation?: MarkdownCitationRenderer
): ReactNode[] {
  const nodes: ReactNode[] = [];
  const inlinePattern =
    /((?<!\\)\\\((?:[^\\\n`]|\\(?!\)))*\\\)|\\[\u0021-\u002f\u003a-\u0040\u005b-\u0060\u007b-\u007e]|`[^`]+`|\[[^\]]+\]\(((?:[^()\s]|\([^()\s]*\))+)\)|\*\*[^*]+\*\*|(?<!\\)\$(?![$\s])(?:\\.|[^$\\\n`])*?(?<![\s\\])\$(?!\d)|~~[^~]+~~|\*[^*\n]+\*|(?<![A-Za-z0-9])_[^_\n]+_(?![A-Za-z0-9]))/g;
  let lastIndex = 0;
  let match = inlinePattern.exec(text);

  while (match) {
    if (match.index > lastIndex) {
      nodes.push(...renderPlainInline(
        text.slice(lastIndex, match.index),
        `${keyPrefix}-plain-${lastIndex}`,
        renderCitation
      ));
    }

    const token = match[0];

    if (/^\\[\u0021-\u002f\u003a-\u0040\u005b-\u0060\u007b-\u007e]$/.test(token)) {
      // An escaped marker is a text node, never another parser input.
      nodes.push(token.slice(1));
    } else if (token.startsWith("\\(") && token.endsWith("\\)")) {
      nodes.push(
        <MathExpression
          displayMode={false}
          key={`${keyPrefix}-math-${match.index}`}
          raw={token}
          source={token.slice(2, -2)}
        />
      );
    } else if (token.startsWith("$") && token.endsWith("$")) {
      nodes.push(
        <MathExpression
          displayMode={false}
          key={`${keyPrefix}-math-${match.index}`}
          raw={token}
          source={token.slice(1, -1)}
        />
      );
    } else if (token.startsWith("**") && token.endsWith("**")) {
      nodes.push(
        <strong className="font-semibold text-ink" key={`${keyPrefix}-strong-${match.index}`}>
          {renderPlainInline(token.slice(2, -2), `${keyPrefix}-strong-${match.index}`, renderCitation)}
        </strong>
      );
    } else if (token.startsWith("`") && token.endsWith("`")) {
      nodes.push(
        <code
          className="break-words rounded-control bg-control-pressed px-1 py-0.5 font-mono text-[0.9em] text-ink [overflow-wrap:anywhere]"
          key={`${keyPrefix}-code-${match.index}`}
        >
          {token.slice(1, -1)}
        </code>
      );
    } else if (token.startsWith("[") && token.includes("](")) {
      const label = token.slice(1, token.indexOf("]("));
      const href = safeExternalHref(match[2]);

      nodes.push(
        href ? (
          <a
            className="break-words text-proof underline decoration-proof/40 underline-offset-2 hover:decoration-proof [overflow-wrap:anywhere]"
            href={href}
            key={`${keyPrefix}-link-${match.index}`}
            rel="noreferrer"
            target="_blank"
          >
            {label}
          </a>
        ) : (
          token
        )
      );
    } else if (token.startsWith("~~") && token.endsWith("~~")) {
      nodes.push(
        <del className="text-ink-muted" key={`${keyPrefix}-del-${match.index}`}>
          {renderPlainInline(token.slice(2, -2), `${keyPrefix}-del-${match.index}`, renderCitation)}
        </del>
      );
    } else {
      nodes.push(
        <em className="italic text-ink" key={`${keyPrefix}-em-${match.index}`}>
          {renderPlainInline(token.slice(1, -1), `${keyPrefix}-em-${match.index}`, renderCitation)}
        </em>
      );
    }

    lastIndex = match.index + token.length;
    match = inlinePattern.exec(text);
  }

  if (lastIndex < text.length) {
    nodes.push(...renderPlainInline(
      text.slice(lastIndex),
      `${keyPrefix}-plain-${lastIndex}`,
      renderCitation
    ));
  }

  return nodes;
}

function headingClass(level: number): string {
  if (level === 1) {
    return "pt-2 text-lg leading-8";
  }

  if (level === 2) {
    return "pt-2 text-[17px] leading-8";
  }

  if (level === 3) {
    return "pt-1.5 text-base leading-7";
  }

  if (level === 4) {
    return "pt-1 text-[15px] leading-7";
  }

  return "pt-1 text-sm leading-6";
}

function renderHeading(
  line: string,
  keyPrefix: string,
  renderCitation?: MarkdownCitationRenderer
): ReactNode | null {
  const heading = /^(#{1,6})\s+(.+)$/.exec(line.trim());
  if (!heading) {
    return null;
  }

  const level = heading[1].length;
  const className = `${headingClass(level)} break-words font-semibold text-ink first:pt-0 [overflow-wrap:anywhere]`;
  const children = renderInline(heading[2], `${keyPrefix}-heading`, renderCitation);

  switch (level) {
    case 1:
      return (
        <h2 className={className} key={keyPrefix}>
          {children}
        </h2>
      );
    case 2:
      return (
        <h3 className={className} key={keyPrefix}>
          {children}
        </h3>
      );
    case 3:
      return (
        <h4 className={className} key={keyPrefix}>
          {children}
        </h4>
      );
    case 4:
      return (
        <h5 className={className} key={keyPrefix}>
          {children}
        </h5>
      );
    default:
      return (
        <h6 className={className} key={keyPrefix}>
          {children}
        </h6>
      );
  }
}

function parseListLine(line: string): ListLine | null {
  const match = /^(\s*)([-*+]|\d+\.)\s+(.+)$/.exec(line);
  if (!match) {
    return null;
  }

  return {
    content: match[3],
    indent: match[1].replace(/\t/g, "  ").length,
    ordered: /^\d+\.$/.test(match[2])
  };
}

function parseList(lines: string[], startIndex: number, baseIndent?: number): { block: ListBlock; nextIndex: number } {
  const first = parseListLine(lines[startIndex]);
  if (!first) {
    return {
      block: {
        items: [],
        ordered: false
      },
      nextIndex: startIndex
    };
  }

  const indent = baseIndent ?? first.indent;
  const block: ListBlock = {
    items: [],
    ordered: first.ordered
  };
  let index = startIndex;

  while (index < lines.length) {
    const parsed = parseListLine(lines[index]);
    if (!parsed) {
      break;
    }

    if (parsed.indent < indent) {
      break;
    }

    if (parsed.indent > indent) {
      const lastItem = block.items.at(-1);
      if (!lastItem) {
        break;
      }

      const child = parseList(lines, index, parsed.indent);
      lastItem.children.push(child.block);
      index = child.nextIndex;
      continue;
    }

    if (parsed.ordered !== block.ordered) {
      break;
    }

    block.items.push({
      children: [],
      content: parsed.content
    });
    index += 1;
  }

  return {
    block,
    nextIndex: index
  };
}

function renderList(
  block: ListBlock,
  keyPrefix: string,
  renderCitation?: MarkdownCitationRenderer
): ReactNode {
  const Tag = block.ordered ? "ol" : "ul";
  const className = block.ordered
    ? "list-decimal space-y-1 break-words pl-5 marker:text-ink-muted [overflow-wrap:anywhere]"
    : "list-disc space-y-1 break-words pl-5 marker:text-ink-muted [overflow-wrap:anywhere]";

  return (
    <Tag className={className} key={keyPrefix}>
      {block.items.map((item, index) => (
        <li key={`${keyPrefix}-item-${index}`}>
          {renderInline(item.content, `${keyPrefix}-item-${index}`, renderCitation)}
          {item.children.map((child, childIndex) => (
            <div className="mt-1" key={`${keyPrefix}-item-${index}-child-${childIndex}`}>
              {renderList(child, `${keyPrefix}-item-${index}-child-${childIndex}`, renderCitation)}
            </div>
          ))}
        </li>
      ))}
    </Tag>
  );
}

function tableRowCells(line: string): string[] {
  return line
    .trim()
    .replace(/^\|/, "")
    .replace(/\|$/, "")
    .split("|")
    .map((cell) => cell.trim());
}

function isTableDelimiter(line: string): boolean {
  const cells = tableRowCells(line);

  return cells.length > 1 && cells.every((cell) => /^:?-{3,}:?$/.test(cell));
}

function isTableStart(lines: string[], index: number): boolean {
  return lines[index]?.includes("|") && isTableDelimiter(lines[index + 1] ?? "");
}

function renderTable(
  lines: string[],
  startIndex: number,
  keyPrefix: string,
  renderCitation?: MarkdownCitationRenderer
): { nextIndex: number; node: ReactNode } {
  const headerCells = tableRowCells(lines[startIndex]);
  const rows: string[][] = [];
  let index = startIndex + 2;

  while (index < lines.length && lines[index].includes("|") && lines[index].trim()) {
    rows.push(tableRowCells(lines[index]));
    index += 1;
  }

  return {
    nextIndex: index,
    node: (
      <div
        className="max-w-full overflow-x-auto rounded-control border border-trace-subtle outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-focus"
        data-testid="markdown-table-scroll"
        key={keyPrefix}
        role="region"
        aria-label="Scrollable table"
        tabIndex={0}
      >
        <table className="min-w-full border-collapse text-left text-xs">
          <thead className="border-b border-trace-strong text-ink-secondary">
            <tr>
              {headerCells.map((cell, cellIndex) => (
                <th className="border-b border-r border-trace-subtle bg-answer-paper px-3 py-2 font-semibold last:border-r-0" key={`${keyPrefix}-th-${cellIndex}`}>
                  {renderInline(cell, `${keyPrefix}-th-${cellIndex}`, renderCitation)}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((row, rowIndex) => (
              <tr className="border-b border-trace-subtle last:border-b-0" key={`${keyPrefix}-tr-${rowIndex}`}>
                {headerCells.map((_header, cellIndex) => (
                  <td className="border-r border-trace-subtle px-3 py-2 align-top last:border-r-0" key={`${keyPrefix}-td-${rowIndex}-${cellIndex}`}>
                    {renderInline(
                      row[cellIndex] ?? "",
                      `${keyPrefix}-td-${rowIndex}-${cellIndex}`,
                      renderCitation
                    )}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    )
  };
}

function isHorizontalRule(line: string): boolean {
  return /^(-{3,}|\*{3,}|_{3,})$/.test(line.trim());
}

function parseDisplayMath(lines: string[], startIndex: number): DisplayMathBlock | null {
  const openingLine = lines[startIndex]?.trim() ?? "";
  const delimiter = openingLine.startsWith("\\[")
    ? { close: "\\]", open: "\\[" }
    : openingLine.startsWith("$$") && !openingLine.startsWith("$$$")
      ? { close: "$$", open: "$$" }
      : null;

  if (!delimiter) {
    return null;
  }

  const sourceLines: string[] = [];
  let index = startIndex;

  while (index < lines.length) {
    const candidate = index === startIndex ? openingLine.slice(delimiter.open.length) : lines[index];
    const closeIndex = candidate.lastIndexOf(delimiter.close);

    if (closeIndex >= 0 && !candidate.slice(closeIndex + delimiter.close.length).trim()) {
      sourceLines.push(candidate.slice(0, closeIndex));

      const source = sourceLines.join("\n").trim();
      if (!source) {
        return null;
      }

      return {
        nextIndex: index + 1,
        raw: lines.slice(startIndex, index + 1).join("\n"),
        source
      };
    }

    sourceLines.push(candidate);
    index += 1;
  }

  return null;
}

function isPotentialDisplayMathStart(line: string): boolean {
  const trimmed = line.trim();
  return trimmed.startsWith("\\[") || (trimmed.startsWith("$$") && !trimmed.startsWith("$$$"));
}

function isBlockStart(lines: string[], index: number): boolean {
  const line = lines[index] ?? "";

  return Boolean(
    renderHeading(line, "probe") ||
      parseListLine(line) ||
      line.trim().startsWith(">") ||
      isTableStart(lines, index) ||
      isHorizontalRule(line) ||
      isPotentialDisplayMathStart(line)
  );
}

function renderTextLines(
  markdown: string,
  keyPrefix: string,
  renderCitation?: MarkdownCitationRenderer
): ReactNode[] {
  const lines = markdown.replace(/\r\n/g, "\n").split("\n");
  const nodes: ReactNode[] = [];
  let index = 0;

  while (index < lines.length) {
    if (!lines[index].trim()) {
      index += 1;
      continue;
    }

    const displayMath = parseDisplayMath(lines, index);
    if (displayMath) {
      nodes.push(
        <MathExpression
          displayMode
          key={`${keyPrefix}-math-${index}`}
          raw={displayMath.raw}
          source={displayMath.source}
        />
      );
      index = displayMath.nextIndex;
      continue;
    }

    const heading = renderHeading(lines[index], `${keyPrefix}-h-${index}`, renderCitation);
    if (heading) {
      nodes.push(heading);
      index += 1;
      continue;
    }

    if (isHorizontalRule(lines[index])) {
      nodes.push(<hr className="border-trace-subtle" key={`${keyPrefix}-hr-${index}`} />);
      index += 1;
      continue;
    }

    if (lines[index].trim().startsWith(">")) {
      const quoteLines: string[] = [];
      while (index < lines.length && lines[index].trim().startsWith(">")) {
        quoteLines.push(lines[index].replace(/^\s*>\s?/, ""));
        index += 1;
      }

      nodes.push(
        <blockquote className="space-y-2 border-l-2 border-proof/40 pl-4 text-ink-secondary" key={`${keyPrefix}-quote-${index}`}>
          {renderTextLines(quoteLines.join("\n"), `${keyPrefix}-quote-${index}`, renderCitation)}
        </blockquote>
      );
      continue;
    }

    if (isTableStart(lines, index)) {
      const table = renderTable(lines, index, `${keyPrefix}-table-${index}`, renderCitation);
      nodes.push(table.node);
      index = table.nextIndex;
      continue;
    }

    if (parseListLine(lines[index])) {
      const list = parseList(lines, index);
      nodes.push(renderList(list.block, `${keyPrefix}-list-${index}`, renderCitation));
      index = list.nextIndex;
      continue;
    }

    const paragraphLines = [lines[index]];
    index += 1;
    while (index < lines.length && lines[index].trim() && !isBlockStart(lines, index)) {
      paragraphLines.push(lines[index]);
      index += 1;
    }

    nodes.push(
      <p className="whitespace-pre-wrap break-words [overflow-wrap:anywhere]" key={`${keyPrefix}-p-${index}`}>
        {renderInline(
          paragraphLines.join("\n").trim(),
          `${keyPrefix}-p-${index}`,
          renderCitation
        )}
      </p>
    );
  }

  return nodes;
}

type MarkdownMessageProps = {
  content: string;
  renderCitation?: MarkdownCitationRenderer;
  streaming?: boolean;
};

function CodeBlock({ code, language, streaming }: { code: string; language: string; streaming: boolean }) {
  const [copied, setCopied] = useState(false);
  const [highlighted, setHighlighted] = useState<{ html: string; key: string } | null>(null);
  const copiedResetRef = useRef<number | null>(null);
  const displayLanguage = resolveCodeLanguage(language);
  const highlightKey = displayLanguage ? `${displayLanguage}\0${code}` : null;
  const highlightedHtml = !streaming && highlighted?.key === highlightKey ? highlighted.html : null;

  useEffect(() => {
    let cancelled = false;

    if (streaming || !displayLanguage || !highlightKey) {
      return () => {
        cancelled = true;
      };
    }

    void highlightCodeBlock(code, language).then((result) => {
      if (!cancelled && result) {
        setHighlighted({ html: result.html, key: highlightKey });
      }
    });

    return () => {
      cancelled = true;
    };
  }, [code, displayLanguage, highlightKey, language, streaming]);

  useEffect(
    () => () => {
      if (copiedResetRef.current !== null) {
        window.clearTimeout(copiedResetRef.current);
      }
    },
    []
  );

  async function copyCode() {
    try {
      await writeClipboardText(code);
      setCopied(true);
      if (copiedResetRef.current !== null) {
        window.clearTimeout(copiedResetRef.current);
      }
      copiedResetRef.current = window.setTimeout(() => setCopied(false), 1600);
    } catch {
      setCopied(false);
    }
  }

  return (
    <div className="group/code min-w-0 max-w-full overflow-hidden rounded-panel border border-trace-subtle bg-answer-paper">
      <div className="flex min-h-control items-center justify-between gap-3 border-b border-trace-subtle px-3">
        {displayLanguage ? (
          <span className="truncate font-mono text-metadata text-ink-secondary">{displayLanguage}</span>
        ) : (
          <span aria-hidden="true" />
        )}
        <button
          className="inline-flex h-touch items-center gap-1.5 rounded-control px-2 text-metadata text-ink-secondary outline-none hover:bg-control-hover hover:text-ink focus-visible:ring-2 focus-visible:ring-focus [@media(hover:none)]:!h-touch [@media(pointer:coarse)]:!h-touch sm:h-control-sm"
          type="button"
          aria-label="Copy code"
          onClick={() => void copyCode()}
        >
          {copied ? (
            <Check className="size-3 text-positive" aria-hidden="true" />
          ) : (
            <Copy className="size-3" aria-hidden="true" />
          )}
          {copied ? "Copied" : "Copy"}
        </button>
      </div>
      {highlightedHtml ? (
        <div
          className="max-w-full overflow-x-auto p-3 font-mono text-xs leading-5 text-ink outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-focus [overflow-wrap:normal] [&_code]:font-mono [&_pre]:!m-0 [&_pre]:!bg-transparent [&_pre]:!p-0"
          data-testid="markdown-code-scroll"
          role="region"
          aria-label="Scrollable code block"
          tabIndex={0}
          dangerouslySetInnerHTML={{ __html: highlightedHtml }}
        />
      ) : (
        <pre
          className="max-w-full overflow-x-auto p-3 font-mono text-xs leading-5 text-ink outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-focus [overflow-wrap:normal]"
          data-testid="markdown-code-scroll"
          role="region"
          aria-label="Scrollable code block"
          tabIndex={0}
        >
          <code>{code}</code>
        </pre>
      )}
      <span className="sr-only" role="status">
        {copied ? "Copied" : ""}
      </span>
    </div>
  );
}

function MarkdownMessageComponent({
  content,
  renderCitation,
  streaming = false
}: MarkdownMessageProps) {
  return (
    <div className="min-w-0 space-y-4">
      {splitMarkdown(content).map((part, index) => {
        if (part.type === "code") {
          return <CodeBlock code={part.code} language={part.language} streaming={streaming} key={`${part.type}-${index}`} />;
        }

        return renderTextLines(part.text, `${part.type}-${index}`, renderCitation);
      })}
    </div>
  );
}

export const MarkdownMessage = memo(MarkdownMessageComponent);
