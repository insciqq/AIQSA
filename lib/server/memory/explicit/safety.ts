import { parseMemorySecret } from "./secretParser";

export type {
  MemorySecretConfidence,
  MemorySecretDetectorClass,
  MemorySecretFinding,
  MemorySecretParseResult,
  MemorySecretPolicyAction,
  MemorySecretRedactionResult,
  MemorySecretSourceMapEntry,
  MemorySecretSpan
} from "./secretParser";
export {
  MEMORY_SECRET_FINDINGS,
  MEMORY_SECRET_REDACTION_PLACEHOLDER,
  memoryRedactionHasMeaningfulRemainder,
  memoryProjectionHasMeaningfulText,
  memorySecretSafeObjectKey,
  memoryValueContainsRecognizedSecret,
  parseMemorySecret,
  redactMemorySecrets
} from "./secretParser";

/**
 * Compatibility predicate for existing Memory admission callers. The parser
 * is format-aware and deliberately does not use semantic keyword routing;
 * callers receive only the conservative boolean needed before derivatives or
 * provider egress are created.
 */
export function memoryExplicitStatementContainsSecret(statement: string): boolean {
  return parseMemorySecret(statement).containsSecret;
}
