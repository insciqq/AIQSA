import type { WorkspaceExportPage } from "../../contracts/workspaceExports";
import type { RequestAuthResolver } from "../auth/requestAuth";

export type WorkspaceExportHistoryRepository = Readonly<{
  list(input: { chatId: string; cursor: string | null; userId: string }): Promise<WorkspaceExportPage | null>;
}>;

export function createWorkspaceExportHistoryHandler(input: {
  repository: WorkspaceExportHistoryRepository;
  resolveAuth: RequestAuthResolver;
}) {
  return async (request: Request, context: { params: Promise<{ chatId: string }> | { chatId: string } }) => {
    const auth = await input.resolveAuth(request);
    if (!auth) return Response.json({ error: "unauthorized" }, { status: 401 });
    const { chatId } = await context.params;
    const cursor = new URL(request.url).searchParams.get("cursor");
    if (typeof chatId !== "string" || !chatId || chatId.length > 128 ||
      (cursor !== null && (!cursor || cursor.length > 128))) {
      return Response.json({ error: "invalid_request" }, { status: 400 });
    }
    const page = await input.repository.list({ chatId, cursor, userId: auth.userId });
    return page
      ? Response.json(page, { headers: { "cache-control": "no-store" } })
      : Response.json({ error: "chat_not_found" }, { status: 404 });
  };
}
