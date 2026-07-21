import { adminActionNames } from "@/lib/contracts/admin";
import type {
  AdminAccessRuleKind,
  AdminActionName,
  AdminActionRequest,
  AdminActionResponse,
  AdminDashboard,
  AdminDashboardErrorResponse,
  AdminInviteEmailDelivery
} from "@/lib/contracts/admin";
import type { AuthConfig } from "./config";
import type { AdminRepository } from "./adminRepositoryContract";
import type { AuthMailer } from "./mailer";
import type { RequestAuthResolver } from "./requestAuth";
import { createSessionToken } from "./session";
import { hashToken } from "./token";

export type AdminHandlerDeps = {
  getConfig(): Pick<AuthConfig, "appBaseUrl">;
  repository: AdminRepository;
  resolveAuth: RequestAuthResolver;
};

export type AdminActionHandlerDeps = AdminHandlerDeps & {
  mailer: AuthMailer;
};

type UntrustedAdminAction<Action extends AdminActionRequest> = Action extends AdminActionRequest
  ? { action: Action["action"] } & {
      [Key in Exclude<keyof Action, "action">]?: unknown;
    }
  : never;

type AdminAction = UntrustedAdminAction<AdminActionRequest>;

const adminActionNameSet = new Set<string>(adminActionNames);

const INVITE_MAX_AGE_DAYS = 7;

function actionJson(data: AdminActionResponse, init?: ResponseInit): Response {
  return Response.json(data, init);
}

function authErrorJson(data: AdminDashboardErrorResponse, init?: ResponseInit): Response {
  return Response.json(data, init);
}

function dashboardJson(data: AdminDashboard, init?: ResponseInit): Response {
  return Response.json(data, init);
}

function isAdminActionName(value: string): value is AdminActionName {
  return adminActionNameSet.has(value);
}

function unhandledAdminAction(action: never): Response {
  return actionJson({ error: "action_unknown" }, { status: 400 });
}

async function readJson(request: Request): Promise<unknown> {
  try {
    return await request.json();
  } catch {
    return null;
  }
}

function isJsonContentType(contentType: string | null): boolean {
  const mediaType = contentType?.split(";")[0]?.trim().toLowerCase() ?? "";

  return mediaType === "application/json" || mediaType.endsWith("+json");
}

function requireJsonContentType(request: Request): Response | null {
  if (isJsonContentType(request.headers.get("content-type"))) {
    return null;
  }

  return actionJson({ error: "json_required" }, { status: 415 });
}

function stringField(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function groupIds(value: unknown): string[] {
  return Array.isArray(value)
    ? [...new Set(value.filter((entry): entry is string => typeof entry === "string" && Boolean(entry)))]
    : [];
}

function accessRuleKind(value: unknown): AdminAccessRuleKind | null {
  return value === "domain" || value === "email" ? value : null;
}

function booleanField(value: unknown): boolean | null {
  return typeof value === "boolean" ? value : null;
}

function inviteExpiresAt(now = new Date()): Date {
  return new Date(now.getTime() + INVITE_MAX_AGE_DAYS * 24 * 60 * 60 * 1000);
}

function inviteUrl(baseUrl: string, token: string): string {
  const url = new URL("/login", baseUrl);

  url.searchParams.set("invite", token);

  return url.toString();
}

function invitationEmail(input: {
  expiresAt: Date;
  inviteUrl: string;
  to: string;
}): { subject: string; text: string; to: string } {
  return {
    subject: "You're invited to AIQSA",
    text: [
      "An AIQSA administrator invited you to create an account.",
      "",
      "Open this link to continue:",
      input.inviteUrl,
      "",
      "This invitation is bound to the email address that received this message.",
      `It expires at ${input.expiresAt.toISOString()}.`,
      "On the create-account form, choose your name and password to enter AIQSA directly.",
      "",
      "If you did not expect this invitation, ignore this email."
    ].join("\n"),
    to: input.to
  };
}

async function deliverInvitationEmail(input: {
  expiresAt: Date;
  inviteUrl: string;
  mailer: AuthMailer;
  requested: boolean;
  to: string;
}): Promise<AdminInviteEmailDelivery> {
  if (!input.requested) {
    return "not_requested";
  }

  if (!input.mailer.deliveryConfigured) {
    return "unavailable";
  }

  try {
    await input.mailer.send(
      invitationEmail({
        expiresAt: input.expiresAt,
        inviteUrl: input.inviteUrl,
        to: input.to
      })
    );
    return "sent";
  } catch {
    console.error("invite_email_failed");
    return "failed";
  }
}

async function requireAdmin(request: Request, deps: AdminHandlerDeps): Promise<{ response?: Response; userId?: string }> {
  const auth = await deps.resolveAuth(request);

  if (!auth) {
    return {
      response: authErrorJson({ error: "unauthorized" }, { status: 401 })
    };
  }

  const user = await deps.repository.findAdminUser(auth.userId);

  if (!user || user.status !== "active" || user.role !== "admin") {
    return {
      response: authErrorJson({ error: "forbidden" }, { status: 403 })
    };
  }

  return {
    userId: auth.userId
  };
}

function actionFromBody(body: unknown): UntrustedAdminAction<AdminActionRequest> | null {
  if (!body || typeof body !== "object" || !("action" in body) || typeof body.action !== "string") {
    return null;
  }

  return body as AdminAction;
}

export function createAdminDashboardHandler(deps: AdminHandlerDeps) {
  return async function GET(request: Request): Promise<Response> {
    const admin = await requireAdmin(request, deps);

    if (admin.response) {
      return admin.response;
    }

    return dashboardJson(await deps.repository.listDashboard());
  };
}

export function createAdminActionHandler(deps: AdminActionHandlerDeps) {
  const json = actionJson;

  return async function POST(request: Request): Promise<Response> {
    const contentTypeError = requireJsonContentType(request);

    if (contentTypeError) {
      return contentTypeError;
    }

    const admin = await requireAdmin(request, deps);

    if (admin.response || !admin.userId) {
      return admin.response!;
    }

    const candidate = actionFromBody(await readJson(request));

    if (!candidate) {
      return json({ error: "action_required" }, { status: 400 });
    }

    if (!isAdminActionName(candidate.action)) {
      return json({ error: "action_unknown" }, { status: 400 });
    }

    const action = candidate as AdminAction;

    if (action.action === "approve_user") {
      const userId = stringField(action.userId);

      if (!userId) {
        return json({ error: "user_required" }, { status: 400 });
      }

      const result = await deps.repository.approveUser({
        groupIds: groupIds(action.groupIds),
        userId
      });

      return result === "approved"
        ? json({ ok: true })
        : json({ error: result === "not_verified" ? "user_not_verified" : "user_not_found" }, { status: 400 });
    }

    if (action.action === "reject_user" || action.action === "disable_user") {
      const userId = stringField(action.userId);

      if (!userId) {
        return json({ error: "user_required" }, { status: 400 });
      }

      if (action.action === "reject_user") {
        const result = await deps.repository.rejectUser({
          revokedByUserId: admin.userId,
          userId
        });

        return result === "rejected" ? json({ ok: true }) : json({ error: "user_not_found" }, { status: 404 });
      }

      const result = await deps.repository.disableUser({
        revokedByUserId: admin.userId,
        userId
      });

      if (result === "disabled") {
        return json({ ok: true });
      }

      if (result === "self_disable_forbidden") {
        return json({ error: result }, { status: 403 });
      }

      if (result === "last_admin_forbidden") {
        return json({ error: result }, { status: 409 });
      }

      return json({ error: "user_not_found" }, { status: 404 });
    }

    if (action.action === "revoke_user_sessions") {
      const userId = stringField(action.userId);

      if (!userId) {
        return json({ error: "user_required" }, { status: 400 });
      }

      return json({
        revoked: await deps.repository.revokeUserSessions({
          revokedByUserId: admin.userId,
          userId
        })
      });
    }

    if (action.action === "revoke_all_sessions") {
      return json({
        revoked: await deps.repository.revokeAllSessions({
          revokedByUserId: admin.userId
        })
      });
    }

    if (action.action === "create_group") {
      const name = stringField(action.name);

      if (!name) {
        return json({ error: "group_required" }, { status: 400 });
      }

      const group = await deps.repository.createGroup({ name });

      return group ? json({ group }) : json({ error: "group_invalid" }, { status: 400 });
    }

    if (action.action === "rename_group") {
      const groupId = stringField(action.groupId);
      const name = stringField(action.name);

      if (!groupId || !name) {
        return json({ error: "group_required" }, { status: 400 });
      }

      const group = await deps.repository.renameGroup({ groupId, name });

      return group ? json({ group }) : json({ error: "group_not_found" }, { status: 404 });
    }

    if (action.action === "archive_group") {
      const groupId = stringField(action.groupId);

      if (!groupId) {
        return json({ error: "group_required" }, { status: 400 });
      }

      return (await deps.repository.archiveGroup(groupId))
        ? json({ ok: true })
        : json({ error: "group_not_found" }, { status: 404 });
    }

    if (action.action === "set_user_groups") {
      const userId = stringField(action.userId);

      if (!userId) {
        return json({ error: "user_required" }, { status: 400 });
      }

      return (await deps.repository.setUserGroups({
        groupIds: groupIds(action.groupIds),
        userId
      }))
        ? json({ ok: true })
        : json({ error: "user_not_found" }, { status: 404 });
    }

    if (action.action === "set_group_grant") {
      const enabled = booleanField(action.enabled);
      const groupId = stringField(action.groupId);

      if (enabled === null || !groupId) {
        return json({ error: "group_grant_required" }, { status: 400 });
      }

      return (await deps.repository.setGroupGrant({
        enabled,
        groupId,
        modelId: typeof action.modelId === "string" ? action.modelId : null,
        provider: typeof action.provider === "string" ? action.provider : null,
        searchStrategy: typeof action.searchStrategy === "string" ? action.searchStrategy : null
      }))
        ? json({ ok: true })
        : json({ error: "group_grant_invalid" }, { status: 400 });
    }

    if (action.action === "create_access_rule") {
      const kind = accessRuleKind(action.kind);
      const value = stringField(action.value);

      if (!kind || !value) {
        return json({ error: "access_rule_required" }, { status: 400 });
      }

      const rule = await deps.repository.createAccessRule({
        createdByUserId: admin.userId,
        groupIds: groupIds(action.groupIds),
        kind,
        value
      });

      return rule ? json({ rule }) : json({ error: "access_rule_invalid" }, { status: 400 });
    }

    if (action.action === "delete_access_rule") {
      const ruleId = stringField(action.ruleId);

      if (!ruleId) {
        return json({ error: "access_rule_required" }, { status: 400 });
      }

      return (await deps.repository.deleteAccessRule(ruleId))
        ? json({ ok: true })
        : json({ error: "access_rule_not_found" }, { status: 404 });
    }

    if (action.action === "delete_user") {
      const userId = stringField(action.userId);

      if (!userId) {
        return json({ error: "user_required" }, { status: 400 });
      }

      const result = await deps.repository.deleteStaleUser({
        actingAdminUserId: admin.userId,
        userId
      });

      if (result === "deleted") {
        return json({ ok: true });
      }

      const status = result === "not_found" ? 404 : result === "self_delete_forbidden" ? 403 : 400;

      return json({ error: result === "not_found" ? "user_not_found" : result }, { status });
    }

    if (action.action === "create_invite") {
      const email = stringField(action.email);
      const sendEmail = action.sendEmail === undefined ? false : booleanField(action.sendEmail);

      if (!email) {
        return json({ error: "email_required" }, { status: 400 });
      }

      if (sendEmail === null) {
        return json({ error: "invite_email_delivery_invalid" }, { status: 400 });
      }

      const token = createSessionToken();
      const expiresAt = inviteExpiresAt();
      const invite = await deps.repository.createInvite({
        createdByUserId: admin.userId,
        email,
        expiresAt,
        groupIds: groupIds(action.groupIds),
        tokenHash: hashToken(token)
      });

      if (!invite) {
        return json({ error: "email_invalid" }, { status: 400 });
      }

      const url = inviteUrl(deps.getConfig().appBaseUrl, token);
      const emailDelivery = await deliverInvitationEmail({
        expiresAt,
        inviteUrl: url,
        mailer: deps.mailer,
        requested: sendEmail,
        to: invite.email
      });

      return json({
        emailDelivery,
        invite,
        inviteUrl: url
      });
    }

    if (action.action === "revoke_invite") {
      const inviteId = stringField(action.inviteId);

      if (!inviteId) {
        return json({ error: "invite_required" }, { status: 400 });
      }

      return (await deps.repository.revokeInvite(inviteId))
        ? json({ ok: true })
        : json({ error: "invite_not_found" }, { status: 404 });
    }

    if (action.action === "delete_group") {
      const groupId = stringField(action.groupId);

      if (!groupId) {
        return json({ error: "group_required" }, { status: 400 });
      }

      const result = await deps.repository.deleteEmptyGroup(groupId);

      if (result === "deleted") {
        return json({ ok: true });
      }

      return json(
        { error: result === "not_found" ? "group_not_found" : result },
        { status: result === "not_found" ? 404 : 400 }
      );
    }

    if (action.action === "delete_invite") {
      const inviteId = stringField(action.inviteId);

      if (!inviteId) {
        return json({ error: "invite_required" }, { status: 400 });
      }

      const result = await deps.repository.deleteStaleInvite({
        inviteId,
        now: new Date()
      });

      if (result === "deleted") {
        return json({ ok: true });
      }

      return json(
        { error: result === "not_found" ? "invite_not_found" : result },
        { status: result === "not_found" ? 404 : 400 }
      );
    }

    return unhandledAdminAction(action.action);
  };
}
