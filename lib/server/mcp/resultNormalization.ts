import type { AiqsaMcpToolCallResult } from "./clientSession";
import { getMcpResponseWireLimits } from "./responseLimits";

// This is a proof budget, not another transport rejection: uncertain or costly
// results retain both representations. No input tree or text block is copied.
const MAX_PROOF_NODES = 65_536;
const MAX_PROOF_DEPTH = 64;

function canonicalJson(value: unknown, maxBytes: number): string | null {
  let remaining = maxBytes, nodes = MAX_PROOF_NODES;
  const ancestors = new Set<object>();
  const charge = (size: number) => (remaining -= size) >= 0;
  const quoted = (text: string) => {
    if (!charge(Buffer.byteLength(text) + 2)) return false;
    for (let index = 0; index < text.length; index++) {
      const code = text.charCodeAt(index);
      if (code === 34 || code === 92 || (code < 32 && (code === 8 || code === 9 || code === 10 || code === 12 || code === 13))) {
        if (!charge(1)) return false;
      } else if (code < 32) {
        if (!charge(5)) return false;
      } else if (code >= 0xd800 && code <= 0xdfff) {
        const next = text.charCodeAt(index + 1);
        if (code <= 0xdbff && next >= 0xdc00 && next <= 0xdfff) index++;
        // Buffer counts an isolated surrogate as three bytes; JSON uses six.
        else if (!charge(3)) return false;
      }
    }
    return true;
  };
  const visit = (item: unknown, depth: number): boolean => {
    if (--nodes < 0 || depth > MAX_PROOF_DEPTH) return false;
    if (item === null) return charge(4);
    if (typeof item === "string") return quoted(item);
    if (typeof item === "boolean") return charge(item ? 4 : 5);
    // Parsing may have rounded a number. Deliberately decline even equivalent
    // floats; canonical safe integer lexemes are the only numeric proof here.
    if (typeof item === "number") return Number.isSafeInteger(item) && !Object.is(item, -0) && charge(String(item).length);
    if (typeof item !== "object" || ancestors.has(item)) return false;
    const array = Array.isArray(item), prototype = Object.getPrototypeOf(item);
    if ((array ? prototype !== Array.prototype : prototype !== Object.prototype && prototype !== null) || "toJSON" in item) return false;
    // Check before Object.keys would allocate one new string per array index.
    if (array && item.length > nodes) return false;
    const keys = Object.keys(item);
    if (keys.length > nodes || Object.getOwnPropertySymbols(item).length || !charge(2 + Math.max(0, keys.length - 1))) return false;
    if (array && keys.length !== item.length) return false;
    ancestors.add(item);
    for (const [index, key] of keys.entries()) {
      if (array && key !== String(index)) return false;
      const descriptor = Object.getOwnPropertyDescriptor(item, key)!;
      if (!("value" in descriptor) || (!array && (!quoted(key) || !charge(1))) || !visit(descriptor.value, depth + 1)) return false;
    }
    ancestors.delete(item);
    return true;
  };
  // At most one bounded canonical string for the entire result, never a parsed
  // copy or whitespace-stripped copy of each candidate text block.
  return visit(value, 0) ? JSON.stringify(value) : null;
}

function jsonWhitespace(code: number): boolean {
  return code === 32 || code === 9 || code === 10 || code === 13;
}

function tokenBoundary(character: string | undefined): boolean {
  return character === undefined || '{}[],:"'.includes(character);
}

function equalsCanonicalJson(text: string, canonical: string): boolean {
  let cursor = 0, inString = false, escaped = false;
  for (let index = 0; index < text.length; index++) {
    const character = text[index]!;
    if (!inString && jsonWhitespace(text.charCodeAt(index))) {
      // Whitespace between letters/digits is invalid JSON, not insignificant
      // whitespace (e.g. t rue, 1 2). All other characters must match exactly.
      if (!tokenBoundary(canonical[cursor - 1]) && !tokenBoundary(canonical[cursor])) return false;
      continue;
    }
    if (character !== canonical[cursor++]) return false;
    if (inString) {
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === '"') inString = false;
    } else if (character === '"') inString = true;
  }
  return cursor === canonical.length;
}

/** Provider-only projection, AFTER validation and any raw-result consumer.
 * Exact canonical spelling (apart from JSON whitespace) proves a whole-block
 * duplicate without parsing away duplicate keys, numeric lexemes or types.
 * Different object key order/escape spelling and budget exhaustion are safe
 * false negatives. Never mutate the validated source or historical receipts.
 */
export function normalizeMcpResultForModel(result: AiqsaMcpToolCallResult): AiqsaMcpToolCallResult {
  if (!result.structuredContent || !result.text.length || result.text.length > MAX_PROOF_NODES) return result;
  let remaining = getMcpResponseWireLimits().callToolResponseMaxBytes;
  for (const text of result.text) {
    remaining -= Buffer.byteLength(text);
    if (remaining <= 0) return result;
  }
  const canonical = canonicalJson(result.structuredContent, remaining);
  if (canonical === null) return result;
  const text = result.text.filter(item => !equalsCanonicalJson(item, canonical));
  return text.length === result.text.length ? result : { ...result, text };
}
