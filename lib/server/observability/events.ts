export type ObservabilityContext = Readonly<{
  trace_id: string; run_id?: string; job_id?: string; tool_call_id?: string; execution_index?: number;
}>;
export type ProcessRole = "app" | "memory_coordinator" | "memory_search" | "knowledge_search" | "workspace_runner" | "maintenance" | "bootstrap" | "storage_relay";
export type Subsystem = "attachments" | "pdf" | "knowledge" | "memory" | "mcp" | "workspace" | "run_recovery" | "chat_title" | "memory_search" | "knowledge_search" | "database" | "object_storage" | "email" | "admin" | "configuration" | "scheduled_tasks" | "push";
export type SubsystemState = "disabled" | "starting" | "unknown" | "ready" | "failed";
export type LifecycleStage = "startup" | "discover" | "reconcile" | "claim" | "drain" | "preflight" | "prepare" | "process" | "parse" | "chunk" | "embed" | "validate" | "publish" | "progress" | "retry" | "complete" | "fail" | "release" | "settle" | "refresh" | "probe" | "evict" | "initialize" | "quiesce" | "export" | "restore" | "recovery" | "continuation" | "cleanup" | "projection" | "integrity" | "rebuild" | "dispatch" | "shutdown" | "read" | "write" | "delete" | "multipart_start" | "multipart_complete" | "multipart_abort" | "multipart_sign" | "health" | "heartbeat";
export type LifecycleOutcome = "started" | "completed" | "failed" | "degraded" | "cancelled" | "stale" | "waiting" | "skipped" | "lost_lease" | "blocked";
export type LifecycleAction = "none" | "retry" | "stop" | "complete" | "fail" | "degrade" | "release" | "skip" | "wait";
export type LifecycleFields = Readonly<{
  subsystem: Subsystem; stage: LifecycleStage; outcome: LifecycleOutcome;
  work_stage?: LifecycleStage;
  job_id?: string; run_id?: string; generation_id?: string; attempt?: number; duration_ms?: number;
  code?: string; prisma_code?: string; httpStatus?: number; action?: LifecycleAction;
  delay_ms?: number; retry_at?: string; count?: number; repeat_count?: number;
  claimed_count?: number; failed_count?: number; completed_count?: number; pending_count?: number;
}>;
export type SubsystemFailure = Readonly<{
  subsystem: Subsystem; stage: LifecycleStage; code?: string; prisma_code?: string; httpStatus?: number; action?: LifecycleAction;
  /** Server-owned identity used only to distinguish internal health states. */
  scope_id?: string;
}>;
export type ToolKind = "search" | "knowledge" | "mcp" | "workspace" | "vision";
export type NestedAbortSource = "parent_signal" | "tool_deadline" | "search_deadline" | "provider_deadline" | "knowledge_deadline" | "mcp_deadline" | "workspace_deadline" | "unknown";
type ToolOperationFields = Readonly<{
  engine_index?: number; operation_index?: number;
  operation_stage?: "retrieval" | "embedding" | "rerank" | "relevance" | "draft" | "selector" | "auditor" | "supplement" | "compose" | "verify";
}>;
type RouteFields = Readonly<{
  method?: "GET" | "HEAD" | "POST" | "PUT" | "PATCH" | "DELETE" | "OPTIONS" | "CONNECT" | "TRACE" | "unknown";
  routePath?: string;
  route_source?: "manifest" | "next_error" | "unknown";
}>;
export type EmergencyFailure = Readonly<{
  stage: "startup" | "uncaught_exception" | "unhandled_rejection";
  outcome: "terminated" | "framework_managed";
  code?: "unexpected" | "runtime_peer_bridge_multiple_servers" | "runtime_peer_bridge_listener_missing" | "runtime_peer_bridge_not_installed";
}>;
type OperationOutcome = "started" | "completed" | "failed" | "cancelled";
/** Only preparation reports a run that continued without optional Memory. */
type PreparationOutcome = OperationOutcome | "degraded";
type Reason = "unknown" | "cancelled" | "deadline" | "network" | "http" | "safety_limit" | "policy" | "invalid_response";
type ProviderIdentity = Readonly<{ providerFamily?: string; adapterKind?: string; connectionId?: string; providerModelId?: string }>;
type ProviderFields = ProviderIdentity & Readonly<{
  stage?: "answer" | "search" | "structured_output" | "cancel" | "refresh" | "retrieve" | "embedding" | "rerank" | "decisions" | "image";
  outcome?: OperationOutcome; duration_ms?: number; attempt?: number; action?: "none" | "retry" | "stop";
  httpStatus?: number; code?: string; reason?: Reason; timeout_ms?: number; delay_ms?: number;
  abort_source?: "provider_deadline" | "parent_signal" | "unknown";
  cause?: "max_output_tokens" | "content_filter";
  provider_status?: "completed" | "failed" | "cancelled" | "incomplete" | "queued" | "in_progress" | "retrying" | "unknown";
}>;
export type EventFields = {
  "http.request_completed": RouteFields & Readonly<{ status?: number; duration_ms?: number; headers_ms?: number; stream?: boolean; outcome: "completed" | "closed" }>;
  "http.request_failed": RouteFields & Readonly<{ stage: "listener" | "next_request"; error_category: "unexpected" }>;
  "http.route_resolver_unavailable": Readonly<{ reason: "missing" | "invalid" | "unsupported" }>;
  "process.failure": EmergencyFailure;
  "process.started": Readonly<{
    node_version: string; attachments?: SubsystemState; memory?: SubsystemState; knowledge?: SubsystemState;
    mcp?: SubsystemState; workspace?: SubsystemState; email?: SubsystemState;
  }>;
  "subsystem.recovered": Readonly<{ subsystem: Subsystem; stage: LifecycleStage; duration_ms?: number; repeat_count?: number }>;
  "readiness.changed": Readonly<{ state: "ready" | "not_ready"; code?: string; issue_count?: number }>;
  "logging.dropped_records": Readonly<{ count: number }>;
  run_accepted: Readonly<{ run_id: string; kind: "send" | "regenerate" | "project"; preparation: "ready" | "memory" | "pdf" }>;
  run_preparation: Readonly<{ run_id: string; stage: "preparing"; outcome: PreparationOutcome; duration_ms?: number; code?: string }>;
  run_execution: Readonly<{ run_id: string; stage: "dispatch" | "execution" | "completion"; outcome: OperationOutcome; duration_ms?: number; code?: string; provider_code?: string; reason?: Reason; abort_source?: "stop" | "workspace_deadline" | "provider_deadline" | "unknown"; timeout_ms?: number; prisma_code?: string }>;
  run_persistence: Readonly<{ run_id: string; stage: "complete" | "fail" | "cancel" | "preparation"; outcome: "confirmed" | "not_applied" | "unconfirmed"; prisma_code?: string }>;
  run_stop_requested: Record<string, never>;
  run_stop_admission: Readonly<{ run_id?: string; outcome: "accepted" | "not_found" | "not_cancelable" | "unauthorized" | "failed"; prisma_code?: string }>;
  run_http_failed: Readonly<{ stage: "send" | "regenerate" | "cancel"; code?: string; reason?: Reason; prisma_code?: string }>;
  run_abort_delivery: Readonly<{ run_id: string; outcome: "delivered" | "already_aborted" | "not_running"; abort_source: "stop" }>;
  job_enqueued: Readonly<{ job_id: string; subsystem: "attachments" | "knowledge" | "memory" | "pdf" | "chat_title" }>;
  job_attempt: LifecycleFields;
  job_persistence: Omit<LifecycleFields, "outcome"> & Readonly<{ outcome: "confirmed" | "not_applied" | "unconfirmed" }>;
  run_recovery: LifecycleFields;
  runtime_lifecycle: LifecycleFields;
  service_operation: LifecycleFields;
  tool_execution: ToolOperationFields & ProviderIdentity & Readonly<{
    tool_kind: ToolKind; stage: "admission" | "execution" | "request" | "result" | "grounding";
    outcome: "started" | "completed" | "failed" | "cancelled" | "degraded";
    duration_ms?: number; attempt?: number; code?: string; reason?: Reason; httpStatus?: number;
    action?: LifecycleAction; count?: number;
  }>;
  /** Local tool search statistics; never the query or tool names. */
  mcp_discovery: Readonly<{
    outcome: "completed" | "failed" | "cancelled"; duration_ms: number; mode?: "select" | "keywords";
    candidate_count?: number; result_count?: number; loaded_count: number; already_loaded_count: number;
    unknown_name_count?: number;
  }>;
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
    operation?: "answer" | "search" | "structured_output" | "cancel" | "refresh" | "retrieve" | "embedding" | "rerank" | "decisions" | "image";
    attempt?: number;
  }>;
  transport_stage: ProviderIdentity & Readonly<{
    transport: "provider" | "mcp"; stage: "fetch" | "headers" | "body" | "stream" | "parse";
    operation?: "answer" | "search" | "structured_output" | "cancel" | "refresh" | "retrieve" | "embedding" | "rerank" | "decisions" | "image";
    outcome: OperationOutcome; duration_ms?: number; httpStatus?: number; code?: string;
    category?: "dns" | "tls" | "connect" | "timeout" | "parse" | "http" | "aborted" | "unknown";
    bytes?: number; chunks?: number; last_progress_ms?: number; timeout_ms?: number; attempt?: number;
  }>;
  provider_operation: ProviderFields;
  /** Provider-reported input tokens of one dispatched round against the
   * context budget's estimate of the same request (numbers only). */
  context_estimate: Pick<ProviderIdentity, "providerFamily"> & Readonly<{
    estimate_family: "anthropic" | "deepseek" | "gemini" | "openai" | "unknown";
    estimated_tokens: number; reported_input_tokens: number; ratio_permille: number;
  }>;
  provider_request: ProviderFields;
  provider_retry: ProviderFields;
  /** One compared lexical lane of an operator shadow rollout; counts and codes only. */
  memory_lexical_shadow: Readonly<{
    stage: "BASELINE" | "ENRICHED" | "INTRA_CHAT";
    lane?: "FACT_LEXICAL_UNICODE" | "FACT_LEXICAL_NGRAM" | "HISTORY_RECALL_LEXICAL_UNICODE";
    outcome: "completed" | "failed"; duration_ms?: number; code?: string; timed_out?: boolean;
    opensearch_duration_ms?: number; opensearch_code?: string; opensearch_timed_out?: boolean; opaque_id_present?: boolean;
    raw_candidate_count?: number; canonical_accepted_count?: number; rejected_authority_count?: number;
    rejected_generation_count?: number; rejected_hash_count?: number; projection_caught_up?: boolean;
    projection_event_lag?: number; projection_revision_lag?: number; projection_visible_age_ms?: number;
    folded_count?: number; ngram_count?: number; transliterated_count?: number; unicode_count?: number;
    postgres_raw_candidate_count?: number; postgres_canonical_accepted_count?: number;
    reference_top10_count?: number; candidate_top10_count?: number; top10_intersection_count?: number;
    reference_top10_in_candidate_top50_count?: number;
    /** Candidate top-50 rank of the reference's first entry; 0 when absent. */
    first_reference_rank?: number;
  }>;
  provider_stream_safety_terminated: ProviderIdentity & Readonly<{ code: string; durationMs: number; limit: number; observed: number; totalStreamBytes: number; termination: string; unit: string }>;
};
