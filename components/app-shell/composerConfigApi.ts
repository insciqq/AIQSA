import { shellFetch } from "@/components/app-shell/shellApi";
import {
  decodeComposerConfigResponse,
  type ComposerConfig
} from "@/lib/contracts/composerConfig";

const publicErrorCodes = new Set([
  "unauthorized",
  "user_not_found"
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function responseJson(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return null;
  }
}

export class ComposerConfigApiError extends Error {
  readonly code: string;
  readonly status: number;

  constructor(code: string, status: number) {
    super(code);
    this.name = "ComposerConfigApiError";
    this.code = code;
    this.status = status;
  }
}

export async function fetchComposerConfig(signal?: AbortSignal): Promise<ComposerConfig> {
  const response = await shellFetch("/api/me/composer-config", {
    cache: "no-store",
    credentials: "same-origin",
    headers: { accept: "application/json" },
    signal
  });
  const body = await responseJson(response);
  if (!response.ok) {
    const rawCode = isRecord(body) && typeof body.error === "string" ? body.error : "";
    const code = publicErrorCodes.has(rawCode) ? rawCode : "composer_config_unavailable";
    throw new ComposerConfigApiError(code, response.status);
  }
  const decoded = decodeComposerConfigResponse(body);
  if (!decoded) throw new ComposerConfigApiError("composer_config_malformed", 502);
  return decoded;
}
