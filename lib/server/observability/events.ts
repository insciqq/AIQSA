export type ObservabilityContext = Readonly<{
  trace_id: string; run_id?: string; job_id?: string; tool_call_id?: string; execution_index?: number;
}>;
export type ProcessRole = "app" | "memory_coordinator" | "memory_search" | "knowledge_search" | "workspace_runner" | "maintenance" | "bootstrap";
export type Subsystem = "attachments" | "pdf" | "knowledge" | "memory" | "mcp" | "workspace" | "run_recovery" | "chat_title" | "memory_search" | "knowledge_search" | "database" | "object_storage" | "email" | "admin" | "configuration";
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
export type ToolKind = "search" | "knowledge" | "mcp" | "workspace";
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
type Reason = "unknown" | "cancelled" | "deadline" | "network" | "http" | "safety_limit" | "policy" | "invalid_response";
type ProviderIdentity = Readonly<{ providerFamily?: string; adapterKind?: string; connectionId?: string; providerModelId?: string }>;
type ProviderFields = ProviderIdentity & Readonly<{
  stage?: "answer" | "search" | "structured_output" | "cancel" | "refresh" | "retrieve" | "embedding" | "rerank" | "decisions";
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
  run_preparation: Readonly<{ run_id: string; stage: "preparing"; outcome: OperationOutcome; duration_ms?: number; code?: string }>;
  run_execution: Readonly<{ run_id: string; stage: "dispatch" | "execution" | "completion"; outcome: OperationOutcome; duration_ms?: number; code?: string; reason?: Reason; abort_source?: "stop" | "workspace_deadline" | "provider_deadline" | "unknown"; timeout_ms?: number; prisma_code?: string }>;
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
  tool_execution: ToolOperationFields & Readonly<{
    tool_kind: ToolKind; stage: "admission" | "execution" | "request" | "result" | "grounding";
    outcome: "started" | "completed" | "failed" | "cancelled" | "degraded";
    duration_ms?: number; attempt?: number; code?: string; reason?: Reason; httpStatus?: number;
    action?: LifecycleAction; count?: number;
  }>;
  mcp_discovery: Readonly<{
    outcome: "started" | "completed"; attempt: number; duration_ms?: number;
    correction_reason: "none" | "uncovered_outcomes" | "tool_limit" | "coverage_and_limit";
    input_bytes: number; candidate_count: number; selected_count?: number; requirement_count?: number;
    uncovered_count?: number; previous_uncovered_count?: number; selection_changed?: boolean;
  }>;
  tool_deadline: ToolOperationFields & Readonly<{
    tool_kind: ToolKind; outer_timeout_ms?: number; configured_timeout_ms?: number;
    provider_timeout_ms?: number; effective_timeout_ms?: number; request_timeout_ms?: number;
  }>;
  provider_deadline: ProviderIdentity & Readonly<{
    stage?: "answer" | "search" | "structured_output" | "cancel" | "refresh" | "retrieve" | "embedding" | "rerank" | "decisions";
    configured_timeout_ms?: number; provider_timeout_ms?: number; effective_timeout_ms?: number; poll_timeout_ms?: number;
    stream_idle_timeout_ms?: number; stream_absolute_timeout_ms?: number;
  }>;
  nested_abort: ProviderIdentity & ToolOperationFields & Readonly<{
    layer: "tool" | ToolKind | "provider"; stage: "before_start" | "delivery";
    abort_source: NestedAbortSource; duration_ms?: number; timeout_ms?: number;
    deadline_kind?: "operation" | "request" | "sdk_request" | "stream_idle" | "stream_absolute" | "polling";
    operation?: "answer" | "search" | "structured_output" | "cancel" | "refresh" | "retrieve" | "embedding" | "rerank" | "decisions";
    attempt?: number;
  }>;
  transport_stage: ProviderIdentity & Readonly<{
    transport: "provider" | "mcp"; stage: "fetch" | "headers" | "body" | "stream" | "parse";
    operation?: "answer" | "search" | "structured_output" | "cancel" | "refresh" | "retrieve" | "embedding" | "rerank" | "decisions";
    outcome: OperationOutcome; duration_ms?: number; httpStatus?: number; code?: string;
    category?: "dns" | "tls" | "connect" | "timeout" | "parse" | "http" | "aborted" | "unknown";
    bytes?: number; chunks?: number; last_progress_ms?: number; timeout_ms?: number; attempt?: number;
  }>;
  provider_operation: ProviderFields;
  provider_request: ProviderFields;
  provider_retry: ProviderFields;
  provider_stream_safety_terminated: ProviderIdentity & Readonly<{ code: string; durationMs: number; limit: number; observed: number; totalStreamBytes: number; termination: string; unit: string }>;
};
