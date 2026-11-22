/**
 * Compatibility names for the old Memory code until it is deleted. Saved
 * secret matching lives in `lib/server/redaction/savedSecrets.ts`; new code
 * imports it from there under its neutral names.
 */
export {
  SAVED_SECRET_MARKER as MEMORY_SAVED_SECRET_MARKER,
  SAVED_SECRET_REDACTION_REASON as MEMORY_SAVED_SECRET_REDACTION_REASON,
  redactSavedSecretValues as redactMemorySavedSecretValues,
  savedSecretScreenedValues as memorySavedSecretScreenedValues,
  savedSecretValueIsScreened as memorySavedSecretValueIsScreened,
  valueContainsSavedSecret as memoryValueContainsSavedSecret
} from "../../redaction/savedSecrets";
