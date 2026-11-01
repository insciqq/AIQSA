import { randomUUID } from "node:crypto";
import { Prisma, type NetworkProxy } from "@prisma/client";

type Where = Readonly<Record<string, unknown>>;

function matches(row: NetworkProxy, where: Where = {}): boolean {
  return Object.entries(where).every(([key, expected]) => {
    if (key === "OR") return (expected as Where[]).some((branch) => matches(row, branch));
    const actual = row[key as keyof NetworkProxy];
    if (typeof expected === "object" && expected !== null && "in" in expected) return (expected as { in: unknown[] }).in.includes(actual);
    return actual === expected;
  });
}

/** Just enough of `networkProxy`, `user` and `$transaction` for the store's rules, in order of insertion. */
export function fakeProxyDb(input: Readonly<{ activeUsers: readonly string[] }>) {
  const rows: NetworkProxy[] = [];
  let tick = 0;
  const networkProxy = {
    count: async ({ where }: { where: Where }) => rows.filter((row) => matches(row, where)).length,
    create: async ({ data }: { data: Partial<NetworkProxy> }) => {
      if (rows.some((row) => row.userId === data.userId && row.name.toLowerCase() === data.name?.toLowerCase())) {
        throw new Prisma.PrismaClientKnownRequestError("unique", { clientVersion: "test", code: "P2002" });
      }
      tick += 1;
      const row = { active: true, country: null, createdAt: new Date(tick), domainHints: [], id: randomUUID(), lastCheckedAt: null, lastCheckStatus: null,
        lastExitAddress: null, login: null, passwordEnvelope: null, updatedAt: new Date(tick), userId: null, version: 1, ...data } as NetworkProxy;
      rows.push(row);
      return { ...row };
    },
    delete: async ({ where }: { where: { id: string } }) => {
      rows.splice(rows.findIndex((row) => row.id === where.id), 1);
    },
    findFirst: async ({ where }: { where: Where }) => {
      const row = rows.find((candidate) => matches(candidate, where));
      return row ? { ...row } : null;
    },
    findMany: async ({ where }: { where: Where }) => rows.filter((row) => matches(row, where)).map((row) => ({ ...row })),
    update: async ({ data, where }: { data: Record<string, unknown>; where: { id: string } }) => {
      const row = rows.find((candidate) => candidate.id === where.id)!;
      const { version, ...fields } = data;
      Object.assign(row, fields, version ? { version: row.version + 1 } : {});
      return { ...row };
    },
    updateMany: async ({ data, where }: { data: Record<string, unknown>; where: Where }) => {
      const hit = rows.filter((row) => matches(row, where));
      for (const row of hit) Object.assign(row, data);
      return { count: hit.length };
    }
  };
  const user = {
    findFirst: async ({ where }: { where: { id: string; status: string } }) => input.activeUsers.includes(where.id) ? { id: where.id } : null
  };
  const client = { $queryRaw: async () => [], networkProxy, user };
  const db = { ...client, $transaction: async <Value>(change: (tx: typeof client) => Promise<Value>) => change(client) };
  return { db: db as never, rows };
}
