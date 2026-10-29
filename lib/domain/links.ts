const SAFE_EXTERNAL_PROTOCOLS = new Set(["http:", "https:", "mailto:"]);
/** Studio sections the AIQSA guide gives the agent as links (`lib/server/engine/prompts/selfService.ts`). */
const STUDIO_SECTIONS = new Set(["artifacts", "assistants", "defaults", "files", "instructions", "mcp", "memory", "scheduled", "secrets", "skills",
  "subagents"]);

/** A Studio section address in this app (`/?library=<section>`, or one Assistant), else null. */
export function studioHref(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const href = value.trim();
  const match = /^\/\?library=([a-z]+)(?:&assistant=[A-Za-z0-9_-]{1,64})?$/u.exec(href);
  return match && STUDIO_SECTIONS.has(match[1]!) ? href : null;
}

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
