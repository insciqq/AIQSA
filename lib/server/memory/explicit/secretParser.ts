/**
 * Compatibility names for the old Memory code until it is deleted. Secret
 * screening lives in `lib/server/redaction/secrets.ts`; new code imports it
 * from there under its neutral names.
 */
export type {
  SecretConfidence as MemorySecretConfidence,
  SecretDetectorClass as MemorySecretDetectorClass,
  SecretFinding as MemorySecretFinding,
  SecretParseResult as MemorySecretParseResult,
  SecretPolicyAction as MemorySecretPolicyAction,
  SecretRedactionResult as MemorySecretRedactionResult,
  SecretSourceMapEntry as MemorySecretSourceMapEntry,
  SecretSourceRange as MemorySecretSourceRange,
  SecretSpan as MemorySecretSpan,
  SecretWindowedRedactionResult as MemorySecretWindowedRedactionResult,
  SecretWindowOptions as MemorySecretWindowOptions
} from "../../redaction/secrets";
export {
  SECRET_FINDINGS as MEMORY_SECRET_FINDINGS,
  SECRET_REDACTION_PLACEHOLDER as MEMORY_SECRET_REDACTION_PLACEHOLDER,
  UNPROCESSED_TEXT_PLACEHOLDER as MEMORY_UNPROCESSED_TEXT_PLACEHOLDER,
  parseSecrets as parseMemorySecret,
  redactSecrets as redactMemorySecrets,
  redactSecretsInWindows as redactMemorySecretsInWindows,
  redactedTextHasSourceText as memoryProjectionHasSourceText,
  redactionHasSourceText as memoryRedactionHasSourceText,
  secretJoinIsSafe as memorySecretJoinIsSafe,
  secretSafeObjectKey as memorySecretSafeObjectKey,
  textContainsRedactionMarker as memoryProjectionContainsRedaction,
  valueContainsRecognizedSecret as memoryValueContainsRecognizedSecret
} from "../../redaction/secrets";
