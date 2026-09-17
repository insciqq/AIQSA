import { decodeInstructionPreset, decodeInstructionPresetState, instructionPresetErrorMessage,
  type InstructionPreset, type InstructionPresetMutation, type InstructionPresetState } from "@/lib/contracts/instructionPresets";
import { decodeInstructionPreview, type InstructionPreview } from "@/lib/contracts/instructionPreview";

export class InstructionPresetApiError extends Error {
  constructor(readonly code: unknown) { super(instructionPresetErrorMessage(code)); }
}
async function request(path: string, mutation?: InstructionPresetMutation, signal?: AbortSignal) {
  const response = await fetch(`/api/me/instructions${path}`, {
    method: mutation ? "POST" : "GET", credentials: "same-origin", cache: "no-store", signal,
    ...(mutation ? { headers: { "content-type": "application/json" }, body: JSON.stringify(mutation) } : {})
  });
  const body: unknown = await response.json().catch(() => null);
  const data = body && typeof body === "object" && !Array.isArray(body) ? body as Record<string, unknown> : null;
  if (!response.ok) throw new InstructionPresetApiError(data?.error);
  return data;
}
export async function requestInstructionPresets(mutation?: InstructionPresetMutation, signal?: AbortSignal): Promise<InstructionPresetState> {
  const state = decodeInstructionPresetState((await request("", mutation, signal))?.instructions);
  if (!state) throw new InstructionPresetApiError(null);
  return state;
}
export async function requestInstructionPreset(id: string, signal?: AbortSignal): Promise<InstructionPreset> {
  const preset = decodeInstructionPreset((await request(`/${encodeURIComponent(id)}`, undefined, signal))?.preset);
  if (!preset) throw new InstructionPresetApiError(null);
  return preset;
}

export async function requestInstructionPreview(timeZone?: string, signal?: AbortSignal): Promise<InstructionPreview> {
  const query = timeZone ? `?timeZone=${encodeURIComponent(timeZone)}` : "";
  const data = await request(`/preview${query}`, undefined, signal);
  const preview = decodeInstructionPreview(data?.preview);
  if (!preview) throw new InstructionPresetApiError(null);
  return preview;
}
