import {
  STRUCTURED_OUTPUT_DECODE_REASONS,
  StructuredOutputDecodeError
} from "../../providers/structuredOutput";

/** Closed, content-free reasons why a received structured answer was
 * rejected. The shared transport decoder supplies the first group; Memory role
 * decoders report the rest through MemoryOutputViolationError. A new role
 * violation is added here. PostgreSQL enforces only the code format, so
 * previous-release writers and older rows stay valid. */
export const MEMORY_OUTPUT_DECODE_REASONS = Object.freeze([
  ...STRUCTURED_OUTPUT_DECODE_REASONS,
  // A role decoder rejected the answer without a typed violation.
  "role_contract",
  "digest_aggregate_limit",
  "digest_safety_rejected",
  "digest_contract",
  "digest_contract_response_json",
  "digest_contract_root_type",
  "digest_contract_root_keys",
  "digest_contract_summary_invalid",
  "digest_contract_summary_length",
  "digest_contract_topics_invalid",
  "digest_contract_topics_count",
  "digest_contract_topics_item_invalid",
  "digest_contract_topics_item_length",
  "digest_contract_decisions_invalid",
  "digest_contract_decisions_count",
  "digest_contract_decisions_item_invalid",
  "digest_contract_decisions_item_length",
  "digest_contract_open_loops_invalid",
  "digest_contract_open_loops_count",
  "digest_contract_open_loops_item_invalid",
  "digest_contract_open_loops_item_length",
  "contextual_key_output_invalid",
  "contextual_key_handle_mismatch",
  "contextual_key_empty_statements",
  "contextual_key_statement_count_invalid",
  "contextual_key_statement_too_long",
  "contextual_key_safety_rejected",
  "contextual_key_source_ref_invalid",
  "contextual_grounding_invalid",
  "contextual_grounding_safety_rejected",
  "statement_contract_keys",
  "statement_contract_field",
  "statement_contract_consistency"
] as const);

export type MemoryOutputDecodeReason = (typeof MEMORY_OUTPUT_DECODE_REASONS)[number];

/** Mirrors the database check on MemoryExecutionBinding.decodeReason. */
export const MEMORY_OUTPUT_DECODE_REASON_PATTERN = /^[a-z][a-z0-9_]{0,63}$/u;

const decodeReasons = new Set<string>(MEMORY_OUTPUT_DECODE_REASONS);

export function isMemoryOutputDecodeReason(value: unknown): value is MemoryOutputDecodeReason {
  return typeof value === "string" && decodeReasons.has(value) &&
    MEMORY_OUTPUT_DECODE_REASON_PATTERN.test(value);
}

/** A role decoder's typed rejection of a received answer. It carries only a
 * closed reason code; the rejected content never reaches the error. Role
 * errors extend it and keep their own message and fields. */
export class MemoryOutputViolationError extends Error {
  readonly decodeReason: MemoryOutputDecodeReason;

  constructor(message: string, decodeReason: MemoryOutputDecodeReason) {
    super(message);
    this.name = "MemoryOutputViolationError";
    this.decodeReason = isMemoryOutputDecodeReason(decodeReason) ? decodeReason : "role_contract";
  }
}

/** The persisted reason of a rejected answer: the transport decode reason, the
 * role decoder's typed violation, or the generic role contract. */
export function memoryOutputDecodeReason(error: unknown): MemoryOutputDecodeReason {
  if (error instanceof StructuredOutputDecodeError) return error.reason;
  if (error instanceof MemoryOutputViolationError) return error.decodeReason;
  return "role_contract";
}
