import type { RequestAuthResolver } from "../auth/requestAuth";
import { createShareToken, hashShareToken } from "./tokens";
import type { PublicShareSnapshot } from "../../domain/shareSnapshot";

export type ShareRecord = {
  createdAt?: Date | string;
  id: string;
  snapshot: PublicShareSnapshot;
  title: string;
};

export type CreatedShareRecord = ShareRecord & {
  shareToken: string;
};

export type ShareCreateError = {
  error: "grounded_content_not_shareable" | "invalid_active_leaf";
};

export type ChatShareListRecord = {
  createdAt: Date | string;
  id: string;
};

export type ShareRepository = {
  createChatShare(input: {
    activeLeafMessageId: string | null;
    chatId: string;
    shareToken: string;
    slugHash: string;
    userId: string;
  }): Promise<CreatedShareRecord | ShareCreateError | null>;
  findPublicShare(slugHash: string, now: Date): Promise<ShareRecord | null>;
  listChatShares(input: {
    chatId: string;
    now: Date;
    userId: string;
  }): Promise<ChatShareListRecord[]>;
  revokeShare(input: { shareId: string; userId: string }): Promise<boolean>;
};

export type ShareHandlerDeps = {
  repository: ShareRepository;
  resolveAuth: RequestAuthResolver;
};

function serializeShare(record: CreatedShareRecord) {
  return {
    createdAt: record.createdAt instanceof Date ? record.createdAt.toISOString() : record.createdAt,
    id: record.id,
    publicPath: `/s/${record.shareToken}`,
    shareToken: record.shareToken,
    title: record.title
  };
}

function serializePublicShare(record: ShareRecord) {
  return {
    createdAt: record.createdAt instanceof Date ? record.createdAt.toISOString() : record.createdAt,
    id: record.id,
    snapshot: record.snapshot,
    title: record.title
  };
}

async function readJson(request: Request): Promise<Record<string, unknown> | null> {
  try {
    const value = await request.json();
    return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

async function getSession(request: Request, deps: ShareHandlerDeps) {
  const session = await deps.resolveAuth(request);
  if (!session) {
    return {
      response: Response.json({ error: "unauthorized" }, { status: 401 }),
      session: null
    };
  }

  return {
    response: null,
    session
  };
}

export function createShareChatHandler(deps: ShareHandlerDeps) {
  return async function POST(
    request: Request,
    context: { params: Promise<{ chatId: string }> | { chatId: string } }
  ): Promise<Response> {
    const auth = await getSession(request, deps);
    if (!auth.session) {
      return auth.response;
    }

    const params = await context.params;
    const body = await readJson(request);
    const shareToken = createShareToken();
    const share = await deps.repository.createChatShare({
      activeLeafMessageId: typeof body?.activeLeafMessageId === "string" ? body.activeLeafMessageId : null,
      chatId: params.chatId,
      shareToken,
      slugHash: hashShareToken(shareToken),
      userId: auth.session.userId
    });

    if (!share) {
      return Response.json({ error: "chat_not_found_or_empty_branch" }, { status: 404 });
    }

    if ("error" in share) {
      return Response.json({ error: share.error }, { status: 400 });
    }

    return Response.json({
      share: serializeShare(share)
    });
  };
}

export function createListChatSharesHandler(deps: ShareHandlerDeps) {
  return async function GET(
    request: Request,
    context: { params: Promise<{ chatId: string }> | { chatId: string } }
  ): Promise<Response> {
    const auth = await getSession(request, deps);
    if (!auth.session) {
      return auth.response;
    }

    const params = await context.params;
    const shares = await deps.repository.listChatShares({
      chatId: params.chatId,
      now: new Date(),
      userId: auth.session.userId
    });

    return Response.json({
      shares: shares.map((share) => ({
        createdAt:
          share.createdAt instanceof Date ? share.createdAt.toISOString() : share.createdAt,
        id: share.id
      }))
    });
  };
}

export function createGetPublicShareHandler(deps: Pick<ShareHandlerDeps, "repository">) {
  return async function GET(
    _request: Request,
    context: { params: Promise<{ shareToken: string }> | { shareToken: string } }
  ): Promise<Response> {
    const params = await context.params;
    const share = await deps.repository.findPublicShare(hashShareToken(params.shareToken), new Date());

    if (!share) {
      return Response.json({ error: "share_not_found" }, { status: 404 });
    }

    return Response.json({
      share: serializePublicShare(share)
    });
  };
}

export function createRevokeShareHandler(deps: ShareHandlerDeps) {
  return async function POST(
    request: Request,
    context: { params: Promise<{ shareId: string }> | { shareId: string } }
  ): Promise<Response> {
    const auth = await getSession(request, deps);
    if (!auth.session) {
      return auth.response;
    }

    const params = await context.params;
    const revoked = await deps.repository.revokeShare({
      shareId: params.shareId,
      userId: auth.session.userId
    });

    if (!revoked) {
      return Response.json({ error: "share_not_found" }, { status: 404 });
    }

    return Response.json({
      share: {
        id: params.shareId,
        revoked: true
      }
    });
  };
}
