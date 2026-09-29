export type GeminiInteractionsStreamErrorCode =
  | "gemini_interactions_stream_body_missing"
  | "gemini_interactions_stream_completed_id_invalid"
  | "gemini_interactions_stream_created_duplicate"
  | "gemini_interactions_stream_created_id_invalid"
  | "gemini_interactions_stream_created_id_missing"
  | "gemini_interactions_stream_created_id_too_long"
  | "gemini_interactions_stream_created_missing"
  | "gemini_interactions_stream_created_model_invalid"
  | "gemini_interactions_stream_created_status_invalid"
  | "gemini_interactions_stream_delta_invalid"
  | "gemini_interactions_stream_error"
  | "gemini_interactions_stream_event_invalid"
  | "gemini_interactions_stream_event_unsupported"
  | "gemini_interactions_stream_interaction_invalid"
  | "gemini_interactions_stream_invalid_json"
  | "gemini_interactions_stream_status_invalid"
  | "gemini_interactions_stream_step_invalid"
  | "gemini_interactions_stream_step_unfinished"
  | "gemini_interactions_stream_step_unsupported"
  | "gemini_interactions_stream_text_mismatch"
  | "gemini_interactions_stream_trailing_data"
  | "gemini_interactions_stream_truncated";

/** Local protocol validation identity only; never attach the provider frame. */
export class GeminiInteractionsStreamError extends Error {
  constructor(readonly code: GeminiInteractionsStreamErrorCode) {
    super(code);
    this.name = "GeminiInteractionsStreamError";
  }
}
