import { isTestAuthEnabled } from "@/lib/server/auth/config";

export const runtime = "nodejs";

function unavailable(): Response {
  return Response.json({ error: "not_found" }, { status: 404 });
}

type TestAuthMailHandlerDeps = Readonly<{
  enabled(): boolean;
  load(): Promise<Readonly<{
    clear(): void;
    list(): readonly Readonly<{ subject: string; text: string; to: string }>[];
  }>>;
}>;

export function createTestAuthMailHandlers(deps: TestAuthMailHandlerDeps) {
  return {
    async DELETE(): Promise<Response> {
      if (!deps.enabled()) {
        return unavailable();
      }

      const sink = await deps.load();
      sink.clear();
      return Response.json({ ok: true });
    },
    async GET(): Promise<Response> {
      if (!deps.enabled()) {
        return unavailable();
      }

      const sink = await deps.load();
      return Response.json({
        emails: sink.list()
      });
    }
  };
}

const handlers = createTestAuthMailHandlers({
  enabled: () => isTestAuthEnabled(),
  async load() {
    const { clearTestAuthEmails, listTestAuthEmails } = await import(
      "@/lib/server/auth/testMailer"
    );
    return {
      clear: clearTestAuthEmails,
      list: listTestAuthEmails
    };
  }
});

export const DELETE = handlers.DELETE;
export const GET = handlers.GET;
