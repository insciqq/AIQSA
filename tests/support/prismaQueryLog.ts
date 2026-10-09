import { PrismaClient, type Prisma } from "@prisma/client";

const BARRIER = "aiqsa_query_log_barrier";

/** A client that reports every SQL statement it sends, relation loads included.
 * Prisma delivers query events through its logger callback, which can run after
 * the awaited call resolves; the events share one ordered channel, so `settle`
 * sends a marker statement and returns once its event arrives, after every
 * earlier statement's. The marker itself is never reported. */
export function createQueryLoggingClient(onQuery: (event: Prisma.QueryEvent) => void = () => undefined) {
  const client = new PrismaClient({ log: [{ emit: "event", level: "query" }] });
  const waiting: Array<() => void> = [];
  client.$on("query", (event) => {
    if (event.query.includes(BARRIER)) waiting.shift()?.();
    else onQuery(event);
  });
  const settle = async (): Promise<void> => {
    const arrived = new Promise<void>((resolve) => { waiting.push(resolve); });
    await client.$queryRaw`SELECT 1 AS aiqsa_query_log_barrier`;
    await arrived;
  };
  // The event-logging generics narrow nothing callers use; repositories take the plain client.
  return { client: client as unknown as PrismaClient, settle };
}

/** Counts statements between `reset` and `count`, each settled first so a late
 * event from an earlier call is neither counted nor missed. */
export function createQueryCountingClient() {
  let statements = 0;
  const { client, settle } = createQueryLoggingClient(() => { statements += 1; });
  return {
    client,
    async reset(): Promise<void> {
      await settle();
      statements = 0;
    },
    async count(): Promise<number> {
      await settle();
      return statements;
    }
  };
}
