export type {
  MemorySecretConfidence,
  MemorySecretDetectorClass,
  MemorySecretFinding,
  MemorySecretParseResult,
  MemorySecretPolicyAction,
  MemorySecretRedactionResult,
  MemorySecretSourceMapEntry,
  MemorySecretSourceRange,
  MemorySecretSpan,
  MemorySecretWindowedRedactionResult,
  MemorySecretWindowOptions
} from "./secretParser";
export {
  MEMORY_SECRET_FINDINGS,
  MEMORY_SECRET_REDACTION_PLACEHOLDER,
  MEMORY_UNPROCESSED_TEXT_PLACEHOLDER,
  memoryRedactionHasSourceText,
  memoryProjectionHasSourceText,
  memoryProjectionContainsRedaction,
  memorySecretJoinIsSafe,
  memorySecretSafeObjectKey,
  memoryValueContainsRecognizedSecret,
  parseMemorySecret,
  redactMemorySecrets,
  redactMemorySecretsInWindows
} from "./secretParser";
/** Compatibility name for the old Memory code until it is deleted. */
export { containsSecret as memoryExplicitStatementContainsSecret } from "../../redaction/secrets";
