"use client";

import {
  GEMINI_SEARCH_SUGGESTIONS_LIMITS,
  geminiSearchSuggestionAttributes,
  hasUnsafeGeminiSuggestionControls,
  isValidGeminiSearchSuggestionAttribute
} from "@/lib/domain/geminiSearchSuggestions";
import { useEffect, useId, useRef } from "react";

const suggestionStyles = `
:host {
  display: block;
  contain: layout paint style;
  inline-size: 100%;
  max-inline-size: 100%;
  min-inline-size: 0;
  overflow: hidden;
  color: var(--v2-color-text);
  font: inherit;
}

*, *::before, *::after {
  box-sizing: border-box;
  max-inline-size: 100%;
}

[data-aiqsa-suggestions-content="true"] {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 0.5rem;
  min-inline-size: 0;
  max-inline-size: 100%;
  overflow: hidden;
}

[data-aiqsa-suggestions-content="true"] div {
  display: contents;
}

[data-aiqsa-suggestions-content="true"] a {
  display: inline-flex;
  align-items: center;
  gap: 0.5rem;
  min-block-size: 44px;
  max-inline-size: 100%;
  padding: 0.625rem 0.75rem;
  border: 1px solid var(--v2-color-border2);
  border-radius: var(--v2-radius-s);
  background: var(--v2-color-surface2);
  color: var(--v2-color-text);
  font: inherit;
  line-height: 1.35;
  overflow-wrap: anywhere;
  text-decoration: none;
  white-space: normal;
}

[data-aiqsa-suggestions-content="true"] a:hover {
  background: var(--v2-color-hover);
}

[data-aiqsa-suggestions-content="true"] a:focus-visible {
  outline: 2px solid var(--v2-color-accent);
  outline-offset: -2px;
}

[data-aiqsa-suggestions-content="true"] svg {
  display: block;
  flex: none;
  inline-size: 1.125rem;
  block-size: 1.125rem;
  max-inline-size: 1.125rem;
  max-block-size: 1.125rem;
  overflow: hidden;
}
`;

type ValidationState = {
  attributeCount: number;
  googleLinkCount: number;
  nodeCount: number;
};

function validateSuggestionNode(
  node: Node,
  depth: number,
  state: ValidationState
): boolean {
  state.nodeCount += 1;
  if (
    state.nodeCount > GEMINI_SEARCH_SUGGESTIONS_LIMITS.maxNodes ||
    depth > GEMINI_SEARCH_SUGGESTIONS_LIMITS.maxDepth
  ) {
    return false;
  }

  if (node.nodeType === Node.TEXT_NODE) {
    return !hasUnsafeGeminiSuggestionControls(node.nodeValue ?? "");
  }
  if (node.nodeType === Node.COMMENT_NODE || node.nodeType === Node.DOCUMENT_TYPE_NODE) {
    return false;
  }
  if (
    node.nodeType !== Node.DOCUMENT_FRAGMENT_NODE &&
    node.nodeType !== Node.ELEMENT_NODE
  ) {
    return false;
  }

  if (node.nodeType === Node.ELEMENT_NODE) {
    const element = node as Element;
    const tagName = element.localName.toLowerCase();
    const projectedAttributes = geminiSearchSuggestionAttributes(tagName);
    if (!projectedAttributes) return false;

    state.attributeCount += element.attributes.length;
    if (state.attributeCount > GEMINI_SEARCH_SUGGESTIONS_LIMITS.maxAttributes) {
      return false;
    }

    let hasHref = false;
    for (const attribute of element.attributes) {
      const name = attribute.name.toLowerCase();
      if (
        hasUnsafeGeminiSuggestionControls(attribute.value) ||
        !projectedAttributes.includes(name) ||
        !isValidGeminiSearchSuggestionAttribute(tagName, name, attribute.value)
      ) {
        return false;
      }
      if (tagName === "a" && name === "href") hasHref = true;
    }
    if (tagName === "a") {
      if (!hasHref) return false;
      state.googleLinkCount += 1;
    }
  }

  for (const child of node.childNodes) {
    if (!validateSuggestionNode(child, depth + 1, state)) return false;
  }
  return true;
}

function validatedSuggestionFragment(html: string): DocumentFragment | null {
  if (
    html.length === 0 ||
    new TextEncoder().encode(html).byteLength > GEMINI_SEARCH_SUGGESTIONS_LIMITS.maxHtmlBytes ||
    hasUnsafeGeminiSuggestionControls(html)
  ) {
    return null;
  }

  const template = document.createElement("template");
  template.innerHTML = html;
  const state: ValidationState = { attributeCount: 0, googleLinkCount: 0, nodeCount: 0 };
  if (!validateSuggestionNode(template.content, 0, state) || state.googleLinkCount === 0) {
    return null;
  }
  return template.content;
}

function createSuggestionContent(fragment: DocumentFragment): HTMLDivElement {
  const wrapper = document.createElement("div");
  wrapper.dataset.aiqsaSuggestionsContent = "true";
  wrapper.append(fragment.cloneNode(true));
  for (const svg of wrapper.querySelectorAll("svg")) {
    svg.setAttribute("aria-hidden", "true");
    svg.setAttribute("focusable", "false");
  }
  return wrapper;
}

export function GeminiSearchSuggestionsV2({ html }: Readonly<{ html: string }>) {
  const headingId = useId();
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

    const style = document.createElement("style");
    style.dataset.aiqsaSuggestionsStyle = "true";
    style.textContent = suggestionStyles;
    const content = createSuggestionContent(fragment);
    const shadow = host.shadowRoot ?? host.attachShadow({ mode: "open" });
    shadow.replaceChildren(style, content);
    host.hidden = false;
    invalid.hidden = true;

    return () => shadow.replaceChildren();
  }, [html]);

  return (
    <aside
      aria-labelledby={headingId}
      className="v2-gemini-suggestions"
      data-testid="gemini-search-suggestions"
    >
      <p className="v2-gemini-suggestions-heading" id={headingId}>
        Google Search suggestions
      </p>
      <p className="v2-gemini-suggestions-error" hidden ref={invalidRef} role="alert">
        Search suggestions could not be displayed safely.
      </p>
      <div
        className="v2-gemini-suggestions-host"
        data-testid="gemini-search-suggestions-host"
        ref={hostRef}
      />
    </aside>
  );
}
