import type { RequestAuthResolver } from "@/lib/server/auth/requestAuth";
import type { WorkspaceAvailabilityService } from "./availability";

const PRIVATE_NO_STORE = "private, no-store, max-age=0";

/** Installation-level readiness for a blank composer. Model compatibility is
 * intentionally projected in the client from the selected catalog model. */
export function createWorkspaceAvailabilityHandler(input: Readonly<{
  availability: WorkspaceAvailabilityService;
  resolveAuth: RequestAuthResolver;
}>) {
  return async function GET(request: Request): Promise<Response> {
    const auth = await input.resolveAuth(request);
    if (!auth || auth.user.status !== "active") {
      return Response.json({ error: "unauthorized" }, { status: 401 });
    }

    const snapshot = await input.availability.snapshot();
    return Response.json({
      workspace: input.availability.project(snapshot, {
        enabled: false,
        modelSupportsTools: true,
        session: null
      })
    }, {
      headers: { "cache-control": PRIVATE_NO_STORE }
    });
  };
}
