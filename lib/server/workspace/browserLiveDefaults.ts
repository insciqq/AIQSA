import { resolveRequestAuth } from "../auth/defaultAuth";
import { prisma } from "../prisma";
import { browserLiveRelay } from "./browserLive";
import { createBrowserLiveHandlers } from "./browserLiveHandlers";

/** The routes' handlers over this process's relay (`browserLive.ts`). */
export const browserLiveHandlers = createBrowserLiveHandlers({
  async authSessionActive({ now, sessionId, userId }) {
    const session = await prisma.authSession.findFirst({
      select: { id: true },
      where: { expiresAt: { gt: now }, id: sessionId, revokedAt: null, user: { status: "active" }, userId }
    });
    return session !== null;
  },
  relay: browserLiveRelay,
  resolveAuth: resolveRequestAuth
});
