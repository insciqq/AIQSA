import { shellFetch } from "@/components/app-shell/shellApi";
import { responseErrorMessage } from "@/components/app-shell/shellFormatting";
import {
  DELETE_ALL_PERSONAL_CHATS_CONFIRMATION,
  decodeAccountProfileResponse,
  decodeDeleteAllPersonalChatsResponse,
  type AccountProfileWire,
  type DeleteAllPersonalChatsResponse
} from "@/lib/contracts/account";

const jsonHeaders = { "content-type": "application/json" };

async function failure(response: Response, fallback: string): Promise<never> {
  throw new Error(await responseErrorMessage(response, fallback));
}

export async function loadAccountProfile(): Promise<AccountProfileWire> {
  const response = await shellFetch("/api/me", { cache: "no-store" });
  if (!response.ok) await failure(response, `account_profile_failed_${response.status}`);
  const profile = decodeAccountProfileResponse(await response.json().catch(() => null));
  if (!profile) throw new Error("account_profile_malformed");
  return profile;
}

export async function updateAccountDisplayName(displayName: string): Promise<AccountProfileWire> {
  const response = await shellFetch("/api/me", {
    body: JSON.stringify({ displayName }),
    headers: jsonHeaders,
    method: "PATCH"
  });
  if (!response.ok) await failure(response, `account_update_failed_${response.status}`);
  const profile = decodeAccountProfileResponse(await response.json().catch(() => null));
  if (!profile) throw new Error("account_profile_malformed");
  return profile;
}

export async function changeAccountPassword(input: Readonly<{
  currentPassword: string;
  newPassword: string;
}>): Promise<void> {
  const response = await shellFetch("/api/me/password", {
    body: JSON.stringify(input),
    headers: jsonHeaders,
    method: "POST"
  });
  if (!response.ok) await failure(response, `password_change_failed_${response.status}`);
}

/** Sends the confirmation literal only after the user confirmed the named consequence. */
export async function deleteAllPersonalChats(): Promise<DeleteAllPersonalChatsResponse> {
  const response = await shellFetch("/api/me/chats/delete-all", {
    body: JSON.stringify({ confirmation: DELETE_ALL_PERSONAL_CHATS_CONFIRMATION }),
    headers: jsonHeaders,
    method: "POST"
  });
  if (!response.ok) await failure(response, `delete_all_failed_${response.status}`);
  const decoded = decodeDeleteAllPersonalChatsResponse(await response.json().catch(() => null));
  if (!decoded) throw new Error("delete_all_malformed");
  return decoded;
}

export const ACCOUNT_EXPORT_ALL_CHATS_HREF = "/api/me/chats/export";
