const SAFE_EXTERNAL_PROTOCOLS = new Set(["http:", "https:", "mailto:"]);

export function safeExternalHref(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }

  const href = value.trim().replace(/[\u0000-\u001F\u007F]/g, "");

  if (!href || href.startsWith("//") || /\s/.test(href)) {
    return null;
  }

  const schemeEnd = href.indexOf(":");
  if (schemeEnd <= 0) {
    return null;
  }

  const protocol = `${href.slice(0, schemeEnd).toLowerCase()}:`;
  if (!SAFE_EXTERNAL_PROTOCOLS.has(protocol)) {
    return null;
  }

  if (protocol === "mailto:") {
    return href.length > "mailto:".length ? href : null;
  }

  try {
    const url = new URL(href);

    return SAFE_EXTERNAL_PROTOCOLS.has(url.protocol) ? href : null;
  } catch {
    return null;
  }
}
