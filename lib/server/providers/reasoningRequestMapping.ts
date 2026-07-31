import {
  OPENAI_RESPONSES_REASONING_REQUEST_MAPPING,
  type ProviderReasoningRequestMapping
} from "../../contracts/providerReasoningRequestMapping";

function setPath(
  target: Record<string, unknown>,
  path: string,
  value: string
): void {
  const segments = path.split(".");
  let cursor = target;
  for (const segment of segments.slice(0, -1)) {
    const current = cursor[segment];
    if (typeof current === "object" && current !== null && !Array.isArray(current)) {
      cursor = current as Record<string, unknown>;
      continue;
    }
    const nested: Record<string, unknown> = {};
    cursor[segment] = nested;
    cursor = nested;
  }
  cursor[segments.at(-1)!] = value;
}

export function applyProviderReasoningRequestMapping(
  body: Record<string, unknown>,
  mapping: ProviderReasoningRequestMapping,
  values: Readonly<{ effort?: string; mode?: string }>
): void {
  if (values.effort?.trim()) {
    setPath(body, mapping.effortPath, values.effort.trim());
  }
  if (mapping.modePath && values.mode?.trim()) {
    setPath(body, mapping.modePath, values.mode.trim());
  }
}

export function isCanonicalResponsesReasoningRequestMapping(
  mapping: ProviderReasoningRequestMapping
): boolean {
  return mapping.effortPath === OPENAI_RESPONSES_REASONING_REQUEST_MAPPING.effortPath &&
    mapping.modePath === OPENAI_RESPONSES_REASONING_REQUEST_MAPPING.modePath;
}
