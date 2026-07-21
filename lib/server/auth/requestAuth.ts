import { hashToken } from "./token";
import {
  createSessionSetCookie,
  createSessionToken,
  getSessionFromRequest,
  sessionExpiresAt
} from "./session";
import type { AuthConfig } from "./config";

export type AuthenticatedUser = {
  displayName: string;
  email: string | null;
  id: string;
  role: string;
  status: string;
};

export type AuthenticatedSession = {
  expiresAt: Date;
  id: string;
  user: AuthenticatedUser;
  userId: string;
};

export type AuthSessionRecord = {
  expiresAt: Date | string;
  id: string;
  revokedAt: Date | string | null;
  user: AuthenticatedUser | null;
  userId: string;
};

export type CreateAuthSessionInput = {
  createdByIp?: string | null;
  createdByUserAgent?: string | null;
  expiresAt: Date;
  lastSeenAt?: Date | null;
  tokenHash: string;
  userId: string;
};

export type AuthSessionStore = {
  createSession(input: CreateAuthSessionInput): Promise<AuthSessionRecord>;
  deleteExpiredSessions?(now: Date): Promise<number>;
  findSessionByTokenHash(tokenHash: string): Promise<AuthSessionRecord | null>;
  revokeSessionByTokenHash(input: { revokedAt: Date; revokedReason: string; tokenHash: string }): Promise<number>;
  revokeUserSessions?(input: { revokedAt: Date; revokedReason: string; userId: string }): Promise<number>;
};

export type RequestAuthResolver = (request: Request) => Promise<AuthenticatedSession | null>;

export type CreatedAuthSession = {
  cookie: string;
  expiresAt: Date;
  sessionId: string;
  token: string;
};

export type PreparedAuthSession = {
  cookie: string;
  input: Omit<CreateAuthSessionInput, "userId">;
  token: string;
};

function asDate(value: Date | string): Date {
  return value instanceof Date ? value : new Date(value);
}

function isActiveUser(user: AuthenticatedUser | null): user is AuthenticatedUser {
  return user?.status === "active";
}

function userAgent(request: Request): string | null {
  const value = request.headers.get("user-agent")?.trim();

  return value ? value.slice(0, 512) : null;
}

export function prepareAuthSession(input: {
  now?: Date;
  request?: Request;
  secureCookie: boolean;
}): PreparedAuthSession {
  const now = input.now ?? new Date();
  const token = createSessionToken();

  return {
    cookie: createSessionSetCookie(token, {
      secure: input.secureCookie
    }),
    input: {
      createdByUserAgent: input.request ? userAgent(input.request) : null,
      expiresAt: sessionExpiresAt(now),
      lastSeenAt: now,
      tokenHash: hashToken(token)
    },
    token
  };
}

export async function resolveAuthToken(
  token: string | undefined,
  deps: { now?: Date; sessions: AuthSessionStore }
): Promise<AuthenticatedSession | null> {
  if (!token) {
    return null;
  }

  const now = deps.now ?? new Date();
  const session = await deps.sessions.findSessionByTokenHash(hashToken(token));

  if (!session || session.revokedAt || asDate(session.expiresAt) <= now || !isActiveUser(session.user)) {
    return null;
  }

  return {
    expiresAt: asDate(session.expiresAt),
    id: session.id,
    user: session.user,
    userId: session.userId
  };
}

export function createRequestAuthResolver(deps: {
  getConfig: () => AuthConfig;
  now?: () => Date;
  sessions: AuthSessionStore;
}): RequestAuthResolver {
  return async (request) => {
    const config = deps.getConfig();

    if (!config.configured) {
      return null;
    }

    return resolveAuthToken(getSessionFromRequest(request), {
      now: deps.now?.(),
      sessions: deps.sessions
    });
  };
}

export async function createAuthSession(input: {
  now?: Date;
  request?: Request;
  secureCookie: boolean;
  sessions: AuthSessionStore;
  userId: string;
}): Promise<CreatedAuthSession> {
  const prepared = prepareAuthSession(input);
  const session = await input.sessions.createSession({
    ...prepared.input,
    userId: input.userId
  });

  return {
    cookie: prepared.cookie,
    expiresAt: asDate(session.expiresAt),
    sessionId: session.id,
    token: prepared.token
  };
}

export async function revokeRequestSession(input: {
  request: Request;
  revokedReason: string;
  sessions: AuthSessionStore;
}): Promise<number> {
  const token = getSessionFromRequest(input.request);

  if (!token) {
    return 0;
  }

  return input.sessions.revokeSessionByTokenHash({
    revokedAt: new Date(),
    revokedReason: input.revokedReason,
    tokenHash: hashToken(token)
  });
}

export async function revokeUserSessions(input: {
  revokedReason: string;
  sessions: AuthSessionStore;
  userId: string;
}): Promise<number> {
  return (
    (await input.sessions.revokeUserSessions?.({
      revokedAt: new Date(),
      revokedReason: input.revokedReason,
      userId: input.userId
    })) ?? 0
  );
}

export async function deleteExpiredSessions(input: { now?: Date; sessions: AuthSessionStore }): Promise<number> {
  return (await input.sessions.deleteExpiredSessions?.(input.now ?? new Date())) ?? 0;
}
