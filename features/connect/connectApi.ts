import { shellFetch } from "@/components/app-shell/shellApi";
import {
  CONNECT_COMPUTERS_PATH,
  connectComputerDirsPath,
  connectComputerRecentDirsPath,
  connectComputerStatPath,
  decodeConnectComputerDirsResponse,
  decodeConnectComputerErrorResponse,
  decodeConnectComputerListResponse,
  decodeConnectComputerRecentDirsResponse,
  decodeConnectComputerStatResponse,
  type ComputerErrorCode,
  type ConnectComputerDirsResponse,
  type ConnectComputerListResponse,
  type ConnectComputerRecentDirsResponse,
  type ConnectComputerStatResponse
} from "@/lib/contracts/computer";
import {
  connectDevicePath,
  connectPairingByCodePath,
  decodeConnectPairingDecisionResponse,
  decodeConnectPairingLookupResponse,
  type ConnectPairingDecision,
  type ConnectPairingDecisionResponse,
  type ConnectPairingLookupResponse
} from "@/lib/contracts/connect";

/** A refusal's stable code, or a browser-side failure that never reached a decoded answer. */
export type ConnectFailureCode = ComputerErrorCode | "network_error" | "response_invalid";

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
    const refusal = decodeConnectComputerErrorResponse(await readJson(response));
    const code: ConnectFailureCode = refusal?.code ?? "response_invalid";
    const retryAfter = code === "connect_rate_limited" ? retryAfterSeconds(response) : undefined;
    return retryAfter === undefined ? { code, ok: false } : { code, ok: false, retryAfterSeconds: retryAfter };
  }
  if (!decode) return { data: undefined as T, ok: true };
  const data = decode(await readJson(response));
  return data === null ? { code: "response_invalid", ok: false } : { data, ok: true };
}

function signalInit(signal: AbortSignal | undefined): RequestInit {
  return signal ? { signal } : {};
}

/** The user's computers, for `/connect` and the composer's picker. */
export function listConnectComputers(signal?: AbortSignal): Promise<ConnectApiResult<ConnectComputerListResponse>> {
  return connectRequest(CONNECT_COMPUTERS_PATH, signalInit(signal), decodeConnectComputerListResponse);
}

export function revokeConnectComputer(computerId: string): Promise<ConnectApiResult<void>> {
  return connectRequest(connectDevicePath(computerId), { method: "DELETE" }, null);
}

/** The computer's home folder and the folders the agent worked in recently. */
export function loadConnectComputerRecentDirs(
  computerId: string,
  signal?: AbortSignal
): Promise<ConnectApiResult<ConnectComputerRecentDirsResponse>> {
  return connectRequest(connectComputerRecentDirsPath(computerId), signalInit(signal), decodeConnectComputerRecentDirsResponse);
}

/** One level of subfolders of `path` on the computer. */
export function loadConnectComputerDirs(
  computerId: string,
  path: string,
  signal?: AbortSignal
): Promise<ConnectApiResult<ConnectComputerDirsResponse>> {
  return connectRequest(connectComputerDirsPath(computerId, path), signalInit(signal), decodeConnectComputerDirsResponse);
}

/** Whether `path` exists on the computer and what it is. */
export function statConnectComputerPath(
  computerId: string,
  path: string,
  signal?: AbortSignal
): Promise<ConnectApiResult<ConnectComputerStatResponse>> {
  return connectRequest(connectComputerStatPath(computerId, path), signalInit(signal), decodeConnectComputerStatResponse);
}

export function lookupConnectPairing(
  userCode: string,
  signal?: AbortSignal
): Promise<ConnectApiResult<ConnectPairingLookupResponse>> {
  return connectRequest(connectPairingByCodePath(userCode), signalInit(signal), decodeConnectPairingLookupResponse);
}

export function decideConnectPairing(
  userCode: string,
  decision: ConnectPairingDecision
): Promise<ConnectApiResult<ConnectPairingDecisionResponse>> {
  return connectRequest(
    connectPairingByCodePath(userCode),
    { body: JSON.stringify({ decision }), method: "POST" },
    decodeConnectPairingDecisionResponse
  );
}
