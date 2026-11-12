import type { RequestAuthResolver } from "../auth/requestAuth";
import { prisma } from "../prisma";

/**
 * The resolver a connector's in-process requests present to the product's
 * own handlers (send, follow-up, uploads, …): the user while the account is
 * active and the connector's own access check holds, both re-read on every
 * call (the send handler calls it again during preparation). The session it
 * names is the connector's (`sessionId`), never a browser session.
 */
export function connectorRequestAuth(input: Readonly<{
  /** The session id the handlers see, such as `telegram`. */
  sessionId: string;
  userId: string;
  /** Whether the connector still serves this user now (access, the connector switched on, the account's kind). */
  allowed(): Promise<boolean>;
}>): RequestAuthResolver {
  return async () => {
    const [user, allowed] = await Promise.all([
      prisma.user.findUnique({ select: { displayName: true, email: true, id: true, role: true, status: true }, where: { id: input.userId } }),
      input.allowed()
    ]);
    return user && user.status === "active" && allowed
      ? { expiresAt: new Date(Date.now() + 60_000), id: input.sessionId, user, userId: user.id }
      : null;
  };
}
