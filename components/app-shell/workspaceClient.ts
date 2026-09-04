import { shellFetch } from "@/components/app-shell/shellApi";
import { humanizeErrorCode } from "@/components/app-shell/shellFormatting";
import { decodeChatSummaryResponse } from "@/lib/contracts/chats";
import {
  decodeChatWorkspaceState,
  decodeThreadGeneratedFile,
  type ChatWorkspaceState,
  type ThreadGeneratedFile
} from "@/lib/contracts/workspace";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function body(response: Response): Promise<unknown> {
  return response.json().catch(() => null);
}

async function successfulBody(response: Response): Promise<unknown> {
  const value = await body(response);
  if (!response.ok) {
    const code = isRecord(value) && typeof value.error === "string"
      ? value.error
      : `workspace_request_failed_${response.status}`;
    throw new Error(humanizeErrorCode(code));
  }
  return value;
}

function workspaceFromResponse(value: unknown): ChatWorkspaceState | null {
  return isRecord(value) ? decodeChatWorkspaceState(value.workspace) : null;
}

export async function loadWorkspaceAvailability(): Promise<ChatWorkspaceState> {
  const decoded = workspaceFromResponse(await successfulBody(
    await shellFetch("/api/workspace")
  ));
  if (!decoded) throw new Error("Workspace availability response was malformed.");
  return decoded;
}

export async function updateChatWorkspaceEnabled(chatId: string, enabled: boolean) {
  const decoded = decodeChatSummaryResponse(await successfulBody(await shellFetch(
    `/api/chats/${encodeURIComponent(chatId)}`,
    {
      body: JSON.stringify({ workspaceEnabled: enabled }),
      headers: { "content-type": "application/json" },
      method: "PATCH"
    }
  )));
  if (!decoded || decoded.id !== chatId) {
    throw new Error("Workspace chat response was malformed.");
  }
  return decoded;
}

export async function resetChatWorkspace(chatId: string): Promise<ChatWorkspaceState> {
  const decoded = workspaceFromResponse(await successfulBody(await shellFetch(
    `/api/chats/${encodeURIComponent(chatId)}/workspace/reset`,
    { method: "POST" }
  )));
  if (!decoded) throw new Error("Workspace reset response was malformed.");
  return decoded;
}

export async function archiveChatWorkspace(chatId: string): Promise<ThreadGeneratedFile> {
  const value = await successfulBody(await shellFetch(
    `/api/chats/${encodeURIComponent(chatId)}/workspace/archive`,
    { method: "POST" }
  ));
  const decoded = isRecord(value) ? decodeThreadGeneratedFile(value.file) : null;
  if (!decoded) throw new Error("Workspace archive response was malformed.");
  return decoded;
}

export function attachmentDownloadHref(attachmentId: string): string {
  return `/api/attachments/${encodeURIComponent(attachmentId)}/content`;
}
