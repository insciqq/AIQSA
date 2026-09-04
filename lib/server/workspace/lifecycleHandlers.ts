import type { RequestAuthResolver } from "@/lib/server/auth/requestAuth";
import type { WorkspaceLifecycleService } from "./lifecycle";
import { WorkspaceLifecycleError } from "./lifecycle";

const PRIVATE_NO_STORE = "private, no-store, max-age=0";

function json(value: unknown, status = 200): Response {
  return Response.json(value, {
    headers: { "cache-control": PRIVATE_NO_STORE },
    status
  });
}

function failure(error: unknown): Response {
  if (error instanceof WorkspaceLifecycleError) {
    return json({ error: error.code }, error.status);
  }
  console.error("workspace_lifecycle_action_failed");
  return json({ error: "workspace_runtime_unavailable" }, 503);
}

export function createWorkspaceLifecycleHandlers(input: Readonly<{
  resolveAuth: RequestAuthResolver;
  service: WorkspaceLifecycleService;
}>) {
  async function authenticated(request: Request) {
    const session = await input.resolveAuth(request);
    return session?.user.status === "active" ? session : null;
  }

  return {
    async archive(
      request: Request,
      context: { params: Promise<{ chatId: string }> | { chatId: string } }
    ): Promise<Response> {
      const session = await authenticated(request);
      if (!session) return json({ error: "unauthorized" }, 401);
      const { chatId } = await context.params;
      try {
        return json({
          file: await input.service.archive({ chatId, userId: session.userId })
        });
      } catch (error) {
        return failure(error);
      }
    },
    async reset(
      request: Request,
      context: { params: Promise<{ chatId: string }> | { chatId: string } }
    ): Promise<Response> {
      const session = await authenticated(request);
      if (!session) return json({ error: "unauthorized" }, 401);
      const { chatId } = await context.params;
      try {
        return json({
          workspace: await input.service.reset({ chatId, userId: session.userId })
        });
      } catch (error) {
        return failure(error);
      }
    },
    async status(
      request: Request,
      context: { params: Promise<{ chatId: string }> | { chatId: string } }
    ): Promise<Response> {
      const session = await authenticated(request);
      if (!session) return json({ error: "unauthorized" }, 401);
      const { chatId } = await context.params;
      try {
        return json({
          workspace: await input.service.status({ chatId, userId: session.userId })
        });
      } catch (error) {
        return failure(error);
      }
    }
  };
}
