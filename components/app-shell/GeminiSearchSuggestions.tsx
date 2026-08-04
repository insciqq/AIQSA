"use client";

import { useEffect, useRef } from "react";

const maxSuggestionBytes = 256 * 1024;
const maxSuggestionNodes = 512;
const allowedAttributes = new Map<string, ReadonlySet<string>>([
  ["a", new Set(["class", "href", "rel", "target"])],
  ["circle", new Set(["class", "cx", "cy", "fill", "r"])],
  ["div", new Set(["class"])],
  ["path", new Set(["class", "clip-rule", "d", "fill", "fill-rule"])],
  ["style", new Set(["type"])],
  ["svg", new Set(["class", "fill", "height", "viewbox", "width", "xmlns"])]
]);

function safeGoogleHref(value: string): boolean {
  if (!value || value.length > 2_048 || /[\u0000-\u0020\u007f]/u.test(value)) {
    return false;
  }
  try {
    const url = new URL(value);
    return url.protocol === "https:" &&
      !url.username &&
      !url.password &&
      !url.port &&
      (url.hostname === "google.com" || url.hostname.endsWith(".google.com"));
  } catch {
    return false;
  }
}

function safeStyleText(value: string): boolean {
  return new TextEncoder().encode(value).byteLength <= maxSuggestionBytes && !(
    /@import|url\s*\(|expression\s*\(|javascript\s*:|behavior\s*:|position\s*:\s*(?:fixed|sticky)|:host|::part|::slotted/iu
      .test(value)
  );
}

function validatedSuggestionFragment(html: string): DocumentFragment | null {
  if (!html || new TextEncoder().encode(html).byteLength > maxSuggestionBytes) {
    return null;
  }
  const template = document.createElement("template");
  template.innerHTML = html;
  const walker = document.createTreeWalker(template.content, NodeFilter.SHOW_ALL);
  let nodeCount = 0;
  let node: Node | null = walker.nextNode();
  while (node) {
    nodeCount += 1;
    if (nodeCount > maxSuggestionNodes) return null;
    if (node.nodeType === Node.COMMENT_NODE) return null;
    if (node.nodeType === Node.ELEMENT_NODE) {
      const element = node as Element;
      const tag = element.localName.toLowerCase();
      const attributes = allowedAttributes.get(tag);
      if (!attributes) return null;
      for (const attribute of [...element.attributes]) {
        const name = attribute.name.toLowerCase();
        if (!attributes.has(name) || name.startsWith("on")) return null;
        if (name === "href" && !safeGoogleHref(attribute.value)) return null;
        if (tag === "a" && name === "target" && attribute.value !== "_blank") return null;
        if (tag === "a" && name === "rel") {
          const rel = attribute.value.toLowerCase().split(/\s+/u).filter(Boolean);
          if (!rel.length || rel.some((token) => token !== "noopener" && token !== "noreferrer")) {
            return null;
          }
        }
        if (tag === "style" && name === "type" && attribute.value !== "text/css") return null;
      }
      if (tag === "style" && !safeStyleText(element.textContent ?? "")) return null;
    } else if (
      node.nodeType !== Node.TEXT_NODE &&
      node.nodeType !== Node.DOCUMENT_FRAGMENT_NODE
    ) {
      return null;
    }
    node = walker.nextNode();
  }
  return template.content;
}

export function GeminiSearchSuggestions({ html }: Readonly<{ html: string }>) {
  const hostRef = useRef<HTMLDivElement>(null);
  const invalidRef = useRef<HTMLParagraphElement>(null);

  useEffect(() => {
    const host = hostRef.current;
    const invalid = invalidRef.current;
    if (!host || !invalid) return;
    const fragment = validatedSuggestionFragment(html);
    if (!fragment) {
      host.hidden = true;
      invalid.hidden = false;
      host.shadowRoot?.replaceChildren();
      return;
    }
    host.hidden = false;
    invalid.hidden = true;
    const shadow = host.shadowRoot ?? host.attachShadow({ mode: "open" });
    shadow.replaceChildren(fragment.cloneNode(true));
    return () => shadow.replaceChildren();
  }, [html]);

  return (
    <aside
      className="mt-5 overflow-hidden rounded-panel border border-trace-subtle bg-control-surface/45 px-3 py-3"
      data-testid="gemini-search-suggestions"
    >
      <p className="mb-2 text-metadata font-medium uppercase tracking-[0.08em] text-ink-muted">
        Google Search suggestions
      </p>
      <p className="text-xs leading-5 text-critical" hidden ref={invalidRef} role="alert">
        Search suggestions could not be displayed safely.
      </p>
      <div className="min-w-0" ref={hostRef} />
    </aside>
  );
}
