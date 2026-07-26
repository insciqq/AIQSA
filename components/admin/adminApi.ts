import type {
  AdminActionRequest,
  AdminActionResponse,
  AdminActionServerErrorCode,
  AdminDashboard,
  AdminDashboardServerErrorCode,
  AdminInviteEmailDelivery
} from "@/lib/contracts/admin";
import { isAdminDashboard } from "@/lib/contracts/admin";

type PartialAdminActionResponse<Response extends AdminActionResponse = AdminActionResponse> =
  Response extends AdminActionResponse ? Partial<Response> : never;

export type AdminActionClientErrorCode =
  | AdminActionServerErrorCode
  | "admin_action_failed"
  | "clipboard_unavailable"
  | "network_error";

export type AdminDashboardErrorCode =
  | AdminDashboardServerErrorCode
  | "admin_dashboard_failed"
  | "network_error";

export type AdminActionResult = PartialAdminActionResponse & {
  emailDelivery?: AdminInviteEmailDelivery;
  error?: string;
  inviteUrl?: string;
  [key: string]: unknown;
};

export type AdminDashboardResult =
  | {
      dashboard: AdminDashboard;
      ok: true;
    }
  | {
      error: string;
      ok: false;
    };

type Fetcher = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export async function readAdminActionResult(response: Response): Promise<AdminActionResult> {
  const data = (await response.json().catch(() => null)) as AdminActionResult | null;

  if (response.ok) {
    return data ?? {};
  }

  return {
    error: data?.error ?? "admin_action_failed"
  };
}

export async function requestAdminAction(
  body: AdminActionRequest,
  fetcher: Fetcher = fetch
): Promise<AdminActionResult> {
  try {
    const response = await fetcher("/api/admin/action", {
      body: JSON.stringify(body),
      headers: {
        "content-type": "application/json"
      },
      method: "POST"
    });

    return await readAdminActionResult(response);
  } catch {
    return {
      error: "network_error"
    };
  }
}

export async function requestAdminDashboard(fetcher: Fetcher = fetch): Promise<AdminDashboardResult> {
  try {
    const response = await fetcher("/api/admin");
    const data = await response.json().catch(() => null);

    if (!response.ok || !isAdminDashboard(data)) {
      return {
        error: isRecord(data) && typeof data.error === "string" ? data.error : "admin_dashboard_failed",
        ok: false
      };
    }

    return {
      dashboard: data,
      ok: true
    };
  } catch {
    return {
      error: "network_error",
      ok: false
    };
  }
}

export function adminActionErrorMessage(code: AdminActionClientErrorCode | (string & {})): string {
  const messages: Record<AdminActionClientErrorCode, string> = {
    access_rule_invalid: "Enter a valid exact email or domain before saving.",
    access_rule_not_found: "This access rule no longer exists. Refresh to review the current rules.",
    access_rule_required: "Enter an exact email or domain before saving.",
    action_required: "This admin action is unavailable. Refresh the console and try again.",
    action_unknown: "This admin action is unavailable. Refresh the console and try again.",
    admin_action_failed: "The admin action could not be completed. Review the current data and try again.",
    clipboard_unavailable: "The invite link could not be copied. Copy it manually from the field.",
    email_invalid: "Enter a valid email address.",
    email_required: "Enter the invited email address.",
    forbidden: "Your account no longer has permission to perform this admin action.",
    group_grant_invalid: "Choose a valid provider, model, or search grant and try again.",
    group_grant_required: "Choose a group and grant before saving.",
    group_has_grants: "Remove active grants before deleting this group.",
    group_has_members: "Remove members before deleting this group.",
    group_invalid: "Use a unique, non-empty group name.",
    group_not_found: "This group no longer exists or its new name is already in use. Refresh to review the current groups.",
    group_required: "Enter a group name.",
    invalid_origin: "The request was blocked by the same-origin security check. Reload AIQSA from its configured URL and try again.",
    invite_accepted: "Accepted invites are kept for audit history.",
    invite_email_delivery_invalid: "Choose whether to email the invite link and try again.",
    invite_not_found: "This invite no longer exists or has already changed state. Refresh to review the current invites.",
    invite_open: "Revoke this open invite before deleting it.",
    invite_required: "Choose an invite before continuing.",
    json_required: "The admin request format was not accepted. Refresh the console and try again.",
    last_admin_forbidden: "The final active administrator cannot be disabled.",
    network_error: "Could not reach the admin API.",
    self_disable_forbidden: "Your current administrator account cannot disable itself.",
    self_delete_forbidden: "Your current admin account cannot delete itself.",
    system_group_forbidden: "Full access is built in and cannot be renamed, archived, deleted, or edited with ordinary grants.",
    unauthorized: "Your admin session is no longer valid. Sign in again to continue.",
    user_active: "Disable this user before deleting it.",
    user_has_owned_data: "This user owns app data and must remain disabled until a purge flow exists.",
    user_not_found: "This user no longer exists or is no longer eligible for this action. Refresh to review the current users.",
    user_not_verified: "Verify this user's email identity before approving the account.",
    user_required: "Choose a user before continuing."
  };

  return messages[code as AdminActionClientErrorCode] ?? "The admin action could not be completed. Review the current data and try again.";
}

export function adminDashboardErrorMessage(code: AdminDashboardErrorCode | (string & {})): string {
  const messages: Record<AdminDashboardErrorCode, string> = {
    admin_dashboard_failed: "Admin data could not be loaded. Check the server and try Refresh.",
    forbidden: "Your account no longer has permission to view the admin console.",
    network_error: "Could not reach the admin API. Check the connection and try Refresh.",
    unauthorized: "Your admin session is no longer valid. Sign in again to continue."
  };

  if (code in messages) {
    return messages[code as AdminDashboardErrorCode];
  }

  return /\s/.test(code) ? code : "Admin data could not be loaded. Check the server and try Refresh.";
}
