import { parseFragment, serialize } from "parse5";
import {
  GEMINI_SEARCH_SUGGESTIONS_LIMITS,
  geminiSearchSuggestionAttributes,
  hasUnsafeGeminiSuggestionControls,
  isValidGeminiSearchSuggestionAttribute
} from "../../domain/geminiSearchSuggestions";

type HtmlNode = {
  attrs?: { name: string; value: string }[];
  childNodes?: HtmlNode[];
  nodeName?: string;
  tagName?: string;
  value?: string;
};

function invalidGroundingHtml(): never {
  throw new Error("gemini_interactions_grounding_html_invalid");
}

function isValidStyleAttribute(name: string, value: string): boolean {
  return (
    name === "type" &&
    value === "text/css" &&
    value.length <= GEMINI_SEARCH_SUGGESTIONS_LIMITS.maxAttributeValueLength
  );
}

function removeStyleNodes(node: HtmlNode): void {
  if (!node.childNodes) return;

  node.childNodes = node.childNodes.filter((child) => {
    const tagName = (child.tagName ?? child.nodeName ?? "").toLowerCase();
    if (tagName === "style") return false;
    removeStyleNodes(child);
    return true;
  });
}

export function validateGeminiSearchSuggestionsHtml(value: unknown): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    Buffer.byteLength(value, "utf8") > GEMINI_SEARCH_SUGGESTIONS_LIMITS.maxHtmlBytes ||
    hasUnsafeGeminiSuggestionControls(value)
  ) {
    invalidGroundingHtml();
  }

  const parseErrors: unknown[] = [];
  const fragment = parseFragment(value, {
    onParseError(error) {
      parseErrors.push(error);
    }
  });
  if (parseErrors.length > 0) invalidGroundingHtml();

  let attributeCount = 0;
  let nodeCount = 0;
  let googleLinkCount = 0;

  function visit(node: HtmlNode, depth: number, parentTag?: string): void {
    nodeCount += 1;
    if (
      nodeCount > GEMINI_SEARCH_SUGGESTIONS_LIMITS.maxNodes ||
      depth > GEMINI_SEARCH_SUGGESTIONS_LIMITS.maxDepth
    ) {
      invalidGroundingHtml();
    }

    const nodeName = node.nodeName ?? "";
    if (nodeName === "#comment" || nodeName === "#documentType") {
      invalidGroundingHtml();
    }
    if (nodeName === "#text") {
      if (parentTag !== "style" && hasUnsafeGeminiSuggestionControls(node.value ?? "")) {
        invalidGroundingHtml();
      }
      return;
    }
    if (nodeName !== "#document-fragment") {
      const tagName = (node.tagName ?? nodeName).toLowerCase();
      const projectedAttributes = geminiSearchSuggestionAttributes(tagName);
      if (!projectedAttributes && tagName !== "style") invalidGroundingHtml();

      const attributes = node.attrs ?? [];
      attributeCount += attributes.length;
      if (attributeCount > GEMINI_SEARCH_SUGGESTIONS_LIMITS.maxAttributes) {
        invalidGroundingHtml();
      }

      const seen = new Set<string>();
      for (const attribute of attributes) {
        const name = attribute.name.toLowerCase();
        const isValid = tagName === "style"
          ? isValidStyleAttribute(name, attribute.value)
          : Boolean(
              projectedAttributes?.includes(name) &&
              isValidGeminiSearchSuggestionAttribute(tagName, name, attribute.value)
            );
        if (seen.has(name) || !isValid) invalidGroundingHtml();
        seen.add(name);
        if (tagName === "a" && name === "href") googleLinkCount += 1;
      }
      if (tagName === "a" && !seen.has("href")) invalidGroundingHtml();
      if (
        tagName === "style" &&
        (node.childNodes ?? []).some((child) => child.nodeName !== "#text")
      ) {
        invalidGroundingHtml();
      }
      parentTag = tagName;
    }

    for (const child of node.childNodes ?? []) {
      visit(child, depth + 1, parentTag);
    }
  }

  visit(fragment as HtmlNode, 0);
  if (googleLinkCount === 0) invalidGroundingHtml();

  removeStyleNodes(fragment as HtmlNode);
  const projection = serialize(fragment);
  if (
    projection.length === 0 ||
    Buffer.byteLength(projection, "utf8") > GEMINI_SEARCH_SUGGESTIONS_LIMITS.maxHtmlBytes
  ) {
    invalidGroundingHtml();
  }

  return projection;
}
