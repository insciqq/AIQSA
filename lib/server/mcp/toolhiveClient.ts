const DEFAULT_REQUEST_TIMEOUT_MS = 10_000;
const DEFAULT_LONG_REQUEST_TIMEOUT_MS = 11 * 60_000;
const DEFAULT_MAX_REQUEST_BYTES = 256 * 1_024;
const DEFAULT_MAX_RESPONSE_BYTES = 512 * 1_024;
const MAX_WORKLOAD_LOG_BYTES = 16 * 1_024;
const TOOLHIVE_GENERATED_IMAGE = /^toolhivelocal\/[a-z0-9][a-z0-9._/-]*:[a-z0-9][a-z0-9._-]*$/u;
const MISSING_IMAGE_ERROR = /(?:no such image|pull access denied|repository does not exist|image[^\n]{0,80}not found)/iu;

export const TOOLHIVE_EXPECTED_VERSION = "v0.40.1";

const WORKLOAD_STATUSES = [
  "running",
  "stopped",
  "error",
  "starting",
  "stopping",
  "unhealthy",
  "removing",
  "unknown",
  "unauthenticated",
  "auth_retrying",
  "policy_stopped"
] as const;

export type ToolHiveWorkloadStatus = (typeof WORKLOAD_STATUSES)[number];

export type ToolHiveFetch = (
  input: RequestInfo | URL,
  init?: RequestInit
) => Promise<Response>;

export type ToolHiveClientErrorCode =
  | "toolhive_artifact_missing"
  | "toolhive_configuration_invalid"
  | "toolhive_http_error"
  | "toolhive_request_aborted"
  | "toolhive_request_failed"
  | "toolhive_request_too_large"
  | "toolhive_request_timed_out"
  | "toolhive_response_invalid"
  | "toolhive_response_too_large"
  | "toolhive_version_mismatch";

export class ToolHiveClientError extends Error {
  readonly code: ToolHiveClientErrorCode;
  readonly operation: string;
  readonly status: number | null;

  constructor(input: {
    code: ToolHiveClientErrorCode;
    operation: string;
    status?: number;
  }) {
    super(input.code);
    this.name = "ToolHiveClientError";
    this.code = input.code;
    this.operation = input.operation;
    this.status = input.status ?? null;
  }
}

export type ToolHiveWorkloadSummary = Readonly<{
  group: string;
  name: string;
  port: number;
  proxyMode: string;
  remote: boolean;
  status: ToolHiveWorkloadStatus;
  transportType: string;
  url: string;
}>;

/** Sensitive: envVars contains the exact plaintext workload environment. */
export type ToolHiveWorkloadDetail = Readonly<{
  cmdArguments: readonly string[];
  envVars: Readonly<Record<string, string>>;
  group: string;
  host: string;
  image: string;
  name: string;
  networkIsolation: boolean;
  proxyMode: string;
  proxyPort: number;
  transport: string;
}>;

export type ToolHiveLocalWorkloadRequest = Readonly<{
  cmdArguments: readonly string[];
  envVars: Readonly<Record<string, string>>;
  group: string;
  image: string;
  name: string;
}>;

type RequestOptions<Result> = Readonly<{
  body?: unknown;
  classifyHttpError?: (body: string, status: number) => ToolHiveClientErrorCode | null;
  expectedStatuses: readonly number[];
  longRunning?: boolean;
  maxResponseBytes?: number;
  method: "DELETE" | "GET" | "POST";
  operation: string;
  parse?: (value: unknown) => Result;
  parseText?: (value: string) => Result;
  path: string;
  signal?: AbortSignal;
}>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function positiveInteger(value: number): boolean {
  return Number.isInteger(value) && value > 0;
}

function configurationError(operation: string): ToolHiveClientError {
  return new ToolHiveClientError({
    code: "toolhive_configuration_invalid",
    operation
  });
}

function responseError(operation: string): ToolHiveClientError {
  return new ToolHiveClientError({
    code: "toolhive_response_invalid",
    operation
  });
}

function requiredString(
  value: Record<string, unknown>,
  key: string,
  operation: string
): string {
  const field = value[key];
  if (typeof field !== "string" || field.length === 0) throw responseError(operation);
  return field;
}

function optionalString(
  value: Record<string, unknown>,
  key: string,
  operation: string
): string {
  const field = value[key];
  if (typeof field === "undefined" || field === null) return "";
  if (typeof field !== "string") throw responseError(operation);
  return field;
}

function requiredPort(
  value: Record<string, unknown>,
  key: string,
  operation: string
): number {
  const field = value[key];
  if (typeof field !== "number" || !positiveInteger(field) || field > 65_535) {
    throw responseError(operation);
  }
  return field;
}

function stringArray(value: unknown, operation: string): readonly string[] {
  if (value === null || typeof value === "undefined") return [];
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string")) {
    throw responseError(operation);
  }
  return [...value];
}

function stringRecord(value: unknown, operation: string): Readonly<Record<string, string>> {
  if (value === null || typeof value === "undefined") return {};
  if (!isRecord(value) || Object.values(value).some((entry) => typeof entry !== "string")) {
    throw responseError(operation);
  }
  return Object.fromEntries(Object.entries(value) as [string, string][]);
}

function parseWorkloadStatus(value: unknown, operation: string): ToolHiveWorkloadStatus {
  if (typeof value !== "string" || !WORKLOAD_STATUSES.includes(value as ToolHiveWorkloadStatus)) {
    throw responseError(operation);
  }
  return value as ToolHiveWorkloadStatus;
}

function parseWorkloadSummary(value: unknown): ToolHiveWorkloadSummary {
  const operation = "list_workloads";
  if (!isRecord(value)) throw responseError(operation);
  const remote = value.remote ?? false;
  if (typeof remote !== "boolean") throw responseError(operation);
  return {
    group: optionalString(value, "group", operation),
    name: requiredString(value, "name", operation),
    port: requiredPort(value, "port", operation),
    proxyMode: optionalString(value, "proxy_mode", operation),
    remote,
    status: parseWorkloadStatus(value.status, operation),
    transportType: requiredString(value, "transport_type", operation),
    url: requiredString(value, "url", operation)
  };
}

function parseWorkloadDetail(value: unknown): ToolHiveWorkloadDetail {
  const operation = "get_workload";
  if (!isRecord(value) || typeof value.network_isolation !== "boolean") {
    throw responseError(operation);
  }
  return {
    cmdArguments: stringArray(value.cmd_arguments, operation),
    envVars: stringRecord(value.env_vars, operation),
    group: requiredString(value, "group", operation),
    host: requiredString(value, "host", operation),
    image: requiredString(value, "image", operation),
    name: requiredString(value, "name", operation),
    networkIsolation: value.network_isolation,
    proxyMode: requiredString(value, "proxy_mode", operation),
    proxyPort: requiredPort(value, "proxy_port", operation),
    transport: requiredString(value, "transport", operation)
  };
}

function abortReason(signal: AbortSignal): unknown {
  return signal.reason ?? new DOMException("The operation was aborted.", "AbortError");
}

async function readChunk(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  signal: AbortSignal
): Promise<ReadableStreamReadResult<Uint8Array>> {
  if (signal.aborted) throw abortReason(signal);
  return new Promise((resolve, reject) => {
    const handleAbort = () => reject(abortReason(signal));
    signal.addEventListener("abort", handleAbort, { once: true });
    reader.read().then(resolve, reject).finally(() => {
      signal.removeEventListener("abort", handleAbort);
    });
  });
}

async function readBoundedText(
  response: Response,
  input: { maxBytes: number; operation: string; signal: AbortSignal }
): Promise<string> {
  if (!response.body) return "";
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const chunks: string[] = [];
  let receivedBytes = 0;
  let failure: unknown;

  try {
    while (true) {
      const chunk = await readChunk(reader, input.signal);
      if (chunk.done) {
        chunks.push(decoder.decode());
        return chunks.join("");
      }
      receivedBytes += chunk.value.byteLength;
      if (receivedBytes > input.maxBytes) {
        failure = new ToolHiveClientError({
          code: "toolhive_response_too_large",
          operation: input.operation
        });
        throw failure;
      }
      chunks.push(decoder.decode(chunk.value, { stream: true }));
    }
  } catch (error) {
    failure = error;
    try {
      await reader.cancel(error);
    } catch {
      // Preserve the stable bounded-read failure.
    }
    throw error;
  } finally {
    reader.releaseLock();
  }
}

function validateApiName(name: string, operation: string): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/u.test(name)) {
    throw configurationError(operation);
  }
}

function validateLocalRequest(input: ToolHiveLocalWorkloadRequest): ToolHiveLocalWorkloadRequest {
  const operation = "create_workload";
  validateApiName(input.name, operation);
  validateApiName(input.group, operation);
  if (
    input.image.length === 0 ||
    input.image.length > 2_048 ||
    /[\u0000-\u001F\u007F]/u.test(input.image) ||
    input.cmdArguments.length > 128 ||
    input.cmdArguments.some((entry) => entry.length > 8_192 || /[\u0000]/u.test(entry))
  ) {
    throw configurationError(operation);
  }

  const envVars: Record<string, string> = {};
  for (const [name, value] of Object.entries(input.envVars).sort(([left], [right]) => left.localeCompare(right))) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/u.test(name) || name.length > 256 || value.includes("\u0000")) {
      throw configurationError(operation);
    }
    envVars[name] = value;
  }
  return {
    cmdArguments: [...input.cmdArguments],
    envVars,
    group: input.group,
    image: input.image,
    name: input.name
  };
}

export class ToolHiveClient {
  readonly #baseUrl: URL;
  readonly #fetch: ToolHiveFetch;
  readonly #longRequestTimeoutMs: number;
  readonly #maxRequestBytes: number;
  readonly #maxResponseBytes: number;
  readonly #requestTimeoutMs: number;

  constructor(input: Readonly<{
    baseUrl: string | URL;
    fetch?: ToolHiveFetch;
    longRequestTimeoutMs?: number;
    maxRequestBytes?: number;
    maxResponseBytes?: number;
    requestTimeoutMs?: number;
  }>) {
    let baseUrl: URL;
    try {
      baseUrl = new URL(input.baseUrl);
    } catch {
      throw configurationError("configure_client");
    }
    if (
      (baseUrl.protocol !== "http:" && baseUrl.protocol !== "https:") ||
      baseUrl.username ||
      baseUrl.password ||
      baseUrl.pathname !== "/" ||
      baseUrl.search ||
      baseUrl.hash
    ) {
      throw configurationError("configure_client");
    }

    this.#requestTimeoutMs = input.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
    this.#longRequestTimeoutMs = input.longRequestTimeoutMs ?? DEFAULT_LONG_REQUEST_TIMEOUT_MS;
    this.#maxRequestBytes = input.maxRequestBytes ?? DEFAULT_MAX_REQUEST_BYTES;
    this.#maxResponseBytes = input.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES;
    if (
      !positiveInteger(this.#requestTimeoutMs) ||
      !positiveInteger(this.#longRequestTimeoutMs) ||
      !positiveInteger(this.#maxRequestBytes) ||
      !positiveInteger(this.#maxResponseBytes)
    ) {
      throw configurationError("configure_client");
    }
    this.#baseUrl = baseUrl;
    this.#fetch = input.fetch ?? ((url, init) => fetch(url, init));
  }

  async checkHealth(signal?: AbortSignal): Promise<void> {
    await this.#request({
      expectedStatuses: [204],
      method: "GET",
      operation: "health",
      path: "health",
      ...(signal ? { signal } : {})
    });
  }

  async getVersion(signal?: AbortSignal): Promise<string> {
    return this.#request({
      expectedStatuses: [200],
      method: "GET",
      operation: "version",
      parse(value) {
        if (!isRecord(value)) throw responseError("version");
        return requiredString(value, "version", "version");
      },
      path: "api/v1beta/version",
      ...(signal ? { signal } : {})
    });
  }

  async assertCompatibleVersion(signal?: AbortSignal): Promise<void> {
    if (await this.getVersion(signal) !== TOOLHIVE_EXPECTED_VERSION) {
      throw new ToolHiveClientError({
        code: "toolhive_version_mismatch",
        operation: "version"
      });
    }
  }

  async listGroups(signal?: AbortSignal): Promise<readonly string[]> {
    return this.#request({
      expectedStatuses: [200],
      method: "GET",
      operation: "list_groups",
      parse(value) {
        if (!isRecord(value)) throw responseError("list_groups");
        if (value.groups === null) return [];
        if (!Array.isArray(value.groups)) throw responseError("list_groups");
        return value.groups.map((group) => {
          if (!isRecord(group)) throw responseError("list_groups");
          return requiredString(group, "name", "list_groups");
        });
      },
      path: "api/v1beta/groups",
      ...(signal ? { signal } : {})
    });
  }

  async createGroup(name: string, signal?: AbortSignal): Promise<void> {
    validateApiName(name, "create_group");
    await this.#request({
      body: { name },
      expectedStatuses: [201],
      method: "POST",
      operation: "create_group",
      parse(value) {
        if (!isRecord(value) || requiredString(value, "name", "create_group") !== name) {
          throw responseError("create_group");
        }
      },
      path: "api/v1beta/groups",
      ...(signal ? { signal } : {})
    });
  }

  async ensureGroup(name: string, signal?: AbortSignal): Promise<void> {
    if ((await this.listGroups(signal)).includes(name)) return;
    try {
      await this.createGroup(name, signal);
    } catch (error) {
      if (!(error instanceof ToolHiveClientError) || error.status !== 409) throw error;
      if (!(await this.listGroups(signal)).includes(name)) throw error;
    }
  }

  async deleteGroup(
    name: string,
    input: { signal?: AbortSignal; withWorkloads?: boolean } = {}
  ): Promise<void> {
    validateApiName(name, "delete_group");
    const query = input.withWorkloads ? "?with-workloads=true" : "";
    try {
      await this.#request({
        expectedStatuses: [204],
        longRunning: input.withWorkloads,
        method: "DELETE",
        operation: "delete_group",
        path: `api/v1beta/groups/${encodeURIComponent(name)}${query}`,
        ...(input.signal ? { signal: input.signal } : {})
      });
    } catch (error) {
      if (!(error instanceof ToolHiveClientError) || error.status !== 404) throw error;
    }
  }

  async listWorkloads(input: {
    group?: string;
    signal?: AbortSignal;
  } = {}): Promise<readonly ToolHiveWorkloadSummary[]> {
    if (input.group) validateApiName(input.group, "list_workloads");
    const query = new URLSearchParams({ all: "true" });
    if (input.group) query.set("group", input.group);
    try {
      return await this.#request({
        expectedStatuses: [200],
        method: "GET",
        operation: "list_workloads",
        parse(value) {
          if (!isRecord(value)) throw responseError("list_workloads");
          if (value.workloads === null) return [];
          if (!Array.isArray(value.workloads)) throw responseError("list_workloads");
          return value.workloads.map(parseWorkloadSummary);
        },
        path: `api/v1beta/workloads?${query.toString()}`,
        ...(input.signal ? { signal: input.signal } : {})
      });
    } catch (error) {
      // ToolHive returns 404 when a group has never been created. For a scoped
      // list this is the same observable state as an empty collection and lets
      // dry-run cleanup remain useful on fresh or already-clean installations.
      if (input.group && error instanceof ToolHiveClientError && error.status === 404) return [];
      throw error;
    }
  }

  async createLocalWorkload(
    request: ToolHiveLocalWorkloadRequest,
    signal?: AbortSignal
  ): Promise<Readonly<{ name: string; port: number }>> {
    const input = validateLocalRequest(request);
    return this.#request({
      body: {
        cmd_arguments: input.cmdArguments,
        env_vars: input.envVars,
        group: input.group,
        host: "0.0.0.0",
        image: input.image,
        name: input.name,
        network_isolation: false,
        proxy_mode: "streamable-http",
        proxy_port: 0,
        transport: "stdio"
      },
      expectedStatuses: [201],
      ...(TOOLHIVE_GENERATED_IMAGE.test(input.image) ? {
        classifyHttpError: (body: string) =>
          MISSING_IMAGE_ERROR.test(body)
            ? "toolhive_artifact_missing" as const
            : null
      } : {}),
      longRunning: true,
      method: "POST",
      operation: "create_workload",
      parse(value) {
        if (!isRecord(value)) throw responseError("create_workload");
        const name = requiredString(value, "name", "create_workload");
        if (name !== input.name) throw responseError("create_workload");
        return { name, port: requiredPort(value, "port", "create_workload") };
      },
      path: "api/v1beta/workloads",
      ...(signal ? { signal } : {})
    });
  }

  async getWorkload(name: string, signal?: AbortSignal): Promise<ToolHiveWorkloadDetail> {
    validateApiName(name, "get_workload");
    return this.#request({
      expectedStatuses: [200],
      method: "GET",
      operation: "get_workload",
      parse: parseWorkloadDetail,
      path: `api/v1beta/workloads/${encodeURIComponent(name)}`,
      ...(signal ? { signal } : {})
    });
  }

  /**
   * Sensitive, untrusted workload output. Callers must classify or redact this
   * bounded text before it crosses an application response or logging boundary.
   */
  async getWorkloadLogs(name: string, signal?: AbortSignal): Promise<string> {
    validateApiName(name, "get_workload_logs");
    return this.#request({
      expectedStatuses: [200],
      maxResponseBytes: MAX_WORKLOAD_LOG_BYTES,
      method: "GET",
      operation: "get_workload_logs",
      parseText: (value) => value,
      path: `api/v1beta/workloads/${encodeURIComponent(name)}/logs`,
      ...(signal ? { signal } : {})
    });
  }

  async getWorkloadStatus(
    name: string,
    signal?: AbortSignal
  ): Promise<ToolHiveWorkloadStatus> {
    validateApiName(name, "get_workload_status");
    return this.#request({
      expectedStatuses: [200],
      method: "GET",
      operation: "get_workload_status",
      parse(value) {
        if (!isRecord(value)) throw responseError("get_workload_status");
        return parseWorkloadStatus(value.status, "get_workload_status");
      },
      path: `api/v1beta/workloads/${encodeURIComponent(name)}/status`,
      ...(signal ? { signal } : {})
    });
  }

  async findWorkloadStatus(
    name: string,
    signal?: AbortSignal
  ): Promise<ToolHiveWorkloadStatus | null> {
    try {
      return await this.getWorkloadStatus(name, signal);
    } catch (error) {
      if (error instanceof ToolHiveClientError && error.status === 404) return null;
      throw error;
    }
  }

  restartWorkload(
    name: string,
    input: { expectedImage?: string; signal?: AbortSignal } = {}
  ): Promise<void> {
    return this.#workloadAction(name, "restart", input.signal, input.expectedImage);
  }

  stopWorkload(name: string, signal?: AbortSignal): Promise<void> {
    return this.#workloadAction(name, "stop", signal);
  }

  async deleteWorkload(name: string, signal?: AbortSignal): Promise<void> {
    validateApiName(name, "delete_workload");
    try {
      await this.#request({
        expectedStatuses: [202],
        method: "DELETE",
        operation: "delete_workload",
        path: `api/v1beta/workloads/${encodeURIComponent(name)}`,
        ...(signal ? { signal } : {})
      });
    } catch (error) {
      if (!(error instanceof ToolHiveClientError) || error.status !== 404) throw error;
    }
  }

  normalizeStdioProxyUrl(workload: ToolHiveWorkloadSummary): string {
    const operation = "normalize_proxy_url";
    let reported: URL;
    try {
      reported = new URL(workload.url);
    } catch {
      throw responseError(operation);
    }
    const reportedPort = Number(reported.port);
    if (
      workload.remote ||
      workload.transportType !== "stdio" ||
      workload.proxyMode !== "streamable-http" ||
      reported.protocol !== "http:" ||
      !["127.0.0.1", "localhost", "[::1]"].includes(reported.hostname) ||
      reported.username ||
      reported.password ||
      reported.pathname !== "/mcp" ||
      reported.search ||
      reported.hash ||
      !positiveInteger(reportedPort) ||
      reportedPort !== workload.port
    ) {
      throw responseError(operation);
    }

    const normalized = new URL(reported);
    normalized.hostname = this.#baseUrl.hostname;
    return normalized.toString();
  }

  async #workloadAction(
    name: string,
    action: "restart" | "stop",
    signal?: AbortSignal,
    expectedImage?: string
  ): Promise<void> {
    const operation = `${action}_workload`;
    validateApiName(name, operation);
    await this.#request({
      expectedStatuses: [202],
      ...(action === "restart" && expectedImage && TOOLHIVE_GENERATED_IMAGE.test(expectedImage)
        ? {
            classifyHttpError: (body: string) => MISSING_IMAGE_ERROR.test(body)
              ? "toolhive_artifact_missing" as const
              : null
          }
        : {}),
      method: "POST",
      operation,
      path: `api/v1beta/workloads/${encodeURIComponent(name)}/${action}`,
      ...(signal ? { signal } : {})
    });
  }

  async #request<Result = void>(input: RequestOptions<Result>): Promise<Result> {
    const maxResponseBytes = Math.min(
      input.maxResponseBytes ?? this.#maxResponseBytes,
      this.#maxResponseBytes
    );
    let body: string | undefined;
    if (typeof input.body !== "undefined") {
      body = JSON.stringify(input.body);
      if (Buffer.byteLength(body, "utf8") > this.#maxRequestBytes) {
        throw new ToolHiveClientError({
          code: "toolhive_request_too_large",
          operation: input.operation
        });
      }
    }

    const timeoutController = new AbortController();
    let timedOut = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      timeoutController.abort();
    }, input.longRunning ? this.#longRequestTimeoutMs : this.#requestTimeoutMs);
    timeout.unref?.();
    const signal = input.signal
      ? AbortSignal.any([input.signal, timeoutController.signal])
      : timeoutController.signal;
    let response: Response;
    try {
      response = await this.#fetch(new URL(input.path, this.#baseUrl), {
        ...(body ? {
          body,
          headers: {
            accept: "application/json",
            "content-type": "application/json"
          }
        } : { headers: { accept: "application/json" } }),
        cache: "no-store",
        method: input.method,
        redirect: "error",
        signal
      });
    } catch {
      clearTimeout(timeout);
      throw new ToolHiveClientError({
        code: timedOut
          ? "toolhive_request_timed_out"
          : input.signal?.aborted
            ? "toolhive_request_aborted"
            : "toolhive_request_failed",
        operation: input.operation
      });
    }

    try {
      if (!input.expectedStatuses.includes(response.status)) {
        let errorBody = "";
        try {
          errorBody = await readBoundedText(response, {
            maxBytes: maxResponseBytes,
            operation: input.operation,
            signal
          });
        } catch {
          // ToolHive error bodies may contain workload configuration. Discard them.
        }
        throw new ToolHiveClientError({
          code: input.classifyHttpError?.(errorBody, response.status) ?? "toolhive_http_error",
          operation: input.operation,
          status: response.status
        });
      }

      const text = await readBoundedText(response, {
        maxBytes: maxResponseBytes,
        operation: input.operation,
        signal
      });
      if (input.parseText) return input.parseText(text);
      if (!input.parse) return undefined as Result;
      let value: unknown;
      try {
        value = JSON.parse(text);
      } catch {
        throw responseError(input.operation);
      }
      return input.parse(value);
    } catch (error) {
      if (error instanceof ToolHiveClientError) throw error;
      throw new ToolHiveClientError({
        code: signal.aborted
          ? timedOut
            ? "toolhive_request_timed_out"
            : "toolhive_request_aborted"
          : "toolhive_response_invalid",
        operation: input.operation
      });
    } finally {
      clearTimeout(timeout);
    }
  }
}
