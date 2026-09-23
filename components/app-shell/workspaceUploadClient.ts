import { create } from "zustand";
import { randomUUID } from "@/lib/browser/randomUUID";
import { sha256 } from "@/lib/browser/sha256";
import { decodeWorkspaceUpload, decodeWorkspaceUploadConfig, type WorkspaceUploadConfigWire, type WorkspaceUploadWire } from "@/lib/contracts/workspaceUploads";
import { shellFetch } from "./shellApi";
import { useComposerSessionStore, type ComposerSessionKey } from "./composerSessionStore";

export type WorkspaceUploadProgress = Readonly<{
  id: string; sourceKey: ComposerSessionKey; fileName: string; byteSize: number; sentBytes: number;
  state: "uploading" | "verifying" | "failed"; message: string | null; retryable: boolean;
}>;
export const useWorkspaceUploadProgress = create<{ items: WorkspaceUploadProgress[] }>(() => ({ items: [] }));
const actions = new Map<string, { cancel(): void; retry(): void }>();
export function cancelWorkspaceUpload(id: string): boolean {
  const action = actions.get(id); action?.cancel(); return !!action;
}
export function retryWorkspaceUpload(id: string): boolean {
  const action = actions.get(id); action?.retry(); return !!action;
}

class UploadFailure extends Error {
  constructor(readonly code: string, readonly retryable = true) { super(code); }
}
function failureMessage(error: unknown): string {
  const code = error instanceof UploadFailure ? error.code : "upload_unavailable";
  if (code === "file_too_large") return "This file exceeds the upload limit.";
  if (code === "unsupported_type") return "The file type or content could not be validated.";
  if (["upload_checksum_mismatch", "upload_size_mismatch"].includes(code)) return "The file could not be verified. Retry the upload.";
  if (code === "upload_busy") return "Upload capacity is busy. Retry shortly.";
  if (code === "workspace_runtime_unavailable") return "Workspace is unavailable. Retry when it is ready.";
  if (["upload_not_found", "unauthorized"].includes(code)) return "This upload is no longer available. Remove it and choose the file again.";
  return "Upload interrupted. Retry to continue or remove the file.";
}
async function responseValue(response: Response): Promise<unknown> {
  const value: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    const code = typeof value === "object" && value !== null && "error" in value && typeof value.error === "string"
      ? value.error : "upload_unavailable";
    throw new UploadFailure(code, ![400, 401, 403, 404, 413].includes(response.status));
  }
  return value;
}
export async function fetchWorkspaceUploadConfig(signal?: AbortSignal): Promise<WorkspaceUploadConfigWire> {
  const value = decodeWorkspaceUploadConfig(await responseValue(await shellFetch("/api/uploads/sessions", { signal })));
  if (!value) throw new UploadFailure("upload_unavailable");
  return value;
}
async function session(url: string, options: RequestInit, signal: AbortSignal): Promise<WorkspaceUploadWire> {
  const value = decodeWorkspaceUpload(await responseValue(await shellFetch(url, { ...options, signal })));
  if (!value) throw new UploadFailure("upload_unavailable");
  return value;
}

function wait(ms: number, signal: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    const abort = () => { clearTimeout(timer); reject(signal.reason); };
    const timer = setTimeout(() => { signal.removeEventListener("abort", abort); resolve(); }, ms);
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
  });
}

export function putWorkspaceUploadPart(input: {
  url: string; part: Blob; checksum: string; signal: AbortSignal; progress(bytes: number): void;
}): Promise<void> {
  return new Promise((resolve, reject) => {
    input.signal.throwIfAborted();
    const xhr = new XMLHttpRequest();
    const abort = () => xhr.abort();
    const finish = (error?: unknown) => {
      input.signal.removeEventListener("abort", abort);
      xhr.onload = xhr.onerror = xhr.ontimeout = xhr.onabort = null;
      xhr.upload.onprogress = null;
      if (error) reject(error); else resolve();
    };
    xhr.open("PUT", input.url);
    xhr.timeout = 5 * 60_000;
    xhr.setRequestHeader("content-type", "application/octet-stream");
    xhr.setRequestHeader("x-upload-sha256", input.checksum);
    xhr.upload.onprogress = event => input.progress(Math.min(event.loaded, input.part.size));
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) finish();
      else {
        let code = "upload_unavailable";
        try { const value: unknown = JSON.parse(xhr.responseText); if (typeof value === "object" && value && "error" in value && typeof value.error === "string") code = value.error; } catch {}
        finish(new UploadFailure(code, ["upload_size_mismatch", "upload_checksum_mismatch"].includes(code) || ![400, 401, 403, 404, 413].includes(xhr.status)));
      }
    };
    xhr.onerror = xhr.ontimeout = () => finish(new UploadFailure("upload_unavailable"));
    xhr.onabort = () => finish(input.signal.reason ?? new DOMException("Aborted", "AbortError"));
    input.signal.addEventListener("abort", abort, { once: true });
    xhr.send(input.part);
  });
}

export async function uploadWorkspaceFile(input: {
  file: File; projectId: string | null; sourceKey: ComposerSessionKey; generation: number;
}) {
  const id = `upload-${randomUUID()}`;
  let key = randomUUID();
  let current: WorkspaceUploadWire | null = null;
  let resume: (() => void) | null = null;
  const controller = new AbortController();
  const update = (patch: Partial<WorkspaceUploadProgress>) => useWorkspaceUploadProgress.setState(state => ({
    items: state.items.map(item => item.id === id ? { ...item, ...patch } : item)
  }));
  const currentGeneration = () => useComposerSessionStore.getState().sessionsByKey[input.sourceKey]?.pendingUploadGenerations.includes(input.generation) === true;
  const cancel = () => { controller.abort(); resume?.(); };
  const unsubscribe = useComposerSessionStore.subscribe(() => { if (!currentGeneration()) cancel(); });
  actions.set(id, { cancel, retry: () => resume?.() });
  useWorkspaceUploadProgress.setState(state => ({ items: [...state.items, {
    id, sourceKey: input.sourceKey, fileName: input.file.name, byteSize: input.file.size, sentBytes: 0,
    state: "uploading", message: null, retryable: false
  }] }));
  try {
    while (!controller.signal.aborted && currentGeneration()) {
      try {
        update({ state: "uploading", message: null, retryable: false });
        if (current) {
          current = await session(`/api/uploads/sessions/${current.id}`, {}, controller.signal);
          if (["failed", "expired", "cancelled"].includes(current.state)) { current = null; key = randomUUID(); }
        }
        if (!current) current = await session("/api/uploads/sessions", { method: "POST",
          headers: { "content-type": "application/json" }, body: JSON.stringify({ byteSize: input.file.size,
            fileName: input.file.name, mimeType: input.file.type, projectId: input.projectId, idempotencyKey: key })
        }, controller.signal);
        if (current.state === "uploading") {
          const completed = new Set(current.completedParts);
          const count = Math.ceil(input.file.size / current.partBytes);
          let confirmed = current.completedParts.reduce((sum, number) => sum + Math.min(current!.partBytes, input.file.size - (number - 1) * current!.partBytes), 0);
          update({ sentBytes: confirmed });
          for (let number = 1; number <= count; number += 1) {
            controller.signal.throwIfAborted();
            if (completed.has(number)) continue;
            const part = input.file.slice((number - 1) * current.partBytes, Math.min(number * current.partBytes, input.file.size));
            // Only this <= 8 MiB part is materialized for its integrity header.
            const checksum = await sha256(await part.arrayBuffer());
            controller.signal.throwIfAborted();
            await putWorkspaceUploadPart({ url: `/api/uploads/sessions/${current.id}/parts/${number}`, part, checksum,
              signal: controller.signal, progress: bytes => update({ sentBytes: confirmed + bytes }) });
            confirmed += part.size; update({ sentBytes: confirmed });
          }
          current = await session(`/api/uploads/sessions/${current.id}/complete`, { method: "POST" }, controller.signal);
        }
        const started = Date.now();
        while (current.state === "verifying") {
          update({ state: "verifying", sentBytes: input.file.size });
          if (Date.now() - started > 20 * 60_000) throw new UploadFailure("upload_unavailable");
          await wait(1_500, controller.signal);
          current = await session(`/api/uploads/sessions/${current.id}`, {}, controller.signal);
        }
        if (current.state !== "completed" || !current.attachment) throw new UploadFailure(current.errorCode ?? "upload_unavailable", current.errorCode !== "unsupported_type");
        controller.signal.throwIfAborted();
        return current.attachment;
      } catch (error) {
        if (controller.signal.aborted || !currentGeneration()) return null;
        const retryable = !(error instanceof UploadFailure) || error.retryable;
        update({ state: "failed", message: failureMessage(error), retryable });
        await new Promise<void>(resolve => { resume = resolve; if (controller.signal.aborted) resolve(); });
        resume = null;
      }
    }
    return null;
  } finally {
    unsubscribe(); actions.delete(id);
    useWorkspaceUploadProgress.setState(state => ({ items: state.items.filter(item => item.id !== id) }));
    if (controller.signal.aborted && current && current.state !== "completed") {
      void shellFetch(`/api/uploads/sessions/${current.id}`, { method: "DELETE", signal: AbortSignal.timeout(10_000) }).catch(() => undefined);
    }
  }
}
