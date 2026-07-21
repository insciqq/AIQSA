import { clearTestAuthEmails, listTestAuthEmails } from "@/lib/server/auth/testMailer";
import { isTestAuthEnabled } from "@/lib/server/auth/config";

export const runtime = "nodejs";

function unavailable(): Response {
  return Response.json({ error: "not_found" }, { status: 404 });
}

type TestAuthMailHandlerDeps = Readonly<{
  clear(): void;
  enabled(): boolean;
  list(): ReturnType<typeof listTestAuthEmails>;
}>;

export function createTestAuthMailHandlers(deps: TestAuthMailHandlerDeps) {
  return {
    async DELETE(): Promise<Response> {
      if (!deps.enabled()) {
        return unavailable();
      }

      deps.clear();
      return Response.json({ ok: true });
    },
    async GET(): Promise<Response> {
      if (!deps.enabled()) {
        return unavailable();
      }

      return Response.json({
        emails: deps.list()
      });
    }
  };
}

const handlers = createTestAuthMailHandlers({
  clear: clearTestAuthEmails,
  enabled: () => isTestAuthEnabled(),
  list: listTestAuthEmails
});

export const DELETE = handlers.DELETE;
export const GET = handlers.GET;
