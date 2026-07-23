import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { OAuthClientProvider } from "@modelcontextprotocol/sdk/client/auth.js";
import type { RequestOptions } from "@modelcontextprotocol/sdk/shared/protocol.js";
import type { FetchLike } from "@modelcontextprotocol/sdk/shared/transport.js";
import { AjvJsonSchemaValidator } from "@modelcontextprotocol/sdk/validation/ajv";
import type { JsonSchemaType, JsonSchemaValidator } from "@modelcontextprotocol/sdk/validation";
import {
  ErrorCode,
  McpError,
  type Implementation,
  type ServerCapabilities
} from "@modelcontextprotocol/sdk/types.js";
import { canonicalMcpJson, hashCanonicalMcpValue } from "./definitions";

type SessionOperation = "call_tool" | "close" | "initialize" | "list_tools" | "session";

export type McpClientSessionErrorCode =
  | "mcp_call_arguments_invalid"
  | "mcp_call_arguments_too_large"
  | "mcp_call_failed"
  | "mcp_call_result_invalid"
  | "mcp_call_result_too_large"
  | "mcp_call_result_unsupported"
  | "mcp_initialize_failed"
  | "mcp_inventory_cursor_cycle"
  | "mcp_inventory_page_limit"
  | "mcp_inventory_metadata_limit"
  | "mcp_inventory_schema_limit"
  | "mcp_inventory_secret_exposed"
  | "mcp_inventory_tool_invalid"
  | "mcp_inventory_tool_limit"
  | "mcp_list_tools_failed"
  | "mcp_request_cancelled"
  | "mcp_request_timeout"
  | "mcp_session_closed"
  | "mcp_session_configuration_invalid"
  | "mcp_session_not_ready";

const ERROR_MESSAGES: Record<McpClientSessionErrorCode, string> = {
  mcp_call_arguments_invalid: "MCP tool arguments are invalid or do not match the snapshotted input schema.",
  mcp_call_arguments_too_large: "MCP tool arguments exceed the configured byte limit.",
  mcp_call_failed: "The MCP tool call failed.",
  mcp_call_result_invalid: "The MCP tool returned an invalid result.",
  mcp_call_result_too_large: "The MCP tool result exceeds the configured byte limit.",
  mcp_call_result_unsupported: "The MCP tool result contains no supported content.",
  mcp_initialize_failed: "The MCP session could not be initialized.",
  mcp_inventory_cursor_cycle: "The MCP tool inventory repeated a pagination cursor.",
  mcp_inventory_metadata_limit: "MCP tool metadata exceeds the configured byte limit.",
  mcp_inventory_page_limit: "The MCP tool inventory exceeds the configured page limit.",
  mcp_inventory_schema_limit: "An MCP tool schema exceeds the configured byte limit.",
  mcp_inventory_secret_exposed: "The MCP tool inventory contains an exact known credential.",
  mcp_inventory_tool_invalid: "The MCP tool inventory contains an invalid tool definition.",
  mcp_inventory_tool_limit: "The MCP tool inventory exceeds the configured tool limit.",
  mcp_list_tools_failed: "The MCP tool inventory could not be loaded.",
  mcp_request_cancelled: "The MCP request was cancelled.",
  mcp_request_timeout: "The MCP request timed out.",
  mcp_session_closed: "The MCP session is closed.",
  mcp_session_configuration_invalid: "The MCP session configuration is invalid.",
  mcp_session_not_ready: "The MCP session is not initialized."
};

export class McpClientSessionError extends Error {
  readonly code: McpClientSessionErrorCode;
  readonly operation: SessionOperation;
  readonly retryable: boolean;

  constructor(input: Readonly<{
    code: McpClientSessionErrorCode;
    operation: SessionOperation;
    retryable?: boolean;
  }>) {
    super(ERROR_MESSAGES[input.code]);
    this.name = "McpClientSessionError";
    this.code = input.code;
    this.operation = input.operation;
    this.retryable = input.retryable ?? false;
  }

  toJSON(): Readonly<{
    code: McpClientSessionErrorCode;
    message: string;
    operation: SessionOperation;
    retryable: boolean;
  }> {
    return {
      code: this.code,
      message: this.message,
      operation: this.operation,
      retryable: this.retryable
    };
  }
}

export type AiqsaMcpToolDefinition = Readonly<{
  annotations?: Readonly<{
    destructiveHint?: boolean;
    idempotentHint?: boolean;
    openWorldHint?: boolean;
    readOnlyHint?: boolean;
    title?: string;
  }>;
  definitionHash: string;
  description: string | null;
  inputSchema: Readonly<Record<string, unknown>>;
  name: string;
  outputSchema?: Readonly<Record<string, unknown>>;
  title?: string;
}>;

export type AiqsaMcpServerEvidence = Readonly<{
  capabilities: Readonly<{
    completions: boolean;
    logging: boolean;
    prompts: Readonly<{ listChanged: boolean }> | null;
    resources: Readonly<{ listChanged: boolean; subscribe: boolean }> | null;
    tasks: boolean;
    tools: Readonly<{ listChanged: boolean }> | null;
  }>;
  implementation: Readonly<{
    name: string;
    title?: string;
    version: string;
  }>;
}>;

export type AiqsaMcpToolCallResult = Readonly<{
  isError: boolean;
  structuredContent: Readonly<Record<string, unknown>> | null;
  text: readonly string[];
  unsupportedContentTypes: readonly string[];
}>;

export type McpClientSessionLimits = Readonly<{
  maxListPages: number;
  maxToolArgumentBytes: number;
  maxToolMetadataBytes: number;
  maxToolResultBytes: number;
  maxToolSchemaBytes: number;
  maxTools: number;
}>;

export type McpClientRequestOptions = Readonly<{
  signal?: AbortSignal;
  timeoutMs?: number;
}>;

export type McpClientSessionOptions = Readonly<{
  authProvider?: OAuthClientProvider;
  fetch: FetchLike;
  headers?: Readonly<Record<string, string>>;
  limits: McpClientSessionLimits;
  onInventoryStale?: () => void;
  requestTimeoutMs: number;
  url: URL;
}>;

type SessionState = "closed" | "initializing" | "new" | "ready";

const TOOL_NAME_PATTERN = /^[A-Za-z0-9_.-]{1,128}$/u;
const MAX_SERVER_EVIDENCE_BYTES = 16 * 1_024;
const SDK_OWNED_HEADERS = new Set([
  "accept",
  "content-type",
  "last-event-id",
  "mcp-protocol-version",
  "mcp-session-id"
]);

function positiveInteger(value: number): boolean {
  return Number.isInteger(value) && value > 0;
}

function sessionError(
  code: McpClientSessionErrorCode,
  operation: SessionOperation,
  retryable = false
): McpClientSessionError {
  return new McpClientSessionError({ code, operation, retryable });
}

function requestFailure(
  error: unknown,
  operation: Exclude<SessionOperation, "close" | "session">,
  signal: AbortSignal | undefined,
  fallbackCode: McpClientSessionErrorCode
): McpClientSessionError {
  if (error instanceof McpClientSessionError) {
    return error;
  }
  if (signal?.aborted) {
    return sessionError("mcp_request_cancelled", operation);
  }
  if (error instanceof McpError && error.code === ErrorCode.RequestTimeout) {
    return sessionError("mcp_request_timeout", operation, true);
  }
  return sessionError(fallbackCode, operation, true);
}

function validateOptions(options: McpClientSessionOptions): void {
  const url = options.url;
  if (
    !(url instanceof URL) ||
    !["http:", "https:"].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.hash ||
    !positiveInteger(options.requestTimeoutMs) ||
    !positiveInteger(options.limits.maxListPages) ||
    !positiveInteger(options.limits.maxToolArgumentBytes) ||
    !positiveInteger(options.limits.maxToolMetadataBytes) ||
    !positiveInteger(options.limits.maxToolResultBytes) ||
    !positiveInteger(options.limits.maxToolSchemaBytes) ||
    !positiveInteger(options.limits.maxTools)
  ) {
    throw sessionError("mcp_session_configuration_invalid", "session");
  }

  try {
    const headers = new Headers(options.headers);
    for (const name of headers.keys()) {
      if (SDK_OWNED_HEADERS.has(name.toLowerCase())) {
        throw sessionError("mcp_session_configuration_invalid", "session");
      }
    }
  } catch (error) {
    if (error instanceof McpClientSessionError) throw error;
    throw sessionError("mcp_session_configuration_invalid", "session");
  }
}

function requestOptions(
  operation: Exclude<SessionOperation, "close" | "session">,
  defaultTimeoutMs: number,
  options?: McpClientRequestOptions
): RequestOptions {
  const timeout = options?.timeoutMs ?? defaultTimeoutMs;
  if (!positiveInteger(timeout)) {
    throw sessionError("mcp_session_configuration_invalid", operation);
  }
  if (options?.signal?.aborted) {
    throw sessionError("mcp_request_cancelled", operation);
  }
  return {
    signal: options?.signal,
    timeout
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isCallResultValue(value: unknown): value is Readonly<{
  content: readonly Readonly<{ type: string; text?: string }>[];
  isError?: boolean;
  structuredContent?: Record<string, unknown>;
}> {
  if (!isRecord(value) || !Array.isArray(value.content)) return false;
  if (value.isError !== undefined && typeof value.isError !== "boolean") return false;
  if (value.structuredContent !== undefined && !isRecord(value.structuredContent)) return false;
  return value.content.every((item) => isRecord(item) && typeof item.type === "string");
}

function jsonSnapshot(
  value: unknown,
  invalidCode: McpClientSessionErrorCode,
  operation: SessionOperation
): Readonly<{ bytes: number; value: unknown }> {
  try {
    const json = JSON.stringify(value);
    if (json === undefined) {
      throw new Error("not_json");
    }
    return {
      bytes: Buffer.byteLength(json, "utf8"),
      value: JSON.parse(json) as unknown
    };
  } catch {
    throw sessionError(invalidCode, operation);
  }
}

function canonicalSchema(inputSchema: Record<string, unknown>): Readonly<{
  bytes: number;
  value: Readonly<Record<string, unknown>>;
}> {
  try {
    const json = canonicalMcpJson(inputSchema);
    const value = JSON.parse(json) as unknown;
    if (!isRecord(value)) {
      throw new Error("invalid_schema");
    }
    schemaValidator(value);
    return {
      bytes: Buffer.byteLength(json, "utf8"),
      value
    };
  } catch {
    throw sessionError("mcp_inventory_tool_invalid", "list_tools");
  }
}

const MAX_CACHED_SCHEMA_VALIDATORS = 256;
const schemaValidators = new Map<string, JsonSchemaValidator<unknown>>();

function schemaValidator(schema: Readonly<Record<string, unknown>>): JsonSchemaValidator<unknown> {
  const key = canonicalMcpJson(schema);
  const cached = schemaValidators.get(key);
  if (cached) return cached;

  // Use the validator shipped with the pinned official MCP SDK. A separate
  // provider instance avoids cross-server $id collisions while keeping the
  // cache bounded by the already bounded discovery schemas.
  const validator = new AjvJsonSchemaValidator().getValidator<unknown>(schema as JsonSchemaType);
  if (schemaValidators.size >= MAX_CACHED_SCHEMA_VALIDATORS) {
    const oldest = schemaValidators.keys().next().value;
    if (oldest !== undefined) schemaValidators.delete(oldest);
  }
  schemaValidators.set(key, validator);
  return validator;
}

export function validateMcpToolArguments(
  inputSchema: Readonly<Record<string, unknown>>,
  toolArguments: Readonly<Record<string, unknown>>
): void {
  try {
    if (!schemaValidator(inputSchema)(toolArguments).valid) {
      throw sessionError("mcp_call_arguments_invalid", "call_tool");
    }
  } catch (error) {
    if (error instanceof McpClientSessionError) throw error;
    throw sessionError("mcp_call_arguments_invalid", "call_tool");
  }
}

function normalizeAnnotations(annotations: Readonly<{
  destructiveHint?: boolean;
  idempotentHint?: boolean;
  openWorldHint?: boolean;
  readOnlyHint?: boolean;
  title?: string;
}> | undefined): AiqsaMcpToolDefinition["annotations"] {
  if (!annotations) return undefined;
  const normalized = {
    ...(annotations.destructiveHint !== undefined
      ? { destructiveHint: annotations.destructiveHint }
      : {}),
    ...(annotations.idempotentHint !== undefined
      ? { idempotentHint: annotations.idempotentHint }
      : {}),
    ...(annotations.openWorldHint !== undefined
      ? { openWorldHint: annotations.openWorldHint }
      : {}),
    ...(annotations.readOnlyHint !== undefined
      ? { readOnlyHint: annotations.readOnlyHint }
      : {}),
    ...(annotations.title !== undefined ? { title: annotations.title } : {})
  };
  return Object.keys(normalized).length > 0 ? normalized : undefined;
}

function normalizeServerEvidence(
  implementation: Implementation | undefined,
  capabilities: ServerCapabilities | undefined
): AiqsaMcpServerEvidence {
  if (!implementation || !capabilities || !implementation.name || !implementation.version) {
    throw sessionError("mcp_initialize_failed", "initialize");
  }
  const evidence: AiqsaMcpServerEvidence = {
    capabilities: {
      completions: capabilities.completions !== undefined,
      logging: capabilities.logging !== undefined,
      prompts: capabilities.prompts
        ? { listChanged: capabilities.prompts.listChanged === true }
        : null,
      resources: capabilities.resources
        ? {
            listChanged: capabilities.resources.listChanged === true,
            subscribe: capabilities.resources.subscribe === true
          }
        : null,
      tasks: capabilities.tasks !== undefined,
      tools: capabilities.tools
        ? { listChanged: capabilities.tools.listChanged === true }
        : null
    },
    implementation: {
      name: implementation.name,
      ...(implementation.title !== undefined ? { title: implementation.title } : {}),
      version: implementation.version
    }
  };
  if (Buffer.byteLength(canonicalMcpJson(evidence), "utf8") > MAX_SERVER_EVIDENCE_BYTES) {
    throw sessionError("mcp_initialize_failed", "initialize");
  }
  return evidence;
}

function normalizeTool(
  tool: Readonly<{
    annotations?: Readonly<{
      destructiveHint?: boolean;
      idempotentHint?: boolean;
      openWorldHint?: boolean;
      readOnlyHint?: boolean;
      title?: string;
    }>;
    description?: string;
    inputSchema: Record<string, unknown>;
    name: string;
    outputSchema?: Record<string, unknown>;
    title?: string;
  }>,
  limits: Pick<McpClientSessionLimits, "maxToolMetadataBytes" | "maxToolSchemaBytes">
): AiqsaMcpToolDefinition {
  if (
    !TOOL_NAME_PATTERN.test(tool.name) ||
    (tool.description !== undefined && typeof tool.description !== "string") ||
    (tool.title !== undefined && typeof tool.title !== "string")
  ) {
    throw sessionError("mcp_inventory_tool_invalid", "list_tools");
  }
  const inputSchema = canonicalSchema(tool.inputSchema);
  const outputSchema = tool.outputSchema ? canonicalSchema(tool.outputSchema) : null;
  if (inputSchema.bytes + (outputSchema?.bytes ?? 0) > limits.maxToolSchemaBytes) {
    throw sessionError("mcp_inventory_schema_limit", "list_tools");
  }

  const annotations = normalizeAnnotations(tool.annotations);
  const metadata = {
    ...(annotations ? { annotations } : {}),
    description: tool.description ?? null,
    ...(tool.title !== undefined ? { title: tool.title } : {})
  };
  if (Buffer.byteLength(canonicalMcpJson(metadata), "utf8") > limits.maxToolMetadataBytes) {
    throw sessionError("mcp_inventory_metadata_limit", "list_tools");
  }

  const definition = {
    ...metadata,
    inputSchema: inputSchema.value,
    name: tool.name,
    ...(outputSchema ? { outputSchema: outputSchema.value } : {})
  };
  return {
    ...definition,
    definitionHash: hashCanonicalMcpValue(definition)
  };
}

function normalizeCallResult(
  result: Readonly<{
    content: readonly Readonly<{ type: string; text?: string }>[];
    isError?: boolean;
    structuredContent?: Record<string, unknown>;
  }>
): AiqsaMcpToolCallResult {
  const text: string[] = [];
  const unsupportedContentTypes: string[] = [];
  for (const item of result.content) {
    if (item.type === "text" && typeof item.text === "string") {
      text.push(item.text);
    } else {
      unsupportedContentTypes.push(item.type);
    }
  }

  let structuredContent: Readonly<Record<string, unknown>> | null = null;
  if (result.structuredContent !== undefined) {
    const snapshot = jsonSnapshot(result.structuredContent, "mcp_call_result_invalid", "call_tool").value;
    if (!isRecord(snapshot)) {
      throw sessionError("mcp_call_result_invalid", "call_tool");
    }
    structuredContent = snapshot;
  }

  if (unsupportedContentTypes.length > 0 && text.length === 0 && structuredContent === null) {
    throw sessionError("mcp_call_result_unsupported", "call_tool");
  }

  return {
    isError: result.isError === true,
    structuredContent,
    text,
    unsupportedContentTypes
  };
}

export class McpClientSession {
  private readonly client: Client;
  private readonly defaultRequestTimeoutMs: number;
  private initializePromise: Promise<void> | null = null;
  private inventoryChangeVersion = 0;
  private inventoryStaleValue = true;
  private readonly limits: McpClientSessionLimits;
  private readonly onInventoryStale: (() => void) | undefined;
  private serverEvidenceValue: AiqsaMcpServerEvidence | null = null;
  private state: SessionState = "new";

  constructor(options: McpClientSessionOptions) {
    validateOptions(options);
    this.defaultRequestTimeoutMs = options.requestTimeoutMs;
    this.limits = options.limits;
    this.onInventoryStale = options.onInventoryStale;
    const staticHeaders = new Headers(options.headers);
    const transport = new StreamableHTTPClientTransport(new URL(options.url.toString()), {
      ...(options.authProvider ? { authProvider: options.authProvider } : {}),
      fetch: options.fetch,
      requestInit: { headers: staticHeaders }
    });
    this.client = new Client(
      { name: "aiqsa", version: "0.1.0" },
      {
        capabilities: {},
        listChanged: {
          tools: {
            autoRefresh: false,
            debounceMs: 0,
            onChanged: () => this.markInventoryStale()
          }
        }
      }
    );
    this.transport = transport;
  }

  private readonly transport: StreamableHTTPClientTransport;

  get inventoryStale(): boolean {
    return this.inventoryStaleValue;
  }

  get serverEvidence(): AiqsaMcpServerEvidence | null {
    return this.serverEvidenceValue;
  }

  private markInventoryStale(): void {
    this.inventoryChangeVersion += 1;
    this.inventoryStaleValue = true;
    try {
      this.onInventoryStale?.();
    } catch {
      // Inventory state must not depend on a scheduling callback succeeding.
    }
  }

  private requireReady(operation: "call_tool" | "list_tools"): void {
    if (this.state === "closed") {
      throw sessionError("mcp_session_closed", operation);
    }
    if (this.state !== "ready") {
      throw sessionError("mcp_session_not_ready", operation);
    }
  }

  async initialize(options?: McpClientRequestOptions): Promise<void> {
    if (this.state === "ready") return;
    if (this.state === "closed") {
      throw sessionError("mcp_session_closed", "initialize");
    }
    if (this.initializePromise) {
      return this.initializePromise;
    }

    const sdkOptions = requestOptions("initialize", this.defaultRequestTimeoutMs, options);
    this.state = "initializing";
    this.initializePromise = (async () => {
      try {
        await this.client.connect(this.transport, sdkOptions);
        if (this.state === "closed") {
          throw sessionError("mcp_session_closed", "initialize");
        }
        this.serverEvidenceValue = normalizeServerEvidence(
          this.client.getServerVersion(),
          this.client.getServerCapabilities()
        );
        this.state = "ready";
      } catch (error) {
        this.state = "closed";
        await this.client.close().catch(() => undefined);
        throw requestFailure(
          error,
          "initialize",
          options?.signal,
          "mcp_initialize_failed"
        );
      }
    })();
    return this.initializePromise;
  }

  async close(): Promise<void> {
    if (this.state === "closed") return;
    this.state = "closed";
    this.inventoryStaleValue = true;
    try {
      await this.client.close();
    } catch {
      // The SDK transport is already locally aborted; close stays idempotent.
    }
  }

  async listAllTools(options?: McpClientRequestOptions): Promise<readonly AiqsaMcpToolDefinition[]> {
    this.requireReady("list_tools");
    const sdkOptions = requestOptions("list_tools", this.defaultRequestTimeoutMs, options);
    const refreshVersion = this.inventoryChangeVersion;
    const tools: AiqsaMcpToolDefinition[] = [];
    const names = new Set<string>();
    const cursors = new Set<string>();
    let cursor: string | undefined;
    let page = 0;

    try {
      while (true) {
        if (page >= this.limits.maxListPages) {
          throw sessionError("mcp_inventory_page_limit", "list_tools");
        }
        page += 1;
        const result = await this.client.listTools(
          cursor === undefined ? undefined : { cursor },
          sdkOptions
        );
        if (tools.length + result.tools.length > this.limits.maxTools) {
          throw sessionError("mcp_inventory_tool_limit", "list_tools");
        }

        for (const tool of result.tools) {
          if (names.has(tool.name)) {
            throw sessionError("mcp_inventory_tool_invalid", "list_tools");
          }
          const normalized = normalizeTool(tool, this.limits);
          names.add(normalized.name);
          tools.push(normalized);
        }

        if (result.nextCursor === undefined) break;
        if (cursors.has(result.nextCursor)) {
          throw sessionError("mcp_inventory_cursor_cycle", "list_tools");
        }
        cursors.add(result.nextCursor);
        cursor = result.nextCursor;
      }
    } catch (error) {
      this.inventoryStaleValue = true;
      throw requestFailure(
        error,
        "list_tools",
        options?.signal,
        "mcp_list_tools_failed"
      );
    }

    if (this.inventoryChangeVersion === refreshVersion) {
      this.inventoryStaleValue = false;
    }
    return tools;
  }

  async callTool(
    name: string,
    toolArguments: Readonly<Record<string, unknown>>,
    options?: McpClientRequestOptions
  ): Promise<AiqsaMcpToolCallResult> {
    this.requireReady("call_tool");
    const sdkOptions = requestOptions("call_tool", this.defaultRequestTimeoutMs, options);
    if (!TOOL_NAME_PATTERN.test(name) || !isRecord(toolArguments)) {
      throw sessionError("mcp_call_arguments_invalid", "call_tool");
    }
    const argumentSnapshot = jsonSnapshot(
      toolArguments,
      "mcp_call_arguments_invalid",
      "call_tool"
    );
    if (argumentSnapshot.bytes > this.limits.maxToolArgumentBytes || !isRecord(argumentSnapshot.value)) {
      if (!isRecord(argumentSnapshot.value)) {
        throw sessionError("mcp_call_arguments_invalid", "call_tool");
      }
      throw sessionError("mcp_call_arguments_too_large", "call_tool");
    }

    try {
      const result = await this.client.callTool(
        { arguments: argumentSnapshot.value, name },
        undefined,
        sdkOptions
      );
      const resultSnapshot = jsonSnapshot(result, "mcp_call_result_invalid", "call_tool");
      if (resultSnapshot.bytes > this.limits.maxToolResultBytes) {
        throw sessionError("mcp_call_result_too_large", "call_tool");
      }
      if (!isCallResultValue(resultSnapshot.value)) {
        throw sessionError("mcp_call_result_invalid", "call_tool");
      }
      return normalizeCallResult(resultSnapshot.value);
    } catch (error) {
      throw requestFailure(error, "call_tool", options?.signal, "mcp_call_failed");
    }
  }
}
