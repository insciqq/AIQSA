import { shellFetch } from "@/components/app-shell/shellApi";
import { decodeUserImageModelSettings, type UserImageModelSettings } from "@/lib/contracts/imageModels";

export class ImageModelApiError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = "ImageModelApiError";
  }
}

async function request(init: RequestInit): Promise<UserImageModelSettings> {
  const response = await shellFetch("/api/me/image-models", {
    cache: "no-store", credentials: "same-origin", ...init,
    headers: { accept: "application/json", ...(init.body ? { "content-type": "application/json" } : {}) }
  });
  const body: unknown = await response.json().catch(() => null);
  const record = typeof body === "object" && body !== null && !Array.isArray(body) ? body as Record<string, unknown> : null;
  if (!response.ok) {
    throw new ImageModelApiError(typeof record?.error === "string" ? record.error : "image_models_unavailable");
  }
  const settings = decodeUserImageModelSettings(record?.imageModel);
  if (!settings) throw new ImageModelApiError("image_models_response_invalid");
  return settings;
}

export function loadUserImageModels(signal?: AbortSignal): Promise<UserImageModelSettings> {
  return request({ method: "GET", signal });
}

export function saveUserImageModel(providerModelId: string | null, signal?: AbortSignal): Promise<UserImageModelSettings> {
  return request({ method: "PATCH", body: JSON.stringify({ providerModelId }), signal });
}
