import { parseFragment } from "parse5";

const MAX_HTML_BYTES = 256 * 1_024;
const MAX_NODES = 512;
const MAX_DEPTH = 32;
const MAX_ATTRIBUTES = 1_024;
const MAX_ATTRIBUTE_VALUE_LENGTH = 8_192;
const MAX_HREF_LENGTH = 2_048;
const MAX_CLASS_LENGTH = 512;

const allowedAttributes = new Map<string, ReadonlySet<string>>([
  ["a", new Set(["class", "href", "rel", "target"])],
  ["circle", new Set(["class", "cx", "cy", "fill", "r"])],
  ["div", new Set(["class"])],
  ["path", new Set(["class", "clip-rule", "d", "fill", "fill-rule"])],
  ["style", new Set(["type"])],
  ["svg", new Set(["class", "fill", "height", "viewbox", "width", "xmlns"])]
]);

const forbiddenCss = [
  /@import/iu,
  /url\s*\(/iu,
  /expression\s*\(/iu,
  /javascript\s*:/iu,
  /behavior\s*:/iu,
  /position\s*:\s*(?:fixed|sticky)\b/iu,
  /:host\b/iu,
  /::part\s*\(/iu,
  /::slotted\s*\(/iu
];

type HtmlNode = {
  attrs?: { name: string; value: string }[];
  childNodes?: HtmlNode[];
  nodeName?: string;
  tagName?: string;
  value?: string;
};

function isGoogleHttpsHref(value: string): boolean {
  if (value.length === 0 || value.length > MAX_HREF_LENGTH || /[\u0000-\u0020\u007f]/u.test(value)) {
    return false;
  }

  try {
    const url = new URL(value);
    const hostname = url.hostname.toLowerCase();
    return (
      url.protocol === "https:" &&
      !url.username &&
      !url.password &&
      !url.port &&
      (hostname === "google.com" || hostname.endsWith(".google.com"))
    );
  } catch {
    return false;
  }
}

function validClass(value: string): boolean {
  return value.length <= MAX_CLASS_LENGTH && /^[A-Za-z0-9_ -]*$/u.test(value);
}

function validSvgNumber(value: string): boolean {
  return value.length <= 32 && /^-?(?:\d+(?:\.\d+)?|\.\d+)(?:px)?$/u.test(value);
}

function validAttribute(tagName: string, name: string, value: string): boolean {
  if (value.length > MAX_ATTRIBUTE_VALUE_LENGTH) {
    return false;
  }
  if (name === "class") return validClass(value);
  if (tagName === "a" && name === "href") return isGoogleHttpsHref(value);
  if (tagName === "a" && name === "target") return value === "_blank";
  if (tagName === "a" && name === "rel") {
    const tokens = value.toLowerCase().split(/\s+/u).filter(Boolean);
    return tokens.length > 0 && tokens.every((token) => token === "noopener" || token === "noreferrer");
  }
  if (tagName === "style" && name === "type") return value === "text/css";
  if (tagName === "svg" && name === "xmlns") return value === "http://www.w3.org/2000/svg";
  if (tagName === "svg" && name === "viewbox") {
    const values = value.trim().split(/\s+/u);
    return values.length === 4 && values.every(validSvgNumber);
  }
  if (name === "width" || name === "height" || name === "cx" || name === "cy" || name === "r") {
    return validSvgNumber(value);
  }
  if (name === "fill") {
    return value === "none" || value === "currentColor" || /^#[0-9A-Fa-f]{3,8}$/u.test(value);
  }
  if (name === "fill-rule" || name === "clip-rule") {
    return value === "evenodd" || value === "nonzero";
  }
  if (tagName === "path" && name === "d") {
    return value.length <= MAX_ATTRIBUTE_VALUE_LENGTH && /^[MmZzLlHhVvCcSsQqTtAaEe0-9,.+\-\s]+$/u.test(value);
  }

  return false;
}

function validateCss(value: string): void {
  if (forbiddenCss.some((pattern) => pattern.test(value))) {
    throw new Error("gemini_interactions_grounding_html_invalid");
  }
}

export function validateGeminiSearchSuggestionsHtml(value: unknown): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    Buffer.byteLength(value, "utf8") > MAX_HTML_BYTES ||
    /[\u0000\u000b\u000c\u007f]/u.test(value)
  ) {
    throw new Error("gemini_interactions_grounding_html_invalid");
  }

  const parseErrors: unknown[] = [];
  const fragment = parseFragment(value, {
    onParseError(error) {
      parseErrors.push(error);
    }
  }) as HtmlNode;
  if (parseErrors.length > 0) {
    throw new Error("gemini_interactions_grounding_html_invalid");
  }

  let attributeCount = 0;
  let nodeCount = 0;
  let googleLinkCount = 0;

  function visit(node: HtmlNode, depth: number, parentTag?: string): void {
    nodeCount += 1;
    if (nodeCount > MAX_NODES || depth > MAX_DEPTH) {
      throw new Error("gemini_interactions_grounding_html_invalid");
    }

    const nodeName = node.nodeName ?? "";
    if (nodeName === "#comment" || nodeName === "#documentType") {
      throw new Error("gemini_interactions_grounding_html_invalid");
    }
    if (nodeName === "#text") {
      const text = node.value ?? "";
      if (parentTag === "style") {
        validateCss(text);
      } else if (/[\u0000\u000b\u000c\u007f]/u.test(text)) {
        throw new Error("gemini_interactions_grounding_html_invalid");
      }
      return;
    }
    if (nodeName !== "#document-fragment") {
      const tagName = (node.tagName ?? nodeName).toLowerCase();
      const tagAttributes = allowedAttributes.get(tagName);
      if (!tagAttributes) {
        throw new Error("gemini_interactions_grounding_html_invalid");
      }
      const attributes = node.attrs ?? [];
      attributeCount += attributes.length;
      if (attributeCount > MAX_ATTRIBUTES) {
        throw new Error("gemini_interactions_grounding_html_invalid");
      }
      const seen = new Set<string>();
      for (const attribute of attributes) {
        const name = attribute.name.toLowerCase();
        if (
          seen.has(name) ||
          !tagAttributes.has(name) ||
          !validAttribute(tagName, name, attribute.value)
        ) {
          throw new Error("gemini_interactions_grounding_html_invalid");
        }
        seen.add(name);
        if (tagName === "a" && name === "href") {
          googleLinkCount += 1;
        }
      }
      if (tagName === "a" && !seen.has("href")) {
        throw new Error("gemini_interactions_grounding_html_invalid");
      }
      if (tagName === "style" && (node.childNodes ?? []).some((child) => child.nodeName !== "#text")) {
        throw new Error("gemini_interactions_grounding_html_invalid");
      }
      parentTag = tagName;
    }

    for (const child of node.childNodes ?? []) {
      visit(child, depth + 1, parentTag);
    }
  }

  visit(fragment, 0);
  if (googleLinkCount === 0) {
    throw new Error("gemini_interactions_grounding_html_invalid");
  }

  return value;
}
