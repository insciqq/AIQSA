export const GEMINI_SEARCH_SUGGESTIONS_LIMITS = {
  maxAttributeValueLength: 8_192,
  maxAttributes: 1_024,
  maxClassLength: 512,
  maxDepth: 32,
  maxHrefLength: 2_048,
  maxHtmlBytes: 256 * 1_024,
  maxNodes: 512
} as const;

const projectedAttributes: Readonly<Record<string, readonly string[]>> = {
  a: ["class", "href", "rel", "target"],
  circle: ["class", "cx", "cy", "fill", "r"],
  div: ["class"],
  path: ["class", "clip-rule", "d", "fill", "fill-rule"],
  svg: ["class", "fill", "height", "viewbox", "width", "xmlns"]
};

export function geminiSearchSuggestionAttributes(
  tagName: string
): readonly string[] | undefined {
  return projectedAttributes[tagName];
}

export function hasUnsafeGeminiSuggestionControls(value: string): boolean {
  return /[\u0000\u000b\u000c\u007f]/u.test(value);
}

export function isGoogleSearchSuggestionHref(value: string): boolean {
  if (
    value.length === 0 ||
    value.length > GEMINI_SEARCH_SUGGESTIONS_LIMITS.maxHrefLength ||
    /[\u0000-\u0020\u007f]/u.test(value)
  ) {
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
  return (
    value.length <= GEMINI_SEARCH_SUGGESTIONS_LIMITS.maxClassLength &&
    /^[A-Za-z0-9_ -]*$/u.test(value)
  );
}

function validSvgNumber(value: string): boolean {
  return value.length <= 32 && /^-?(?:\d+(?:\.\d+)?|\.\d+)(?:px)?$/u.test(value);
}

export function isValidGeminiSearchSuggestionAttribute(
  tagName: string,
  name: string,
  value: string
): boolean {
  if (value.length > GEMINI_SEARCH_SUGGESTIONS_LIMITS.maxAttributeValueLength) {
    return false;
  }
  if (name === "class") return validClass(value);
  if (tagName === "a" && name === "href") return isGoogleSearchSuggestionHref(value);
  if (tagName === "a" && name === "target") return value === "_blank";
  if (tagName === "a" && name === "rel") {
    const tokens = value.toLowerCase().split(/\s+/u).filter(Boolean);
    return (
      tokens.length > 0 &&
      tokens.every((token) => token === "noopener" || token === "noreferrer")
    );
  }
  if (tagName === "svg" && name === "xmlns") {
    return value === "http://www.w3.org/2000/svg";
  }
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
    return (
      value.length <= GEMINI_SEARCH_SUGGESTIONS_LIMITS.maxAttributeValueLength &&
      /^[MmZzLlHhVvCcSsQqTtAaEe0-9,.+\-\s]+$/u.test(value)
    );
  }

  return false;
}
