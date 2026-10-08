import { shellFetch } from "@/components/app-shell/shellApi";
import { responseErrorMessage } from "@/components/app-shell/shellFormatting";
import {
  DELETE_ALL_PERSONAL_CHATS_CONFIRMATION,
  decodeAccountProfileResponse,
  decodeDeleteAllPersonalChatsResponse,
  type AccountProfileWire,
  type DeleteAllPersonalChatsResponse
} from "@/lib/contracts/account";
import {
  decodeRecoveryCodes,
  decodeTwoFactorSetup,
  decodeTwoFactorStatus,
  type TwoFactorProofWire,
  type TwoFactorSetupWire,
  type TwoFactorStatusWire
} from "@/lib/contracts/twoFactor";

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

/** Two-factor calls fail with the server's stable code, which the settings row explains. */
async function twoFactorPost(path: string, body: Readonly<Record<string, unknown>>): Promise<unknown> {
  const response = await shellFetch(`/api/me/two-factor/${path}`, {
    body: JSON.stringify(body),
    headers: jsonHeaders,
    method: "POST"
  });
  const data: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    const code = typeof data === "object" && data && "error" in data && typeof data.error === "string" ? data.error : "";
    throw new Error(/^[a-z][a-z0-9_]{0,127}$/u.test(code) ? code : `two_factor_failed_${response.status}`);
  }
  return data;
}

export async function loadTwoFactorStatus(): Promise<TwoFactorStatusWire> {
  const response = await shellFetch("/api/me/two-factor", { cache: "no-store" });
  if (!response.ok) await failure(response, `two_factor_status_failed_${response.status}`);
  const status = decodeTwoFactorStatus(await response.json().catch(() => null));
  if (!status) throw new Error("two_factor_status_malformed");
  return status;
}

/** Starts setup; replacing an active authenticator needs `proof`. */
export async function startTwoFactorSetup(proof?: TwoFactorProofWire): Promise<TwoFactorSetupWire> {
  const setup = decodeTwoFactorSetup(await twoFactorPost("start", proof ?? {}));
  if (!setup) throw new Error("two_factor_setup_malformed");
  return setup;
}

export type TwoFactorCodesResult = Readonly<{ recoveryCodes: string[]; status: TwoFactorStatusWire | null }>;

export async function confirmTwoFactorSetup(code: string): Promise<TwoFactorCodesResult> {
  const data = await twoFactorPost("confirm", { code });
  const recoveryCodes = decodeRecoveryCodes(data);
  if (!recoveryCodes) throw new Error("two_factor_codes_malformed");
  return { recoveryCodes, status: decodeTwoFactorStatus(data) };
}

export async function regenerateRecoveryCodes(proof: TwoFactorProofWire): Promise<TwoFactorCodesResult> {
  const data = await twoFactorPost("regenerate-codes", proof);
  const recoveryCodes = decodeRecoveryCodes(data);
  if (!recoveryCodes) throw new Error("two_factor_codes_malformed");
  return { recoveryCodes, status: decodeTwoFactorStatus(data) };
}

export async function disableTwoFactor(proof: TwoFactorProofWire): Promise<TwoFactorStatusWire | null> {
  return decodeTwoFactorStatus(await twoFactorPost("disable", proof));
}
