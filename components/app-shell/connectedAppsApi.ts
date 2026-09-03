import { shellFetch } from "@/components/app-shell/shellApi";
import {
  decodeMemoryMcpConnectedAppResponse,
  decodeMemoryMcpConnectedAppsResponse,
  type MemoryMcpConnectedApp
} from "@/lib/contracts/memoryMcpConnectedApps";

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

async function responseJson(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return null;
  }
}

function errorCode(value: unknown): string {
  return isRecord(value) && typeof value.error === "string" && value.error.trim()
    ? value.error.trim()
    : "connected_apps_request_failed";
}

export class ConnectedAppsApiError extends Error {
  constructor(readonly code: string, readonly status: number) {
    super(code);
    this.name = "ConnectedAppsApiError";
  }
}

export async function loadConnectedApps(
  signal?: AbortSignal
): Promise<MemoryMcpConnectedApp[]> {
  const response = await shellFetch("/api/me/connected-apps", {
    cache: "no-store",
    credentials: "same-origin",
    headers: { accept: "application/json" },
    signal
  });
  const body = await responseJson(response);
  if (!response.ok) {
    throw new ConnectedAppsApiError(errorCode(body), response.status);
  }
  const decoded = decodeMemoryMcpConnectedAppsResponse(body);
  if (!decoded) throw new ConnectedAppsApiError("connected_apps_response_invalid", 502);
  return decoded.apps;
}

export async function revokeConnectedApp(
  connectionId: string,
  signal?: AbortSignal
): Promise<MemoryMcpConnectedApp> {
  const response = await shellFetch(
    `/api/me/connected-apps/${encodeURIComponent(connectionId)}`,
    {
      credentials: "same-origin",
      headers: { accept: "application/json" },
      method: "DELETE",
      signal
    }
  );
  const body = await responseJson(response);
  if (!response.ok) {
    throw new ConnectedAppsApiError(errorCode(body), response.status);
  }
  const decoded = decodeMemoryMcpConnectedAppResponse(body);
  if (!decoded) throw new ConnectedAppsApiError("connected_apps_response_invalid", 502);
  return decoded.app;
}
