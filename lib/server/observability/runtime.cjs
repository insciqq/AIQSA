"use strict";

const { AsyncLocalStorage } = require("node:async_hooks");
const { randomBytes } = require("node:crypto");
const fs = require("node:fs");
const { version } = require("../../../package.json");

const RUNTIME_KEY = Symbol.for("aiqsa.observability.v1");
const MAX_RECORD_BYTES = 4096;
const MAX_OUTPUT_BYTES = 64 * 1024;
const MAX_DROPPED = 2147483647;
const MAX_ROUTE_TEMPLATES = 8192;
const MAX_SYSTEM_FAILURES = 256;
const SYSTEM_FAILURE_INTERVAL_MS = 30_000;
const roles = new Set(["app", "memory_coordinator", "memory_search", "knowledge_search", "workspace_runner", "maintenance", "bootstrap"]);
const methods = ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS", "CONNECT", "TRACE", "unknown"];
const ownValue = (object, key) => {
  if (!object || typeof object !== "object") return undefined;
  return Object.getOwnPropertyDescriptor(object, key)?.value;
};
const enumeration = (...values) => (value) => values.includes(value) ? value : undefined;
const integer = (min, max) => (value) => typeof value === "number" && Number.isSafeInteger(value) && value >= min && value <= max ? value : undefined;
const duration = (value) => typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= Number.MAX_SAFE_INTEGER ? Math.round(value) : undefined;
const bool = (value) => typeof value === "boolean" ? value : undefined;
const identifier = (value) => typeof value === "string" && value.length <= 128 && /^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(value) ? value : undefined;
const traceId = (value) => typeof value === "string" && /^[0-9a-f]{32}$/.test(value) && value !== "0".repeat(32) ? value : undefined;
const routeTemplate = (value) => typeof value === "string" && getRuntime().routes.has(value) ? value : undefined;
const routeFields = {
  method: enumeration(...methods), routePath: routeTemplate,
  route_source: enumeration("manifest", "next_error", "unknown")
};
const safeCodes = new Set(require("./failureCodes.json"));
const reason = enumeration("unknown", "cancelled", "deadline", "network", "http", "safety_limit", "policy", "invalid_response");
const safeCode = (value) => safeCodes.has(value) ? value : value === undefined ? undefined : "unknown";
const operationOutcome = enumeration("started", "completed", "failed", "cancelled");
const providerIdentity = {
  providerFamily: enumeration("anthropic", "deepseek", "gemini", "openai", "openai_compatible", "openrouter", "fake"),
  adapterKind: enumeration("anthropic_messages", "deepseek_responses_native", "gemini_interactions_native", "openai_chat_completions_compatible", "openai_responses_compatible", "openai_responses_native", "openai_embeddings_compatible", "openrouter_chat_completions", "openrouter_rerank", "openai_images_native", "openai_images_compatible", "gemini_images_native", "openrouter_images", "fake"),
  connectionId: identifier, providerModelId: identifier
};
const providerStage = enumeration("answer", "search", "structured_output", "cancel", "refresh", "retrieve", "embedding", "rerank");
const providerFields = {
  ...providerIdentity, stage: providerStage,
  outcome: operationOutcome, duration_ms: duration, attempt: integer(1, 1000),
  action: enumeration("none", "retry", "stop"), httpStatus: integer(100, 599), code: safeCode, reason,
  timeout_ms: duration, delay_ms: duration, abort_source: enumeration("provider_deadline", "parent_signal", "unknown"),
  cause: enumeration("max_output_tokens", "content_filter"),
  provider_status: enumeration("completed", "failed", "cancelled", "incomplete", "queued", "in_progress", "retrying", "unknown")
};
const operationLevel = (fields) => fields.outcome === "failed" ? fields.action === "retry" ? "warn" : "error" : "info";
const prismaCode = (value) => typeof value === "string" && /^P\d{4}$/.test(value) ? value : value === undefined ? undefined : "unknown";
const subsystem = enumeration("attachments", "pdf", "knowledge", "memory", "mcp", "workspace", "run_recovery", "chat_title", "memory_search", "knowledge_search", "database", "object_storage", "email", "admin", "configuration");
const subsystemState = enumeration("disabled", "starting", "unknown", "ready", "failed");
const lifecycleStage = enumeration("startup", "discover", "reconcile", "claim", "drain", "preflight", "prepare", "process", "parse", "chunk", "embed", "validate", "publish", "progress", "retry", "complete", "fail", "release", "settle", "refresh", "probe", "evict", "initialize", "quiesce", "export", "recovery", "continuation", "cleanup", "projection", "integrity", "rebuild", "dispatch", "shutdown", "read", "write", "delete", "multipart_start", "multipart_complete", "multipart_abort", "multipart_sign", "health", "heartbeat");
const lifecycleAction = enumeration("none", "retry", "stop", "complete", "fail", "degrade", "release", "skip", "wait");
const lifecycleOutcome = enumeration("started", "completed", "failed", "degraded", "cancelled", "stale", "waiting", "skipped", "lost_lease", "blocked");
const timestamp = (value) => typeof value === "string" && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value) && Number.isFinite(Date.parse(value)) ? value : undefined;
const lifecycleFields = {
  work_stage: lifecycleStage,
  subsystem, stage: lifecycleStage, outcome: lifecycleOutcome, job_id: identifier, run_id: identifier, generation_id: identifier,
  attempt: integer(1, MAX_DROPPED), duration_ms: duration, code: safeCode, prisma_code: prismaCode,
  httpStatus: integer(100, 599), action: lifecycleAction, delay_ms: duration, retry_at: timestamp,
  count: integer(0, MAX_DROPPED), repeat_count: integer(0, MAX_DROPPED),
  claimed_count: integer(0, MAX_DROPPED), failed_count: integer(0, MAX_DROPPED),
  completed_count: integer(0, MAX_DROPPED), pending_count: integer(0, MAX_DROPPED)
};
const lifecycleLevel = (fields) => fields.outcome === "failed" || fields.outcome === "blocked"
  ? ["retry", "degrade", "wait"].includes(fields.action) ? "warn" : "error"
  : fields.outcome === "degraded" ? "warn" : "info";
const toolKind = enumeration("search", "knowledge", "mcp", "workspace");
const toolOperationFields = {
  engine_index: integer(1, MAX_DROPPED), operation_index: integer(1, 8),
  operation_stage: enumeration("retrieval", "embedding", "rerank", "draft", "selector", "auditor", "supplement", "compose", "verify")
};

// This is the runtime allowlist. Only event-specific fields are ever read, and
// getters, toJSON, arbitrary errors, and request/provider objects are not invoked.
const catalog = Object.freeze({
  "http.request_completed": {
    fields: { ...routeFields, status: integer(100, 599), duration_ms: duration, headers_ms: duration, stream: bool, outcome: enumeration("completed", "closed") },
    level: (fields) => fields.status >= 500 ? "error" : fields.status >= 400 || fields.outcome === "closed" && fields.stream !== true ? "warn" : "info"
  },
  "http.request_failed": {
    fields: { ...routeFields, stage: enumeration("listener", "next_request"), error_category: enumeration("unexpected") }, level: "error"
  },
  "http.route_resolver_unavailable": {
    fields: { reason: enumeration("missing", "invalid", "unsupported") }, level: "warn"
  },
  "process.failure": {
    fields: {
      stage: enumeration("startup", "uncaught_exception", "unhandled_rejection"),
      outcome: enumeration("terminated", "framework_managed"),
      code: enumeration("unexpected", "runtime_peer_bridge_multiple_servers", "runtime_peer_bridge_listener_missing", "runtime_peer_bridge_not_installed")
    }, level: (fields) => fields.outcome === "terminated" ? "fatal" : "error"
  },
  "process.started": {
    fields: {
      node_version: (value) => typeof value === "string" && /^v\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(value) ? value : undefined,
      attachments: subsystemState, memory: subsystemState, knowledge: subsystemState,
      mcp: subsystemState, workspace: subsystemState, email: subsystemState
    }, level: "info"
  },
  "subsystem.recovered": { fields: { subsystem, stage: lifecycleStage, duration_ms: duration, repeat_count: integer(0, MAX_DROPPED) }, level: "info" },
  "readiness.changed": { fields: { state: enumeration("ready", "not_ready"), code: safeCode, issue_count: integer(0, 64) }, level: (fields) => fields.state === "not_ready" ? "warn" : "info" },
  "logging.dropped_records": { fields: { count: integer(1, MAX_DROPPED) }, level: "warn" },
  "run_accepted": { fields: { run_id: identifier, kind: enumeration("send", "regenerate", "project"), preparation: enumeration("ready", "memory", "pdf") }, level: "info" },
  "run_preparation": { fields: { run_id: identifier, stage: enumeration("preparing"), outcome: operationOutcome, duration_ms: duration, code: safeCode }, level: operationLevel },
  "run_execution": { fields: { run_id: identifier, stage: enumeration("dispatch", "execution", "completion"), outcome: operationOutcome, duration_ms: duration, code: safeCode, reason, abort_source: enumeration("stop", "workspace_deadline", "provider_deadline", "unknown"), timeout_ms: duration, prisma_code: prismaCode }, level: operationLevel },
  "run_persistence": { fields: { run_id: identifier, stage: enumeration("complete", "fail", "cancel", "preparation"), outcome: enumeration("confirmed", "not_applied", "unconfirmed"), prisma_code: prismaCode }, level: (fields) => fields.outcome === "unconfirmed" ? "error" : "info" },
  "run_stop_requested": { fields: {}, level: "info" },
  "run_stop_admission": { fields: { run_id: identifier, outcome: enumeration("accepted", "not_found", "not_cancelable", "unauthorized", "failed"), prisma_code: prismaCode }, level: operationLevel },
  "run_http_failed": { fields: { stage: enumeration("send", "regenerate", "cancel"), code: safeCode, reason, prisma_code: prismaCode }, level: "error" },
  "run_abort_delivery": { fields: { run_id: identifier, outcome: enumeration("delivered", "already_aborted", "not_running"), abort_source: enumeration("stop") }, level: "info" },
  "job_enqueued": { fields: { job_id: identifier, subsystem: enumeration("attachments", "knowledge", "memory", "pdf", "chat_title") }, level: "info" },
  "job_attempt": { fields: lifecycleFields, level: lifecycleLevel },
  "job_persistence": { fields: { ...lifecycleFields, outcome: enumeration("confirmed", "not_applied", "unconfirmed") }, level: (fields) => fields.outcome === "unconfirmed" ? "error" : "info" },
  "run_recovery": { fields: lifecycleFields, level: lifecycleLevel },
  "runtime_lifecycle": { fields: lifecycleFields, level: lifecycleLevel },
  "service_operation": { fields: lifecycleFields, level: lifecycleLevel },
  "tool_execution": {
    fields: { ...toolOperationFields, tool_kind: toolKind, stage: enumeration("admission", "execution", "request", "result", "grounding"), outcome: enumeration("started", "completed", "failed", "cancelled", "degraded"), duration_ms: duration, attempt: integer(1, MAX_DROPPED), code: safeCode, reason, httpStatus: integer(100, 599), action: lifecycleAction, count: integer(0, MAX_DROPPED) }, level: lifecycleLevel
  },
  "tool_deadline": { fields: { ...toolOperationFields, tool_kind: toolKind, outer_timeout_ms: duration, configured_timeout_ms: duration, provider_timeout_ms: duration, effective_timeout_ms: duration, request_timeout_ms: duration }, level: "info" },
  "provider_deadline": { fields: { ...providerIdentity, stage: providerStage, configured_timeout_ms: duration, provider_timeout_ms: duration, effective_timeout_ms: duration, poll_timeout_ms: duration, stream_idle_timeout_ms: duration, stream_absolute_timeout_ms: duration }, level: "info" },
  "nested_abort": { fields: { ...providerIdentity, ...toolOperationFields, layer: enumeration("tool", "search", "knowledge", "mcp", "workspace", "provider"), stage: enumeration("before_start", "delivery"), abort_source: enumeration("parent_signal", "tool_deadline", "search_deadline", "provider_deadline", "knowledge_deadline", "mcp_deadline", "workspace_deadline", "unknown"), duration_ms: duration, timeout_ms: duration, deadline_kind: enumeration("operation", "request", "sdk_request", "stream_idle", "stream_absolute", "polling"), operation: providerStage, attempt: integer(1, MAX_DROPPED) }, level: (fields) => typeof fields.abort_source === "string" && fields.abort_source.endsWith("_deadline") ? "warn" : "info" },
  "transport_stage": {
    fields: { ...providerIdentity, transport: enumeration("provider", "mcp"), stage: enumeration("fetch", "headers", "body", "stream", "parse"), operation: providerStage, outcome: operationOutcome, duration_ms: duration, httpStatus: integer(100, 599), code: safeCode, category: enumeration("dns", "tls", "connect", "timeout", "parse", "http", "aborted", "unknown"), bytes: integer(0, Number.MAX_SAFE_INTEGER), chunks: integer(0, Number.MAX_SAFE_INTEGER), last_progress_ms: duration, timeout_ms: duration, attempt: integer(1, MAX_DROPPED) }, level: (fields) => fields.outcome === "failed" ? "warn" : "info"
  },
  "provider_operation": { fields: providerFields, level: operationLevel },
  // An individual transport attempt has not decided the operation's outcome.
  // The retry owner and provider_operation report the decision and final failure.
  "provider_request": { fields: providerFields, level: (fields) => fields.outcome === "failed" ? "warn" : "info" },
  "provider_retry": { fields: providerFields, level: "warn" },
  "provider_stream_safety_terminated": {
    fields: { ...providerIdentity, code: safeCode, durationMs: duration, limit: duration, observed: duration, totalStreamBytes: duration, termination: enumeration("absolute_deadline", "event_limit", "idle_timeout", "normal", "output_limit", "total_limit", "user_cancelled"), unit: enumeration("bytes", "characters", "milliseconds") }, level: "error"
  }
});

function createTraceId() {
  let value;
  do { value = randomBytes(16).toString("hex"); } while (!traceId(value));
  return value;
}

function getRuntime() {
  if (!globalThis[RUNTIME_KEY]) {
    Object.defineProperty(globalThis, RUNTIME_KEY, {
      value: { storage: new AsyncLocalStorage(), instanceId: createTraceId(), role: "app", routes: new Set(), writer: null },
      configurable: false, enumerable: false, writable: false
    });
  }
  return globalThis[RUNTIME_KEY];
}

function getContext() { return getRuntime().storage.getStore(); }

function contextFields(fields, parent) {
  const context = { trace_id: traceId(ownValue(fields, "trace_id")) ?? parent?.trace_id ?? createTraceId() };
  for (const key of ["run_id", "job_id", "tool_call_id"]) {
    const value = identifier(ownValue(fields, key)) ?? parent?.[key];
    if (value !== undefined) context[key] = value;
  }
  const executionIndex = integer(0, MAX_DROPPED)(ownValue(fields, "execution_index")) ?? parent?.execution_index;
  if (executionIndex !== undefined) context.execution_index = executionIndex;
  return Object.freeze(context);
}

function runWithContext(fields, fn) {
  return getRuntime().storage.run(contextFields(fields, getContext()), fn);
}

function runInBackground(fn) {
  return getRuntime().storage.run(contextFields({}, undefined), fn);
}

function bindContext(fn) {
  const context = getContext();
  return function boundContext(...args) {
    return getRuntime().storage.run(context, () => Reflect.apply(fn, this, args));
  };
}

function registerRouteTemplates(paths) {
  const routes = getRuntime().routes;
  for (const value of paths) {
    if (routes.size >= MAX_ROUTE_TEMPLATES) break;
    if (typeof value === "string" && value.length <= 512 && /^\/(?:[a-zA-Z0-9_./@()-]|\[(?:\[)?(?:\.\.\.)?[a-zA-Z0-9_-]+\](?:\])?)*$/.test(value)) routes.add(value);
  }
}

function setProcessRole(role) {
  if (roles.has(role)) getRuntime().role = role;
}

function serializeEvent(event, input) {
  try {
    if (typeof event !== "string" || !Object.hasOwn(catalog, event)) return undefined;
    const definition = catalog[event];
    const fields = {};
    for (const [key, validate] of Object.entries(definition.fields)) {
      const value = validate(ownValue(input, key));
      if (value !== undefined) fields[key] = value;
    }
    if (event === "job_persistence" && fields.outcome !== "confirmed") delete fields.retry_at;
    const runtime = getRuntime();
    const record = {
      timestamp: new Date().toISOString(),
      level: typeof definition.level === "function" ? definition.level(fields) : definition.level,
      event, role: runtime.role, app_version: version, instance_id: runtime.instanceId
    };
    const context = getContext();
    for (const key of ["trace_id", "run_id", "job_id", "tool_call_id", "execution_index"]) {
      if (context?.[key] !== undefined) record[key] = context[key];
    }
    for (const [key, value] of Object.entries(fields)) record[key] = value;
    const line = JSON.stringify(record) + "\n";
    return Buffer.byteLength(line) <= MAX_RECORD_BYTES ? line : undefined;
  } catch {
    return undefined;
  }
}

function createWriter(sink) {
  let blocked = false;
  let dropped = 0;
  const lose = () => { dropped = Math.min(MAX_DROPPED, dropped + 1); };
  const unavailable = () => blocked || sink.destroyed || sink.writable === false || sink.writableNeedDrain || sink.writableLength + MAX_RECORD_BYTES > MAX_OUTPUT_BYTES;
  const write = (line) => {
    try {
      if (unavailable()) return false;
      blocked = sink.write(line) === false;
      return true;
    } catch {
      return false;
    }
  };
  const reportDropped = () => {
    if (!dropped || unavailable()) return;
    // Sink recovery is a process fact, never attributed to the request that
    // happened to trigger drain or the next write.
    const line = getRuntime().storage.run(undefined, () => serializeEvent("logging.dropped_records", { count: dropped }));
    if (line && write(line)) dropped = 0;
  };
  sink.on("error", () => { blocked = false; lose(); });
  sink.on("drain", () => { blocked = false; reportDropped(); });
  return Object.freeze({
    logEvent(event, fields, serialize = serializeEvent) {
      try {
        const line = serialize(event, fields);
        if (!line) { lose(); return; }
        reportDropped();
        if (!write(line)) lose();
      } catch { lose(); }
    }
  });
}

function logEvent(event, fields) {
  try {
    const runtime = getRuntime();
    runtime.writer ??= createWriter(process.stdout);
    // HMR keeps one sink and its backpressure state, but each loaded module
    // validates with its current schema instead of the first writer's closure.
    runtime.writer.logEvent(event, fields, serializeEvent);
  } catch { /* Diagnostics must not replace an operation's result. */ }
}

function writeEmergencyFailure(fields) {
  try {
    const line = serializeEvent("process.failure", fields);
    if (line) fs.writeSync(2, line);
  } catch { /* One bounded best-effort write; never recurse or retry. */ }
}

function processEvent(event, fields) {
  getRuntime().storage.run(undefined, () => logEvent(event, fields));
}

function announceProcess(fields = {}) {
  try {
    const runtime = getRuntime();
    if (runtime.started) return;
    runtime.started = true;
    const summary = { node_version: process.version };
    for (const key of ["attachments", "memory", "knowledge", "mcp", "workspace", "email"]) {
      summary[key] = subsystemState(ownValue(fields, key));
    }
    processEvent("process.started", summary);
  } catch { /* Observing startup never changes initialization. */ }
}

function reportSubsystemFailure(input) {
  try {
    const selectedSubsystem = subsystem(ownValue(input, "subsystem"));
    const stage = lifecycleStage(ownValue(input, "stage"));
    if (!selectedSubsystem || !stage) return;
    const code = safeCode(ownValue(input, "code")) ?? "unknown";
    const failures = getRuntime().systemFailures ??= new Map();
    const scopeId = identifier(ownValue(input, "scope_id"));
    const key = `${selectedSubsystem}:${stage}:${code}:${scopeId ?? ""}`;
    const now = Date.now();
    let state = failures.get(key);
    if (!state) {
      if (failures.size >= MAX_SYSTEM_FAILURES) failures.delete(failures.keys().next().value);
      state = { subsystem: selectedSubsystem, stage, scopeId, first: now, last: now, observations: 0, suppressed: 0 };
      failures.set(key, state);
    }
    state.observations = Math.min(MAX_DROPPED, state.observations + 1);
    if (state.observations > 1 && now - state.last < SYSTEM_FAILURE_INTERVAL_MS) {
      state.suppressed = Math.min(MAX_DROPPED, state.suppressed + 1);
      return;
    }
    processEvent("runtime_lifecycle", {
      subsystem: selectedSubsystem, stage, outcome: "failed", code,
      prisma_code: ownValue(input, "prisma_code"), httpStatus: ownValue(input, "httpStatus"),
      action: ownValue(input, "action"), repeat_count: state.suppressed
    });
    state.last = now;
    state.suppressed = 0;
  } catch { /* A failed observation cannot alter the coordinator's decision. */ }
}

function reportSubsystemHealthy(selectedSubsystem, stage, selectedScopeId) {
  try {
    if (!subsystem(selectedSubsystem) || !lifecycleStage(stage)) return;
    const scopeId = identifier(selectedScopeId);
    const failures = getRuntime().systemFailures;
    if (!failures) return;
    let first = Date.now();
    let repeats = 0;
    let recovered = false;
    for (const [key, state] of failures) {
      if (state.subsystem !== selectedSubsystem || state.stage !== stage || state.scopeId !== scopeId) continue;
      recovered = true;
      first = Math.min(first, state.first);
      repeats = Math.min(MAX_DROPPED, repeats + state.observations - 1);
      failures.delete(key);
    }
    if (recovered) processEvent("subsystem.recovered", {
      subsystem: selectedSubsystem, stage, duration_ms: Math.max(0, Date.now() - first), repeat_count: repeats
    });
  } catch { /* Healthy polling must not fail because diagnostics failed. */ }
}

function reportReadiness(state, code, issueCount) {
  try {
    if (!["ready", "not_ready"].includes(state)) return;
    const fields = { state, code: state === "ready" ? undefined : safeCode(code), issue_count: integer(0, 64)(issueCount) };
    const key = `${fields.state}:${fields.code}:${fields.issue_count}`;
    if (getRuntime().readiness === key) return;
    getRuntime().readiness = key;
    processEvent("readiness.changed", fields);
  } catch { /* Readiness authority remains with its checks. */ }
}

module.exports = {
  MAX_RECORD_BYTES, MAX_OUTPUT_BYTES, createTraceId, getContext, runWithContext,
  runInBackground, bindContext, registerRouteTemplates, setProcessRole,
  serializeEvent, createWriter, logEvent, writeEmergencyFailure,
  announceProcess, reportSubsystemFailure, reportSubsystemHealthy, reportReadiness
};
