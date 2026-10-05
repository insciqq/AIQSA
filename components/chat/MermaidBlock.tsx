"use client";

import { Download } from "lucide-react";
import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from "react";
import { CODE_CHROME_BUTTON_CLASS, CodeCopyButton } from "./CodeCopyButton";
import {
  fitSvgToDrawing,
  MERMAID_DIAGRAM_TYPOGRAPHY,
  MERMAID_SOURCE_MAX_CHARACTERS,
  renderMermaidDiagram,
  type MermaidColorScheme,
  type MermaidFailureReason,
  type MermaidRenderResult
} from "./mermaidRendering";

const FAILURE_NOTES: Record<MermaidFailureReason, string> = {
  invalid: "Diagram could not be rendered.",
  timeout: "Diagram could not be rendered: it took too long.",
  too_large: `Diagram could not be rendered: the source is longer than ${MERMAID_SOURCE_MAX_CHARACTERS.toLocaleString("en-US")} characters.`,
  unavailable: "Diagram could not be rendered: the renderer did not load."
};

const SEGMENT_CLASS =
  "inline-flex h-touch items-center rounded-control px-2 text-metadata outline-none focus-visible:ring-2 focus-visible:ring-focus [@media(hover:none)]:!h-touch [@media(pointer:coarse)]:!h-touch sm:h-control-sm";

function documentColorScheme(): MermaidColorScheme {
  const theme = document.documentElement.dataset.theme;
  if (theme === "dark" || theme === "light") return theme;
  // `system` follows the device, as the semantic tokens do.
  return typeof window.matchMedia === "function" && window.matchMedia("(prefers-color-scheme: dark)").matches
    ? "dark"
    : "light";
}

function subscribeColorScheme(onChange: () => void): () => void {
  const observer = new MutationObserver(onChange);
  observer.observe(document.documentElement, { attributeFilter: ["data-theme", "data-color-scheme"], attributes: true });
  const media = typeof window.matchMedia === "function" ? window.matchMedia("(prefers-color-scheme: dark)") : null;
  media?.addEventListener("change", onChange);
  return () => {
    observer.disconnect();
    media?.removeEventListener("change", onChange);
  };
}

function useDocumentColorScheme(): MermaidColorScheme {
  return useSyncExternalStore(subscribeColorScheme, documentColorScheme, () => "light");
}

function downloadSvg(svg: string) {
  const url = URL.createObjectURL(new Blob([svg], { type: "image/svg+xml" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = "diagram.svg";
  link.rel = "noopener";
  document.body.append(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 0);
}

type RenderedState = { code: string; result: MermaidRenderResult; scheme: MermaidColorScheme };

/**
 * A closed ```mermaid fence: the source stays visible until the diagram is
 * ready, and remains the fallback when it cannot be rendered.
 */
export function MermaidBlock({ code, language }: { code: string; language: string }) {
  const scheme = useDocumentColorScheme();
  const [rendered, setRendered] = useState<RenderedState | null>(null);
  const [view, setView] = useState<"code" | "diagram">("diagram");

  useEffect(() => {
    let cancelled = false;
    void renderMermaidDiagram(code, scheme).then((result) => {
      if (!cancelled) setRendered({ code, result, scheme });
    });
    return () => {
      cancelled = true;
    };
  }, [code, scheme]);

  // During a theme switch the previous diagram stays until its replacement is ready.
  const result = rendered?.code === code ? rendered.result : null;
  const svg = result?.ok ? result.svg : null;
  const failure = result && !result.ok ? result.reason : null;
  const showDiagram = svg !== null && view === "diagram";
  const state = svg !== null ? "rendered" : failure ? "failed" : "pending";
  const diagramRef = useRef<HTMLDivElement>(null);

  // Fit the viewBox to the drawing where it is shown, and again once web
  // fonts settle, so the diagram is never offset or clipped by its box.
  useLayoutEffect(() => {
    const host = diagramRef.current;
    if (!showDiagram || !host) return;
    let active = true;
    const fit = () => {
      const root = host.querySelector(":scope > svg");
      if (active && root instanceof SVGSVGElement) fitSvgToDrawing(root);
    };
    fit();
    void document.fonts?.ready.then(fit);
    return () => {
      active = false;
    };
  }, [showDiagram, svg]);

  return (
    <div
      className="min-w-0 max-w-full overflow-hidden rounded-panel border border-trace-subtle bg-answer-paper"
      data-markdown-code-language={language}
      // Quoting a rendered diagram quotes its source.
      data-markdown-code-source={showDiagram ? code : undefined}
      data-mermaid-state={state}
      data-testid="mermaid-block"
    >
      <div className="flex min-h-control flex-wrap items-center justify-between gap-x-3 gap-y-1 border-b border-trace-subtle px-3" data-markdown-chrome="">
        <span className="truncate font-mono text-metadata text-ink-secondary">mermaid</span>
        <div className="flex flex-wrap items-center justify-end gap-1">
          {svg !== null ? (
            <div className="flex items-center gap-0.5" role="group" aria-label="Diagram view">
              {(["diagram", "code"] as const).map((option) => (
                <button
                  aria-pressed={view === option}
                  className={`${SEGMENT_CLASS} ${view === option ? "bg-control-pressed text-ink" : "text-ink-secondary hover:bg-control-hover hover:text-ink"}`}
                  key={option}
                  type="button"
                  onClick={() => setView(option)}
                >
                  {option === "diagram" ? "Diagram" : "Code"}
                </button>
              ))}
            </div>
          ) : null}
          <CodeCopyButton label="Copy diagram source" text={code} />
          {svg !== null ? (
            <button
              className={CODE_CHROME_BUTTON_CLASS}
              type="button"
              aria-label="Download SVG"
              onClick={() => downloadSvg(svg)}
            >
              <Download className="size-3" aria-hidden="true" />
              SVG
            </button>
          ) : null}
        </div>
      </div>
      {showDiagram ? (
        <div
          // Paint containment keeps any diagram box, even a fixed one, inside this frame.
          className="max-w-full overflow-x-auto p-3 outline-none [contain:paint] focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-focus [&>svg]:mx-auto [&>svg]:block [&>svg]:max-w-none"
          // Diagram labels are drawing, not answer text for comment offsets.
          data-markdown-chrome=""
          data-testid="mermaid-diagram-scroll"
          ref={diagramRef}
          role="region"
          aria-label="Scrollable diagram"
          // The typography the diagram was measured with, not the answer's.
          style={MERMAID_DIAGRAM_TYPOGRAPHY}
          tabIndex={0}
          dangerouslySetInnerHTML={{ __html: svg }}
        />
      ) : (
        <pre
          aria-busy={state === "pending"}
          className="max-w-full overflow-x-auto p-3 font-mono text-xs leading-5 text-ink outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-focus [overflow-wrap:normal]"
          data-testid="markdown-code-scroll"
          role="region"
          aria-label="Scrollable code block"
          tabIndex={0}
        >
          <code>{code}</code>
        </pre>
      )}
      {failure ? (
        <p
          className="border-t border-trace-subtle px-3 py-2 text-metadata text-ink-secondary"
          data-markdown-chrome=""
          data-testid="mermaid-fallback-note"
        >
          {FAILURE_NOTES[failure]}
        </p>
      ) : null}
    </div>
  );
}
