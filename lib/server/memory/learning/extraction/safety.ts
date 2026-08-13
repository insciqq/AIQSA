import { memoryExplicitStatementContainsSecret } from "../../explicit/safety";

/**
 * This boundary performs recognizable-format DLP only. Natural-language
 * sensitivity, quotation, hypothetical status, and source meaning belong to
 * the structured extractor decision.
 */
export type MemoryFactSourceSafety = Readonly<{
  eligible: boolean;
  reasonCode: string | null;
}>;

export function inspectMemoryFactSourceSafety(
  text: string
): MemoryFactSourceSafety {
  return memoryExplicitStatementContainsSecret(text)
    ? { eligible: false, reasonCode: "recognizable_secret_format" }
    : { eligible: true, reasonCode: null };
}

export function memoryFactCandidateSensitivityAllowed(
  sourceText: string,
  _category: string,
  _displayText: string
): boolean {
  return !memoryExplicitStatementContainsSecret(sourceText);
}
