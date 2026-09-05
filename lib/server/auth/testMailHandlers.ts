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
