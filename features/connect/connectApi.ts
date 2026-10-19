import { shellFetch } from "@/components/app-shell/shellApi";
import {
  CONNECT_DEVICES_PATH,
  CONNECT_VIEWS_PATH,
  connectDevicePath,
  connectDeviceSessionPath,
  connectDeviceSessionsPath,
  connectPairingByCodePath,
  connectRecentDirsPath,
  connectSessionHistoryPath,
  connectSessionOptionsPath,
  connectViewInputPath,
  connectViewPath,
  connectViewResizePath,
  connectViewVisibilityPath,
  decodeConnectDevicesResponse,
  decodeConnectErrorResponse,
  decodeConnectPairingDecisionResponse,
  decodeConnectPairingLookupResponse,
  decodeConnectRecentDirsResponse,
  decodeConnectSessionCreateResponse,
  decodeConnectSessionHistoryResponse,
  decodeConnectSessionOptionsResponse,
  decodeConnectViewCreateResponse,
  type ConnectDevicesResponse,
  type ConnectPairingDecision,
  type ConnectPairingDecisionResponse,
  type ConnectPairingLookupResponse,
  type ConnectReasonCode,
  type ConnectRecentDirsResponse,
  type ConnectSessionCreateRequest,
  type ConnectSessionCreateResponse,
  type ConnectSessionHistoryResponse,
  type ConnectSessionOptionsResponse,
  type ConnectViewCreateRequest,
  type ConnectViewCreateResponse
} from "@/lib/contracts/connect";

/** A refusal's reason code, or a browser-side failure that never reached a decoded answer. */
export type ConnectFailureCode = ConnectReasonCode | "network_error" | "response_invalid";

export type ConnectApiFailure = Readonly<{
  code: ConnectFailureCode;
  ok: false;
  /** From `retry-after` on `connect_rate_limited`, bounded to one minute. */
  retryAfterSeconds?: number;
}>;

export type ConnectApiResult<T> = Readonly<{ data: T; ok: true }> | ConnectApiFailure;

type Decoder<T> = (value: unknown) => T | null;

const MAX_RETRY_AFTER_SECONDS = 60;

function retryAfterSeconds(response: Response): number | undefined {
  const value = Number.parseInt(response.headers.get("retry-after") ?? "", 10);
  return Number.isFinite(value) && value > 0 ? Math.min(value, MAX_RETRY_AFTER_SECONDS) : undefined;
}

async function readJson(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return null;
  }
}

/**
 * One browser request to `/api/connect`. A refusal is decided by its `{code}`
 * body; 401 always means signed out (`shellFetch` also tells the shell).
 * `decode` null accepts any 2xx without reading the body.
 */
async function connectRequest<T>(
  path: string,
  init: RequestInit,
  decode: Decoder<T> | null
): Promise<ConnectApiResult<T>> {
  let response: Response;
  try {
    response = await shellFetch(path, {
      cache: "no-store",
      credentials: "same-origin",
      ...init,
      headers: {
        accept: "application/json",
        ...(init.body !== undefined ? { "content-type": "application/json" } : {}),
        ...init.headers
      }
    });
  } catch {
    return { code: "network_error", ok: false };
  }
  if (response.status === 401) return { code: "connect_unauthorized", ok: false };
  if (!response.ok) {
    const refusal = decodeConnectErrorResponse(await readJson(response));
    const code: ConnectFailureCode = refusal?.code ?? "response_invalid";
    const retryAfter = code === "connect_rate_limited" ? retryAfterSeconds(response) : undefined;
    return retryAfter === undefined ? { code, ok: false } : { code, ok: false, retryAfterSeconds: retryAfter };
  }
  if (!decode) return { data: undefined as T, ok: true };
  const data = decode(await readJson(response));
  return data === null ? { code: "response_invalid", ok: false } : { data, ok: true };
}

function jsonBody(value: unknown): Pick<RequestInit, "body" | "method"> {
  return { body: JSON.stringify(value), method: "POST" };
}

export function listConnectDevices(signal?: AbortSignal): Promise<ConnectApiResult<ConnectDevicesResponse>> {
  return connectRequest(CONNECT_DEVICES_PATH, signal ? { signal } : {}, decodeConnectDevicesResponse);
}

export function revokeConnectDevice(deviceId: string): Promise<ConnectApiResult<void>> {
  return connectRequest(connectDevicePath(deviceId), { method: "DELETE" }, null);
}

export function createConnectSession(
  deviceId: string,
  request: ConnectSessionCreateRequest
): Promise<ConnectApiResult<ConnectSessionCreateResponse>> {
  return connectRequest(connectDeviceSessionsPath(deviceId), jsonBody(request), decodeConnectSessionCreateResponse);
}

export function endConnectSession(deviceId: string, sessionId: string): Promise<ConnectApiResult<void>> {
  return connectRequest(connectDeviceSessionPath(deviceId, sessionId), { method: "DELETE" }, null);
}

/** The numbered choices on the session's screen, read when it needs approval; may be empty. */
export function loadConnectSessionOptions(
  deviceId: string,
  sessionId: string,
  signal?: AbortSignal
): Promise<ConnectApiResult<ConnectSessionOptionsResponse>> {
  return connectRequest(connectSessionOptionsPath(deviceId, sessionId), signal ? { signal } : {}, decodeConnectSessionOptionsResponse);
}

/** The session's recent lines as plain text. */
export function loadConnectSessionHistory(
  deviceId: string,
  sessionId: string,
  signal?: AbortSignal
): Promise<ConnectApiResult<ConnectSessionHistoryResponse>> {
  return connectRequest(connectSessionHistoryPath(deviceId, sessionId), signal ? { signal } : {}, decodeConnectSessionHistoryResponse);
}

export function loadConnectRecentDirs(
  deviceId: string,
  signal?: AbortSignal
): Promise<ConnectApiResult<ConnectRecentDirsResponse>> {
  return connectRequest(connectRecentDirsPath(deviceId), signal ? { signal } : {}, decodeConnectRecentDirsResponse);
}

export function lookupConnectPairing(
  userCode: string,
  signal?: AbortSignal
): Promise<ConnectApiResult<ConnectPairingLookupResponse>> {
  return connectRequest(connectPairingByCodePath(userCode), signal ? { signal } : {}, decodeConnectPairingLookupResponse);
}

export function decideConnectPairing(
  userCode: string,
  decision: ConnectPairingDecision
): Promise<ConnectApiResult<ConnectPairingDecisionResponse>> {
  return connectRequest(connectPairingByCodePath(userCode), jsonBody({ decision }), decodeConnectPairingDecisionResponse);
}

export function createConnectView(request: ConnectViewCreateRequest): Promise<ConnectApiResult<ConnectViewCreateResponse>> {
  return connectRequest(CONNECT_VIEWS_PATH, jsonBody(request), decodeConnectViewCreateResponse);
}

export function sendConnectViewInput(viewId: string, data: string): Promise<ConnectApiResult<void>> {
  return connectRequest(connectViewInputPath(viewId), jsonBody({ data }), null);
}

export function resizeConnectView(viewId: string, cols: number, rows: number): Promise<ConnectApiResult<void>> {
  return connectRequest(connectViewResizePath(viewId), jsonBody({ cols, rows }), null);
}

export function setConnectViewVisibility(viewId: string, visible: boolean): Promise<ConnectApiResult<void>> {
  return connectRequest(connectViewVisibilityPath(viewId), jsonBody({ visible }), null);
}

/** Survives page unload, so a closed tab releases its view at once instead of after the orphan timeout. */
export function closeConnectView(viewId: string): Promise<ConnectApiResult<void>> {
  return connectRequest(connectViewPath(viewId), { keepalive: true, method: "DELETE" }, null);
}
