"use client";

import { safeExternalHref } from "@/lib/domain/links";
import { memo, useEffect, useMemo, useState, type ReactNode } from "react";
import { CodeCopyButton } from "./CodeCopyButton";
import { highlightCodeBlock, resolveCodeLanguage } from "./codeHighlighting";
import { parseMarkdown, type MarkdownBlock, type MarkdownInline } from "./markdownParser";
import { renderMathExpression } from "./mathRendering";
import { MermaidBlock } from "./MermaidBlock";
import { isMermaidLanguage } from "./mermaidRendering";

// Deep structures retain their semantics without consuming the whole phone viewport.
const MAX_INDENT_DEPTH = 8;

const PARAGRAPH_CLASS = "whitespace-pre-wrap break-words [overflow-wrap:anywhere]";
const INLINE_CODE_CLASS =
  "break-words rounded-control bg-control-pressed px-1 py-0.5 font-mono text-[0.9em] text-ink [overflow-wrap:anywhere]";
const LINK_CLASS =
  "break-words text-proof underline decoration-proof/40 underline-offset-2 hover:decoration-proof [overflow-wrap:anywhere]";

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
        data-math-source={source}
        dangerouslySetInnerHTML={{ __html: renderedHtml }}
      />
    ) : (
      <span data-math-display="false" data-math-source={source}>{raw}</span>
    );
  }

  return (
    <div
      className="max-w-full overflow-x-auto overflow-y-hidden py-1 text-ink outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-focus [&_.katex-display]:!my-0"
      data-math-display="true"
      data-math-source={source}
      role="region"
      aria-label="Scrollable mathematical formula"
      tabIndex={0}
    >
      {renderedHtml ? <div dangerouslySetInnerHTML={{ __html: renderedHtml }} /> : <span className="whitespace-pre-wrap">{raw}</span>}
    </div>
  );
}

export type MarkdownCitationRenderer = (handle: string, key: string) => ReactNode | null;

/**
 * Resolves a link target the ordinary safe-href allowlist would reject.
 * `{ href }` renders a same-origin link (optionally as a download); `"text"`
 * renders the label as inert inline code instead of a dead link; `null`
 * leaves the ordinary external-link behavior untouched.
 */
export type MarkdownHrefResolver = (
  href: string
) => Readonly<{ download?: string; href: string }> | "text" | null;

type RenderContext = {
  renderCitation?: MarkdownCitationRenderer;
  resolveHref?: MarkdownHrefResolver;
  streaming: boolean;
};

function plainText(nodes: readonly MarkdownInline[]): string {
  return nodes.map((node) => {
    switch (node.type) {
      case "text":
        return node.value;
      case "break":
        return "\n";
      case "inlineCode":
        return node.value;
      case "citation":
        return node.source;
      case "inlineMath":
        return node.raw;
      default:
        return plainText(node.children);
    }
  }).join("");
}

function renderLink(node: Extract<MarkdownInline, { type: "link" }>, key: string, context: RenderContext): ReactNode {
  const resolved = context.resolveHref?.(node.url) ?? null;
  if (resolved === "text") {
    return (
      <code className={INLINE_CODE_CLASS} data-testid="markdown-inert-link" key={key}>
        {plainText(node.children)}
      </code>
    );
  }
  // Citations inside link syntax stay inert text.
  const label = renderInline(node.children, key, context, true);
  if (resolved) {
    return (
      <a
        className={LINK_CLASS}
        data-testid="markdown-resolved-link"
        {...(resolved.download ? { download: resolved.download } : {})}
        href={resolved.href}
        key={key}
      >
        {label}
      </a>
    );
  }
  const href = safeExternalHref(node.url);
  // An unsafe destination keeps rendering as its literal Markdown source.
  return href ? (
    <a className={LINK_CLASS} href={href} key={key} rel="noreferrer" target="_blank">
      {label}
    </a>
  ) : node.source;
}

function renderInline(
  nodes: readonly MarkdownInline[],
  keyPrefix: string,
  context: RenderContext,
  inLink = false
): ReactNode[] {
  return nodes.map((node, index) => {
    const key = `${keyPrefix}-${index}`;
    switch (node.type) {
      case "text":
        return node.value;
      case "break":
        return "\n";
      case "inlineCode":
        return <code className={INLINE_CODE_CLASS} key={key}>{node.value}</code>;
      case "inlineMath":
        return <MathExpression displayMode={false} key={key} raw={node.raw} source={node.source} />;
      case "citation":
        return (!inLink && context.renderCitation?.(node.handle, `${key}-citation`)) || node.source;
      case "strong":
        return <strong className={inLink ? "font-semibold" : "font-semibold text-ink"} key={key}>{renderInline(node.children, key, context, inLink)}</strong>;
      case "emphasis":
        return <em className={inLink ? "italic" : "italic text-ink"} key={key}>{renderInline(node.children, key, context, inLink)}</em>;
      case "delete":
        return <del className="text-ink-muted" key={key}>{renderInline(node.children, key, context, inLink)}</del>;
      case "link":
        return inLink ? plainText(node.children) : renderLink(node, key, context);
    }
  });
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

function renderHeading(level: number, children: ReactNode[], key: string): ReactNode {
  const className = `${headingClass(level)} break-words font-semibold text-ink first:pt-0 [overflow-wrap:anywhere]`;
  // Answers never introduce an h1: Markdown levels shift down by one.
  switch (level) {
    case 1:
      return <h2 className={className} data-markdown-heading={level} key={key}>{children}</h2>;
    case 2:
      return <h3 className={className} data-markdown-heading={level} key={key}>{children}</h3>;
    case 3:
      return <h4 className={className} data-markdown-heading={level} key={key}>{children}</h4>;
    case 4:
      return <h5 className={className} data-markdown-heading={level} key={key}>{children}</h5>;
    default:
      return <h6 className={className} data-markdown-heading={level} key={key}>{children}</h6>;
  }
}

function renderTable(block: Extract<MarkdownBlock, { type: "table" }>, key: string, context: RenderContext): ReactNode {
  return (
    <div
      className="max-w-full overflow-x-auto rounded-control border border-trace-subtle outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-focus"
      data-testid="markdown-table-scroll"
      key={key}
      role="region"
      aria-label="Scrollable table"
      tabIndex={0}
    >
      <table className="min-w-full border-collapse text-left text-xs">
        <thead className="border-b border-trace-strong text-ink-secondary">
          <tr>
            {block.header.map((cell, cellIndex) => (
              <th className="border-b border-r border-trace-subtle bg-answer-paper px-3 py-2 font-semibold last:border-r-0" key={`${key}-th-${cellIndex}`}>
                {renderInline(cell, `${key}-th-${cellIndex}`, context)}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {block.rows.map((row, rowIndex) => (
            <tr className="border-b border-trace-subtle last:border-b-0" key={`${key}-tr-${rowIndex}`}>
              {block.header.map((_header, cellIndex) => (
                <td className="border-r border-trace-subtle px-3 py-2 align-top last:border-r-0" key={`${key}-td-${rowIndex}-${cellIndex}`}>
                  {renderInline(row[cellIndex] ?? [], `${key}-td-${rowIndex}-${cellIndex}`, context)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function renderListItem(
  children: readonly MarkdownBlock[],
  loose: boolean,
  key: string,
  context: RenderContext,
  depth: number
): ReactNode {
  return (
    <li className={loose ? "space-y-1" : undefined} key={key}>
      {children.map((child, index) => {
        const childKey = `${key}-${index}`;
        if (child.type === "paragraph") {
          // Tight items keep their text directly in the list item.
          return loose ? (
            <p className={PARAGRAPH_CLASS} key={childKey}>{renderInline(child.children, childKey, context)}</p>
          ) : renderInline(child.children, childKey, context);
        }
        return <div className="mt-1" key={childKey}>{renderBlock(child, childKey, context, depth)}</div>;
      })}
    </li>
  );
}

/** `depth` counts the block quotes and lists around this block. */
function renderBlock(block: MarkdownBlock, key: string, context: RenderContext, depth: number): ReactNode {
  switch (block.type) {
    case "paragraph":
      return <p className={PARAGRAPH_CLASS} key={key}>{renderInline(block.children, key, context)}</p>;
    case "heading":
      return renderHeading(block.level, renderInline(block.children, key, context), key);
    case "thematicBreak":
      return <hr className="border-trace-subtle" key={key} />;
    case "blockquote":
      return (
        <blockquote className={`space-y-2 text-ink-secondary ${depth < MAX_INDENT_DEPTH ? "border-l-2 border-proof/40 pl-4" : "border-0 pl-0"}`} key={key}>
          {block.children.map((child, index) => renderBlock(child, `${key}-${index}`, context, depth + 1))}
        </blockquote>
      );
    case "list": {
      const Tag = block.ordered ? "ol" : "ul";
      const className = `${block.ordered ? "list-decimal" : "list-disc"} space-y-1 break-words marker:text-ink-muted [overflow-wrap:anywhere] ${depth < MAX_INDENT_DEPTH ? "pl-5" : "list-inside pl-0"}`;
      return (
        <Tag className={className} key={key} start={block.start ?? undefined}>
          {block.items.map((item, index) => renderListItem(item, block.loose, `${key}-${index}`, context, depth + 1))}
        </Tag>
      );
    }
    case "code":
      // While streaming, an unclosed fence stays partial text with no highlighting.
      if (context.streaming && !block.closed) {
        return (
          <p className={PARAGRAPH_CLASS} key={key}>
            {block.code ? `${block.opening}\n${block.code.replace(/\n$/u, "")}` : block.opening}
          </p>
        );
      }
      // Only a closed fence becomes a diagram; its source can no longer change.
      return block.closed && isMermaidLanguage(block.language) ? (
        <MermaidBlock code={block.code} key={key} language={block.language} />
      ) : (
        <CodeBlock code={block.code} key={key} language={block.language} streaming={context.streaming} />
      );
    case "math":
      return <MathExpression displayMode key={key} raw={block.raw} source={block.source} />;
    case "table":
      return renderTable(block, key, context);
    case "literal":
      return <p className={PARAGRAPH_CLASS} key={key}>{block.value}</p>;
  }
}

type MarkdownMessageProps = {
  content: string;
  renderCitation?: MarkdownCitationRenderer;
  resolveHref?: MarkdownHrefResolver;
  streaming?: boolean;
};

function CodeBlock({ code, language, streaming }: { code: string; language: string; streaming: boolean }) {
  const [highlighted, setHighlighted] = useState<{ html: string; key: string } | null>(null);
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

  return (
    <div className="group/code min-w-0 max-w-full overflow-hidden rounded-panel border border-trace-subtle bg-answer-paper" data-markdown-code-language={language}>
      <div className="flex min-h-control items-center justify-between gap-3 border-b border-trace-subtle px-3" data-markdown-chrome="">
        {displayLanguage ? (
          <span className="truncate font-mono text-metadata text-ink-secondary">{displayLanguage}</span>
        ) : (
          <span aria-hidden="true" />
        )}
        <CodeCopyButton label="Copy code" text={code} />
      </div>
      {highlightedHtml ? (
        <div
          className="max-w-full overflow-x-auto p-3 font-mono text-xs leading-5 text-ink outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-focus [overflow-wrap:normal] [&_code]:font-mono [&_pre]:!m-0 [&_pre]:!overflow-visible [&_pre]:!bg-transparent [&_pre]:!p-0"
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
    </div>
  );
}

/** Parse and convert without letting a parser or conversion failure reach the caller. */
function renderMarkdown(content: string, context: RenderContext): ReactNode[] {
  try {
    const document = parseMarkdown(content, { streaming: context.streaming });
    if (document) {
      const nodes = document.blocks.map((block, index) => renderBlock(block, `markdown-${index}`, context, 0));
      if (document.overflow) {
        nodes.push(<p className={PARAGRAPH_CLASS} key="markdown-overflow">{document.overflow}</p>);
      }
      return nodes;
    }
  } catch {
    // Fall through to the plain-text rendering below.
  }
  return [<p className={PARAGRAPH_CLASS} key="markdown-plain">{content}</p>];
}

function MarkdownMessageComponent({
  content,
  renderCitation,
  resolveHref,
  streaming = false
}: MarkdownMessageProps) {
  const nodes = useMemo(
    () => renderMarkdown(content, { renderCitation, resolveHref, streaming }),
    [content, renderCitation, resolveHref, streaming]
  );
  return (
    <div className="min-w-0 space-y-4">
      {nodes}
    </div>
  );
}

export const MarkdownMessage = memo(MarkdownMessageComponent);
