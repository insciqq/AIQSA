export type ObservabilityContext = Readonly<{
  trace_id: string; run_id?: string; job_id?: string; tool_call_id?: string; execution_index?: number;
  /** The internal id of the user a run or job row names; never a counter dimension. */
  user_id?: string;
}>;
export type ProcessRole = "app" | "memory_coordinator" | "workspace_runner" | "maintenance" | "bootstrap" | "storage_relay";
export type Subsystem = "attachments" | "pdf" | "memory" | "mcp" | "workspace" | "run_recovery" | "chat_title" | "memory_search" | "database" | "object_storage" | "email" | "admin" | "configuration" | "scheduled_tasks" | "push" | "usage_alerts" | "telemetry" | "dictation" | "connect" | "telegram";
export type SubsystemState = "disabled" | "starting" | "unknown" | "ready" | "failed";
export type LifecycleStage = "startup" | "discover" | "reconcile" | "claim" | "drain" | "preflight" | "prepare" | "process" | "parse" | "chunk" | "embed" | "validate" | "publish" | "progress" | "retry" | "complete" | "fail" | "release" | "settle" | "refresh" | "probe" | "evict" | "initialize" | "quiesce" | "resume" | "collect" | "seal" | "export" | "restore" | "recovery" | "continuation" | "cleanup" | "projection" | "integrity" | "rebuild" | "dispatch" | "shutdown" | "read" | "write" | "delete" | "multipart_start" | "multipart_complete" | "multipart_abort" | "multipart_sign" | "health" | "heartbeat";
export type LifecycleOutcome = "started" | "completed" | "failed" | "degraded" | "cancelled" | "stale" | "waiting" | "skipped" | "lost_lease" | "blocked";
export type LifecycleAction = "none" | "retry" | "stop" | "complete" | "fail" | "degrade" | "release" | "skip" | "wait";
/** The closed kind of a database failure (see databaseCause.cjs). */
export type DatabaseFailureKind = "transaction_expired" | "transaction_start_timeout" | "lock_timeout" | "statement_timeout" | "serialization_conflict" | "deadlock";
/** A caught value for events that record its content-free projection
 * (error class, application code site, fingerprint) and the closed facts of
 * its cause chain (failureFacts.cjs); never serialized itself. */
export type CaughtError = Readonly<{ error?: unknown }>;
export type LifecycleFields = CaughtError & Readonly<{
  subsystem: Subsystem; stage: LifecycleStage; outcome: LifecycleOutcome;
  work_stage?: LifecycleStage; job_kind?: DbTransactionJobKind;
  job_id?: string; run_id?: string; generation_id?: string; attempt?: number; duration_ms?: number;
  /** Time a timed transaction spent in its lock statements (transactionTiming.ts). */
  lock_wait_ms?: number;
  code?: string; prisma_code?: string; db_failure?: DatabaseFailureKind; httpStatus?: number; action?: LifecycleAction;
  delay_ms?: number; retry_at?: string; count?: number; repeat_count?: number;
  claimed_count?: number; failed_count?: number; completed_count?: number; pending_count?: number;
}>;
export type SubsystemFailure = CaughtError & Readonly<{
  subsystem: Subsystem; stage: LifecycleStage; code?: string; prisma_code?: string; httpStatus?: number; action?: LifecycleAction;
  /** Server-owned identity used only to distinguish internal health states. */
  scope_id?: string;
}>;
export type SignInTelemetryMethod = "password" | "token" | "oauth" | "oidc" | "saml" | "ldap" | "trusted_header";
/** `start` records only a start that ends the attempt; the later step records the rest. */
export type SignInStep = "start" | "credentials" | "second_factor" | "callback";
export type SignInOutcome = "succeeded" | "failed" | "refused";
export type ToolKind = "search" | "mcp" | "workspace" | "vision";
/** The family of one model tool call (`tool_call` only); the families with
 * their own executor records keep the narrower `ToolKind`. */
export type ToolCallKind = ToolKind | "fetch_url" | "artifact" | "image_generation" | "skill" | "scheduled_task" |
  "session_status" | "workspace_image" | "memory" | "monitoring" | "computer" | "other";
/** Where saving a tool result failed (`tool_observation_store_failed`, `lib/server/toolObservations/storeFailure.ts`): the
 * store's step, the failure's closed class from the error's type or code (never its text), and the kind of agent whose call
 * produced the result. */
export type ToolObservationStoreStep = "outcome_record" | "measure" | "preview" | "projection_limit" | "admission" | "begin_write" |
  "source_authority" | "object_put" | "read_back" | "finish_write" | "unretained_close" | "search_receipt" | "callback";
export type ToolObservationFailureClass = "database" | "storage" | "limit" | "abort" | "authority" | "conflict" | "invalid" | "unknown";
export type ToolObservationAgentKind = "main" | "foreground_subagent" | "background_subagent";
export type NestedAbortSource = "parent_signal" | "tool_deadline" | "search_deadline" | "provider_deadline" | "mcp_deadline" | "workspace_deadline" | "unknown";
type ToolOperationFields = Readonly<{
  engine_index?: number; operation_index?: number;
  operation_stage?: "retrieval" | "embedding" | "rerank" | "relevance" | "draft" | "selector" | "auditor" | "supplement" | "compose" | "verify";
}>;
type RouteFields = Readonly<{
  method?: "GET" | "HEAD" | "POST" | "PUT" | "PATCH" | "DELETE" | "OPTIONS" | "CONNECT" | "TRACE" | "unknown";
  routePath?: string;
  route_source?: "manifest" | "next_error" | "unknown";
}>;
export type EmergencyFailure = CaughtError & Readonly<{
  stage: "startup" | "uncaught_exception" | "unhandled_rejection";
  outcome: "terminated" | "framework_managed";
  code?: "unexpected" | "runtime_peer_bridge_multiple_servers" | "runtime_peer_bridge_listener_missing" | "runtime_peer_bridge_not_installed";
}>;
type OperationOutcome = "started" | "completed" | "failed" | "cancelled";
/** Only preparation reports a run that continued without optional Memory. */
type PreparationOutcome = OperationOutcome | "degraded";
type Reason = "unknown" | "cancelled" | "deadline" | "network" | "http" | "safety_limit" | "policy" | "invalid_response";
type ProviderIdentity = Readonly<{ providerFamily?: string; adapterKind?: string; connectionId?: string; providerModelId?: string }>;
type ProviderFields = ProviderIdentity & CaughtError & Readonly<{
  stage?: "answer" | "compaction" | "search" | "structured_output" | "cancel" | "refresh" | "retrieve" | "embedding" | "rerank" |
    "decisions" | "image";
  outcome?: OperationOutcome; duration_ms?: number; attempt?: number; action?: "none" | "retry" | "stop";
  httpStatus?: number; code?: string; reason?: Reason; timeout_ms?: number; delay_ms?: number;
  abort_source?: "provider_deadline" | "parent_signal" | "unknown";
  cause?: "max_output_tokens" | "content_filter";
  provider_status?: "completed" | "failed" | "cancelled" | "incomplete" | "queued" | "in_progress" | "retrying" | "unknown";
  /** Why an answer stream ended before its completion event. */
  stream_drop?: "truncated" | "error_event" | "response_failed" | "reset";
  /** The provider's own error identity from providerErrorCodes.json; any other is `other`. */
  provider_error_code?: string;
  /** A timed-out stream's progress: milliseconds since its last byte and last parsed event, and whether an event arrived. */
  last_byte_ms?: number; last_event_ms?: number; response_started?: boolean;
}>;
/** Subsystems whose hot-path interactive transactions are timed (`db_transaction`). */
export type DbTransactionSubsystem = "memory" | "workspace" | "runs";
/** The closed set of timed transactions: Memory job and deletion commits, Workspace export steps, run terminal writes. */
export type DbTransactionOperation = "job_commit" | "deletion_commit" |
  "export_claim" | "export_recovery_claim" | "export_reserve" | "export_seal" | "export_pending" | "export_complete" |
  "export_failed" | "export_renew" | "export_prepare_output" | "export_settle_output" |
  "run_complete" | "run_fail" | "run_cancel" | "usage_settlement";
/** The Memory job kinds (Prisma `MemoryJobKind`). */
export type DbTransactionJobKind = "MEMORY_COMMAND" | "INDEX_HISTORY" | "EXTRACT_FACTS" | "CONSOLIDATE_CANDIDATE" |
  "VERIFY_CANDIDATE" | "EMBED_ITEMS" | "RECONCILE_BRANCH" | "RECONCILE_SOURCE" | "REBUILD_INDEX" | "RECLASSIFY_FACTS" |
  "RESOLVE_FACT_RELATIONS" | "SYNTHESIZE_MEMORIES";
export type PushTransportFailureCategory = "dns" | "connect" | "tls" | "timeout" | "reset" | "network_unreachable" | "unknown";
/** The browser push service a subscription's endpoint belongs to, by its host alone. */
export type PushServiceClass = "fcm" | "mozilla" | "apple" | "other";
/** The upload route that refused a request (`lib/server/uploads/uploadRefusal.ts`). */
export type UploadRefusalOperation = "upload" | "session_config" | "session_create" | "session_status" | "session_cancel" | "session_part" | "session_complete";
/** The step that refused it, where the route can tell: origin, sign-in, capacity, an unreadable body, the declared file, Workspace availability, the bytes, the PDF. */
export type UploadRefusalStage = "origin" | "auth" | "capacity" | "body" | "declaration" | "workspace" | "content" | "pdf";
/** A byte size by bucket, never the exact count; bounds are inclusive. */
export type UploadSizeClass = "empty" | "to_1mb" | "to_10mb" | "to_25mb" | "to_64mb" | "to_512mb" | "over_512mb";
/** The top-level part of the declared MIME type, never the type itself; `none` when none was declared. */
export type UploadMimeFamily = "application" | "audio" | "font" | "image" | "message" | "model" | "multipart" | "text" | "video" | "none" | "other";
/**
 * Why a Workspace tool call failed where its code alone cannot say, as the
 * runner observed it: the pinned MCP reported the guest operation failed
 * (`guest_*`, by its envelope code), the runner's channel to that MCP broke
 * (`transport_*`), or the sandbox or MCP was not available (`state_*`).
 */
export type WorkspaceFailureCause =
  | "guest_filesystem_failed" | "guest_process_failed"
  | "guest_operation_failed" | "guest_exec_failed" | "guest_path_denied" | "guest_operation_refused" | "guest_other" | "guest_unparsed"
  | "transport_timeout" | "transport_closed" | "transport_output_limit" | "transport_invalid_request" | "transport_other"
  | "state_sandbox_unavailable" | "state_mcp_unavailable";
export type EventFields = {
  image_execution: CaughtError & Readonly<{
    stage: "input" | "binding" | "run" | "references" | "reference_read" | "reference_validation" | "authorization" |
      "dispatch_claim" | "usage" | "provider" | "storage" | "publication";
    /** `refused`: a correctable refusal of the model's request; `cancelled`: a stop. Both warn; a failure is an error. */
    outcome?: "failed" | "refused" | "cancelled";
    code: string; duration_ms: number; finish_reason?: "safety" | "blocked" | "other";
    prisma_code?: string; db_failure?: DatabaseFailureKind;
    /** A refused provider image: the bound it broke, its size and header facts, never its content. */
    image_bound?: "bytes" | "pixels" | "dimension" | "response_bytes"; byte_size?: number; width?: number; height?: number;
    declared_mime?: "image/png" | "image/jpeg" | "image/webp" | "other" | "none"; detected_mime?: "image/png" | "image/jpeg" | "image/webp";
  }>;
  "http.request_completed": RouteFields & Readonly<{ status?: number; duration_ms?: number; headers_ms?: number; stream?: boolean; outcome: "completed" | "closed" }>;
  "http.request_failed": RouteFields & CaughtError & Readonly<{ stage: "listener" | "next_request"; error_category: "unexpected"; prisma_code?: string; db_failure?: DatabaseFailureKind }>;
  "http.route_resolver_unavailable": Readonly<{ reason: "missing" | "invalid" | "unsupported" }>;
  "client.error": Readonly<{ kind: "render" | "error" | "unhandled_rejection" | "chunk_load"; routePath?: string; route_source: "manifest" | "unknown" }>;
  /** One step of a sign-in attempt; `code` is a key of signInCodes.json. */
  sign_in: CaughtError & Readonly<{
    /** Absent while the step cannot tell the method yet (a second factor before its challenge). */
    sign_in_method?: SignInTelemetryMethod;
    step: SignInStep; outcome: SignInOutcome; code: string; duration_ms?: number;
  }>;
  "process.failure": EmergencyFailure;
  "process.started": Readonly<{
    node_version: string; attachments?: SubsystemState; memory?: SubsystemState;
    mcp?: SubsystemState; workspace?: SubsystemState; email?: SubsystemState;
  }>;
  "subsystem.recovered": Readonly<{ subsystem: Subsystem; stage: LifecycleStage; duration_ms?: number; repeat_count?: number }>;
  "readiness.changed": Readonly<{ state: "ready" | "not_ready"; code?: string; issue_count?: number }>;
  "logging.dropped_records": Readonly<{ count: number }>;
  /** `workspace_reason` is the request's closed reason for asking no Workspace (`WORKSPACE_NOT_REQUESTED_REASONS`). */
  run_accepted: Readonly<{ run_id: string; kind: "send" | "regenerate" | "project"; preparation: "ready" | "memory" | "pdf";
    workspace_requested?: boolean; workspace_reason?: "installation_disabled" | "model_no_tools" | "user_declined" | "unknown" }>;
  run_preparation: CaughtError & Readonly<{ run_id: string; stage: "preparing"; outcome: PreparationOutcome; duration_ms?: number; code?: string }>;
  run_execution: ProviderIdentity & CaughtError & Readonly<{ run_id: string; stage: "dispatch" | "execution" | "completion" | "first_output"; outcome: OperationOutcome; duration_ms?: number; after?: "dispatch" | "tools"; code?: string; provider_code?: string; reason?: Reason; abort_source?: "stop" | "workspace_deadline" | "provider_deadline" | "unknown"; timeout_ms?: number; prisma_code?: string; db_failure?: DatabaseFailureKind; httpStatus?: number; provider_error_code?: string }>;
  run_persistence: Readonly<{ run_id: string; stage: "complete" | "fail" | "cancel" | "preparation"; outcome: "confirmed" | "not_applied" | "unconfirmed"; prisma_code?: string; db_failure?: DatabaseFailureKind; duration_ms?: number; lock_wait_ms?: number }>;
  /** A timed transaction that held its rows past the slow bound: warn, error past the foreground budget. */
  db_transaction: Readonly<{
    subsystem: DbTransactionSubsystem; operation: DbTransactionOperation; job_kind?: DbTransactionJobKind;
    duration_ms: number; lock_wait_ms: number; outcome: "committed" | "rolled_back"; db_failure?: DatabaseFailureKind;
  }>;
  run_stop_requested: Record<string, never>;
  run_stop_admission: Readonly<{ run_id?: string; outcome: "accepted" | "not_found" | "not_cancelable" | "unauthorized" | "failed"; prisma_code?: string }>;
  run_http_failed: CaughtError & Readonly<{ stage: "send" | "regenerate" | "cancel"; httpStatus?: number; cause?: string; code?: string; reason?: Reason; prisma_code?: string }>;
  run_abort_delivery: Readonly<{ run_id: string; outcome: "delivered" | "already_aborted" | "not_running"; abort_source: "stop" }>;
  /** A user's report on an answer: its reason and whether it was new, never the comment. */
  answer_problem_report: Readonly<{
    reason: "wrong_or_made_up" | "did_not_follow_request" | "error_or_broken" | "too_slow" | "other"; outcome: "created" | "updated";
  }>;
  job_enqueued: Readonly<{ job_id: string; subsystem: "attachments" | "memory" | "pdf" | "chat_title" }>;
  job_attempt: LifecycleFields & Readonly<{ category?: PushTransportFailureCategory; push_service?: PushServiceClass }>;
  job_persistence: Omit<LifecycleFields, "outcome"> & Readonly<{ outcome: "confirmed" | "not_applied" | "unconfirmed" }>;
  run_recovery: LifecycleFields;
  runtime_lifecycle: LifecycleFields;
  service_operation: LifecycleFields;
  tool_execution: ToolOperationFields & ProviderIdentity & CaughtError & Readonly<{
    mcp_server?: string; tool_identity?: string;
    tool_kind: ToolKind; stage: "admission" | "execution" | "request" | "result" | "grounding";
    outcome: "started" | "completed" | "failed" | "cancelled" | "degraded";
    duration_ms?: number; attempt?: number; code?: string; reason?: Reason | WorkspaceFailureCause; httpStatus?: number;
    /** The official Workspace tool a Workspace record ran (`sandbox_shell`, `sandbox_fs_read`, ...). */
    operation?: string;
    /** Vision phase timings: before the dispatch claim, the provider wait after it, and its deadline. */
    preparation_duration_ms?: number; provider_duration_ms?: number; timeout_ms?: number;
    action?: LifecycleAction; count?: number;
    /** The byte bound an MCP response exceeded, so its call failed unread. */
    max_bytes?: number;
    /** An MCP result over its byte limit, delivered cut to it: JSON snapshot sizes only. */
    truncated?: boolean; original_bytes?: number; delivered_bytes?: number;
    /** A result that could not be saved: the failing step, its class and the producing agent's kind. */
    step?: ToolObservationStoreStep; failure_class?: ToolObservationFailureClass; agent_kind?: ToolObservationAgentKind;
  }>;
  /** Page-reader proxy attempts: never a user-authored name, endpoint, credentials or page content. */
  fetch_proxy: Readonly<{ outcome: "started" | "read" | "failed"; code?: string }>;
  /** One terminal record per settled model tool call; never its name, arguments or result. */
  tool_call: CaughtError & Readonly<{
    /** `awaiting_approval`: an MCP call paused for its initiator's approval. */
    tool_kind: ToolCallKind; outcome: "completed" | "failed" | "timeout" | "cancelled" | "awaiting_approval";
    code?: string; duration_ms?: number; error_category?: "unexpected";
    httpStatus?: number; http_status_class?: string; fetch_reason?: string; tool_identity?: string;
    mcp_server?: string; reason?: Reason | WorkspaceFailureCause; operation?: string; cause?: string;
    truncated?: boolean; original_bytes?: number; delivered_bytes?: number;
  }>;
  /** Local tool search statistics; never the query or tool names. */
  mcp_discovery: Readonly<{
    outcome: "completed" | "failed" | "cancelled"; duration_ms: number; mode?: "select" | "keywords";
    candidate_count?: number; result_count?: number; loaded_count: number; already_loaded_count: number;
    unknown_name_count?: number; unavailable_server_count?: number;
  }>;
  /** One selected server an Auto `find_tools` call reported unavailable: its reason and runtime or plan code only. */
  mcp_discovery_server_unavailable: Readonly<{ code: string; cause?: string }>;
  tool_deadline: ToolOperationFields & Readonly<{
    tool_kind: ToolKind; outer_timeout_ms?: number; configured_timeout_ms?: number;
    provider_timeout_ms?: number; effective_timeout_ms?: number; request_timeout_ms?: number;
  }>;
  provider_deadline: ProviderIdentity & Readonly<{
    stage?: "answer" | "search" | "structured_output" | "cancel" | "refresh" | "retrieve" | "embedding" | "rerank" | "decisions" | "image";
    configured_timeout_ms?: number; provider_timeout_ms?: number; effective_timeout_ms?: number; poll_timeout_ms?: number;
    stream_idle_timeout_ms?: number; stream_absolute_timeout_ms?: number;
  }>;
  nested_abort: ProviderIdentity & ToolOperationFields & Readonly<{
    layer: "tool" | ToolKind | "provider"; stage: "before_start" | "delivery";
    abort_source: NestedAbortSource; duration_ms?: number; timeout_ms?: number;
    deadline_kind?: "operation" | "request" | "sdk_request" | "stream_idle" | "stream_absolute" | "polling";
    last_byte_ms?: number; last_event_ms?: number; response_started?: boolean;
    operation?: "answer" | "search" | "structured_output" | "cancel" | "refresh" | "retrieve" | "embedding" | "rerank" | "decisions" | "image";
    attempt?: number;
  }>;
  transport_stage: ProviderIdentity & Readonly<{
    transport: "provider" | "mcp"; stage: "fetch" | "headers" | "body" | "stream" | "parse";
    operation?: "answer" | "search" | "structured_output" | "cancel" | "refresh" | "retrieve" | "embedding" | "rerank" | "decisions" | "image";
    outcome: OperationOutcome; duration_ms?: number; httpStatus?: number; code?: string;
    category?: "dns" | "tls" | "connect" | "timeout" | "parse" | "http" | "aborted" | "unknown";
    bytes?: number; chunks?: number; last_progress_ms?: number; timeout_ms?: number; attempt?: number;
    last_event_ms?: number; response_started?: boolean;
    first_event_ms?: number; max_byte_gap_ms?: number; max_event_gap_ms?: number;
  }>;
  provider_operation: ProviderFields;
  /** Provider-reported input tokens of one dispatched round against the
   * context budget's estimate of the same request (numbers only). */
  context_estimate: Pick<ProviderIdentity, "providerFamily"> & Readonly<{
    estimate_family: "anthropic" | "deepseek" | "gemini" | "openai" | "unknown";
    estimated_tokens: number; reported_input_tokens: number; ratio_permille: number;
  }>;
  /** One compaction of a native run (`lib/server/engine/runContext.ts`): its path, mode, trigger, sizes and outcome; never content.
   * `clearing`: old page results cleared with no model call (`compacted_items` counts them). */
  context_compaction: Readonly<{
    run_id: string; kind: "clearing" | "native" | "summary"; mode: "background" | "foreground"; reason: "threshold" | "overflow";
    /** `compacted`: its item entered the transcript; `adopted`: a later run swapped in a compaction it joined;
     * `discarded`: it finished but no longer applied. */
    outcome: "adopted" | "compacted" | "discarded" | "failed" | "cancelled";
    /** It finished after its run had completed. */
    detached?: boolean;
    code?: string; duration_ms?: number; calls?: number; chunks?: number; fallback?: boolean;
    tokens_before?: number; tokens_after?: number; input_tokens?: number; output_tokens?: number;
    compacted_items?: number; kept_items?: number;
  }>;
  provider_request: ProviderFields;
  provider_retry: ProviderFields;
  /** One refused upload request: its stable code and safe facts, never the file name, declared type, content or an upload or attachment id.
   * Only an unexpected failure (`upload_unavailable`) carries its caught error and is an error; every other refusal warns. */
  upload_refused: CaughtError & Readonly<{
    operation: UploadRefusalOperation; stage?: UploadRefusalStage; code: string; httpStatus: number;
    size_class?: UploadSizeClass; mime_family?: UploadMimeFamily; client_aborted?: boolean;
  }>;
  provider_stream_safety_terminated: ProviderIdentity & Readonly<{ code: string; durationMs: number; limit: number; observed: number; totalStreamBytes: number; termination: string; unit: string }>;
};
