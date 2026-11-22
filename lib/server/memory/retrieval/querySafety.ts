/**
 * Compatibility names for the old Memory code until it is deleted. Search
 * query redaction lives in `lib/server/redaction/searchQuery.ts`; new code
 * imports it from there under its neutral names.
 */
export type { RedactedSearchQuery as MemorySanitizedUtilityText } from "../../redaction/searchQuery";
export {
  SEARCH_QUERY_MAX_CODE_UNITS as MEMORY_UTILITY_TEXT_MAX_CODE_UNITS,
  SEARCH_QUERY_REDACTION_VERSION as MEMORY_READ_QUERY_SAFETY_VERSION,
  redactSearchQuery as sanitizeMemoryUtilityText
} from "../../redaction/searchQuery";
