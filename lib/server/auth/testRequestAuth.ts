import { createSessionSetCookie, readCookie, SESSION_COOKIE_NAME } from "./session";
import type {
  AuthenticatedSession,
  AuthenticatedUser,
  AuthSessionRecord,
  AuthSessionStore,
  CreateAuthSessionInput,
  RequestAuthResolver
} from "./requestAuth";
import type {
  PasswordAuthRepository,
  PasswordIdentityRecord,
  PasswordResetTokenInput
} from "./passwordRepository";

const defaultExpiresAt = new Date("2099-01-01T00:00:00.000Z");

export function createTestUser(input: Partial<AuthenticatedUser> = {}): AuthenticatedUser {
  return {
    displayName: "Local Operator",
    email: "operator@aiqsa.local",
    id: "00000000-0000-4000-8000-000000000001",
    role: "admin",
    status: "active",
    ...input
  };
}

export function createTestAuth(input: {
  sessionId?: string;
  token?: string;
  user?: Partial<AuthenticatedUser>;
} = {}): {
  cookie: string;
  resolveAuth: RequestAuthResolver;
  session: AuthenticatedSession;
  token: string;
} {
  const token = input.token ?? "test-session-token";
  const user = createTestUser(input.user);
  const session: AuthenticatedSession = {
    expiresAt: defaultExpiresAt,
    id: input.sessionId ?? "test-session-id",
    user,
    userId: user.id
  };

  return {
    cookie: createSessionSetCookie(token),
    resolveAuth: async (request) =>
      readCookie(request.headers.get("cookie"), SESSION_COOKIE_NAME) === token ? session : null,
    session,
    token
  };
}

export function createMemoryAuthSessionStore(input: {
  now?: Date;
  user?: AuthenticatedUser;
} = {}): AuthSessionStore & {
  records: Map<string, AuthSessionRecord & { tokenHash: string }>;
} {
  const records = new Map<string, AuthSessionRecord & { tokenHash: string }>();
  const user = input.user ?? createTestUser();

  return {
    records,
    async createSession(sessionInput: CreateAuthSessionInput) {
      const record = {
        expiresAt: sessionInput.expiresAt,
        id: `session-${records.size + 1}`,
        revokedAt: null,
        tokenHash: sessionInput.tokenHash,
        user,
        userId: sessionInput.userId
      };
      records.set(sessionInput.tokenHash, record);

      return record;
    },
    async deleteExpiredSessions(now) {
      let deleted = 0;
      for (const [tokenHash, record] of records) {
        if (new Date(record.expiresAt) < now) {
          records.delete(tokenHash);
          deleted += 1;
        }
      }

      return deleted;
    },
    async findSessionByTokenHash(tokenHash) {
      return records.get(tokenHash) ?? null;
    },
    async revokeSessionByTokenHash(input) {
      const record = records.get(input.tokenHash);
      if (!record || record.revokedAt) {
        return 0;
      }

      record.revokedAt = input.revokedAt;
      return 1;
    },
    async revokeUserSessions(input) {
      let revoked = 0;
      for (const record of records.values()) {
        if (record.userId === input.userId && !record.revokedAt) {
          record.revokedAt = input.revokedAt;
          revoked += 1;
        }
      }

      return revoked;
    }
  };
}

export function createTestPasswordIdentity(input: {
  emailVerifiedAt?: Date | null;
  id?: string;
  normalizedEmail?: string;
  passwordHash?: string | null;
  user?: Partial<AuthenticatedUser>;
} = {}): PasswordIdentityRecord {
  const normalizedEmail = input.normalizedEmail ?? "operator@aiqsa.local";
  const user = createTestUser({
    email: normalizedEmail,
    ...input.user
  });

  return {
    emailVerifiedAt: input.emailVerifiedAt === undefined ? new Date("2026-06-14T00:00:00.000Z") : input.emailVerifiedAt,
    id: input.id ?? "identity-1",
    normalizedEmail,
    passwordHash: input.passwordHash ?? null,
    user,
    userId: user.id
  };
}

export function createMemoryPasswordAuthRepository(input: {
  identity?: PasswordIdentityRecord | null;
} = {}): PasswordAuthRepository & {
  loginSessions: Map<string, CreateAuthSessionInput>;
  identity: PasswordIdentityRecord | null;
  resetTokens: Map<string, PasswordResetTokenInput & { consumedAt: Date | null }>;
} {
  const resetTokens = new Map<string, PasswordResetTokenInput & { consumedAt: Date | null }>();
  const loginSessions = new Map<string, CreateAuthSessionInput>();
  const repository: PasswordAuthRepository & {
    loginSessions: Map<string, CreateAuthSessionInput>;
    identity: PasswordIdentityRecord | null;
    resetTokens: Map<string, PasswordResetTokenInput & { consumedAt: Date | null }>;
  } = {
    identity: input.identity === undefined ? createTestPasswordIdentity() : input.identity,
    loginSessions,
    resetTokens,
    async createSessionForCurrentPassword(sessionInput) {
      const currentIdentity = repository.identity;

      if (
        !currentIdentity?.emailVerifiedAt ||
        currentIdentity.id !== sessionInput.identityId ||
        currentIdentity.passwordHash !== sessionInput.passwordHash ||
        currentIdentity.user.status !== "active"
      ) {
        return null;
      }

      loginSessions.set(sessionInput.session.tokenHash, {
        ...sessionInput.session,
        userId: currentIdentity.userId
      });

      return {
        user: currentIdentity.user
      };
    },
    async completePasswordReset(resetInput) {
      const token = resetTokens.get(resetInput.tokenHash);
      const currentIdentity = repository.identity;

      if (
        !token ||
        token.consumedAt ||
        token.expiresAt <= resetInput.now ||
        !currentIdentity?.emailVerifiedAt ||
        currentIdentity.user.status !== "active" ||
        currentIdentity.id !== token.identityId
      ) {
        return null;
      }

      for (const sibling of resetTokens.values()) {
        if (
          sibling.identityId === currentIdentity.id &&
          sibling.userId === currentIdentity.userId &&
          !sibling.consumedAt
        ) {
          sibling.consumedAt = resetInput.now;
        }
      }
      currentIdentity.passwordHash = resetInput.passwordHash;

      return {
        userId: currentIdentity.userId
      };
    },
    async createPasswordResetToken(tokenInput) {
      resetTokens.set(tokenInput.tokenHash, {
        ...tokenInput,
        consumedAt: null
      });
    },
    async findPasswordIdentityByEmail(normalizedEmail) {
      return repository.identity?.normalizedEmail === normalizedEmail ? repository.identity : null;
    }
  };

  return repository;
}
