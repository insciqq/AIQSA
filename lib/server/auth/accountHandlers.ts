import {
  normalizeDisplayName,
  type AccountProfileWire
} from "../../contracts/account";
import {
  readJsonBodyOrNull,
  requestBodyErrorResponse
} from "../http/requestBody";
import {
  hashPassword as hashPasswordDefault,
  validatePassword,
  verifyPassword as verifyPasswordDefault
} from "./password";
import {
  createFixedWindowLoginRateLimiter,
  type LoginRateLimiter
} from "./rateLimit";
import type { RequestAuthResolver } from "./requestAuth";
import { hashToken } from "./token";

export type AccountProfileRecord = AccountProfileWire;

export type AccountProfileRepository = Readonly<{
  updateDisplayName(userId: string, displayName: string): Promise<AccountProfileRecord | null>;
}>;

export type PasswordChangeIdentity = Readonly<{
  id: string;
  passwordHash: string | null;
}>;

export type PasswordChangeRepository = Readonly<{
  /** The password identity of the user, or null for external-provider-only accounts. */
  findPasswordIdentityByUserId(userId: string): Promise<PasswordChangeIdentity | null>;
  /**
   * Compare-and-set of the stored hash; on success every other session of the
   * user is revoked so a stolen session does not outlive the old password.
   */
  changePassword(input: Readonly<{
    expectedPasswordHash: string;
    identityId: string;
    keepSessionId: string;
    now: Date;
    passwordHash: string;
  }>): Promise<boolean>;
}>;

export type ChangePasswordHandlerDeps = Readonly<{
  now?: () => Date;
  passwordHasher?: (password: string) => Promise<string>;
  rateLimiter?: LoginRateLimiter;
  repository: PasswordChangeRepository;
  resolveAuth: RequestAuthResolver;
  verifyPassword?: (password: string, passwordHash: string | null | undefined) => Promise<boolean>;
}>;

const DUMMY_PASSWORD_HASH =
  "aiqsa-scrypt-v1$N=16384,r=8,p=1$AAAAAAAAAAAAAAAAAAAAAA$rmM9JCGyQbwbUPgnezPVMCI7l8Gg0Gv7nvxL4hxR8ngyb8E3JmLHq607G0T-uTPPDSb_c-X3RWDvsVF8ZusM3Q";
const defaultChangeRateLimiter = createFixedWindowLoginRateLimiter();

function json(body: unknown, status = 200): Response {
  const response = Response.json(body, { status });
  response.headers.set("cache-control", "private, no-store, max-age=0");
  response.headers.set("vary", "Cookie");
  return response;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function readBody(request: Request): Promise<Record<string, unknown> | Response> {
  const value = await readJsonBodyOrNull(request, "auth");
  const error = requestBodyErrorResponse(value);
  if (error) return error;
  return isRecord(value) ? value : {};
}

export function createUpdateAccountProfileHandler(deps: Readonly<{
  repository: Pick<AccountProfileRepository, "updateDisplayName">;
  resolveAuth: RequestAuthResolver;
}>) {
  return async function PATCH(request: Request): Promise<Response> {
    const auth = await deps.resolveAuth(request);
    if (!auth) return json({ error: "unauthorized" }, 401);
    const body = await readBody(request);
    if (body instanceof Response) return body;
    const displayName = normalizeDisplayName(body.displayName);
    if (!displayName) return json({ error: "display_name_invalid" }, 400);
    const user = await deps.repository.updateDisplayName(auth.userId, displayName);
    if (!user) return json({ error: "unauthorized" }, 401);
    return json({ user });
  };
}

export function createChangePasswordHandler(deps: ChangePasswordHandlerDeps) {
  const rateLimiter = deps.rateLimiter ?? defaultChangeRateLimiter;
  const verifyPassword = deps.verifyPassword ?? verifyPasswordDefault;
  const hashPassword = deps.passwordHasher ?? hashPasswordDefault;
  return async function POST(request: Request): Promise<Response> {
    const auth = await deps.resolveAuth(request);
    if (!auth) return json({ error: "unauthorized" }, 401);
    const body = await readBody(request);
    if (body instanceof Response) return body;
    const currentPassword = typeof body.currentPassword === "string" ? body.currentPassword : "";
    const newPassword = typeof body.newPassword === "string" ? body.newPassword : "";
    if (!currentPassword || !newPassword) {
      return json({ error: "password_change_required" }, 400);
    }
    const passwordError = validatePassword(newPassword);
    if (passwordError) return json({ error: passwordError }, 400);

    const rateLimitKey = `password-change:account:${hashToken(auth.userId).slice(0, 32)}`;
    const rateLimit = await rateLimiter.check(rateLimitKey);
    if (!rateLimit.allowed) {
      return json({ error: "rate_limited" }, 429);
    }

    const identity = await deps.repository.findPasswordIdentityByUserId(auth.userId);
    const currentOk = await verifyPassword(currentPassword, identity?.passwordHash ?? DUMMY_PASSWORD_HASH);
    if (!identity?.passwordHash) return json({ error: "password_not_set" }, 409);
    if (!currentOk) return json({ error: "current_password_invalid" }, 403);
    if (currentPassword === newPassword) return json({ error: "password_unchanged" }, 400);

    const changed = await deps.repository.changePassword({
      expectedPasswordHash: identity.passwordHash,
      identityId: identity.id,
      keepSessionId: auth.id,
      now: deps.now?.() ?? new Date(),
      passwordHash: await hashPassword(newPassword)
    });
    if (!changed) return json({ error: "password_change_conflict" }, 409);
    await rateLimiter.reset(rateLimitKey);
    return json({ ok: true });
  };
}
