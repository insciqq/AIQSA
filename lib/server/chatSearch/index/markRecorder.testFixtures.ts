import { Prisma } from "@prisma/client";

/**
 * A recording transaction for the unit tests of the writers that mark past-chat search: every model call and raw
 * statement lands in one ordered log, so a test can prove the mark ran inside the writer's own transaction, after the
 * chat row was locked or written, and for the right chat. Not imported by production code.
 */

export type RecordedCall = Readonly<{
  /** `chat.update`, `$queryRaw`, `$executeRaw`, ... */
  name: string;
  /** The single argument of a model call. */
  args?: unknown;
  /** A raw statement's text (values as `$n`) and values. */
  text?: string;
  values?: readonly unknown[];
}>;

export type ChatSearchMark = Readonly<{ kind: "clear" | "dirty" | "owner"; values: readonly unknown[] }>;

type Handler = (args: unknown) => unknown;

function statement(raw: readonly unknown[]): { text: string; values: readonly unknown[] } {
  const [first, ...rest] = raw;
  const sql = Array.isArray(first) ? Prisma.sql(first as unknown as TemplateStringsArray, ...rest) : first as Prisma.Sql;
  return { text: sql.sql.replace(/\s+/gu, " ").trim(), values: sql.values };
}

/** The past-chat search statement a recorded `$executeRaw` is, if any (`./dirty.ts`). */
export function chatSearchMarkOf(call: RecordedCall): ChatSearchMark | null {
  if (call.name !== "$executeRaw" || !call.text) return null;
  const values = call.values ?? [];
  if (call.text.startsWith("INSERT INTO \"ChatSearchState\"")) return { kind: "dirty", values };
  if (call.text.startsWith("DELETE FROM \"ChatSearchState\"")) return { kind: "clear", values };
  if (call.text.startsWith("UPDATE \"ChatSearchState\"") && call.text.includes("WHERE \"userId\" =")) {
    return { kind: "owner", values };
  }
  return null;
}

export function recordingTransaction(handlers: Readonly<Record<string, Handler>> = {}) {
  const calls: RecordedCall[] = [];
  const raw = (name: "$executeRaw" | "$queryRaw") => async (...args: unknown[]) => {
    const recorded = { name, ...statement(args) };
    calls.push(recorded);
    const handler = handlers[name];
    return handler ? handler(recorded) : name === "$executeRaw" ? 1 : [];
  };
  const models = new Map<string, unknown>();
  const model = (modelName: string) => {
    const existing = models.get(modelName);
    if (existing) return existing;
    const proxy = new Proxy({}, {
      get(_target, method) {
        if (typeof method !== "string" || method === "then") return undefined;
        return async (args: unknown) => {
          const name = `${modelName}.${method}`;
          calls.push({ args, name });
          const handler = handlers[name];
          if (handler) return handler(args);
          if (method === "updateMany" || method === "deleteMany") return { count: 1 };
          if (method === "findMany") return [];
          if (method === "count") return 0;
          return null;
        };
      }
    });
    models.set(modelName, proxy);
    return proxy;
  };
  const tx = new Proxy({}, {
    get(_target, property) {
      if (property === "$executeRaw" || property === "$queryRaw") return raw(property);
      if (typeof property !== "string" || property === "then") return undefined;
      return model(property);
    }
  }) as unknown as Prisma.TransactionClient;
  const transaction = async (work: (value: Prisma.TransactionClient) => unknown) => {
    calls.push({ name: "$transaction" });
    return work(tx);
  };
  return {
    calls,
    /** A client whose `$transaction` runs the work on `tx`; model calls outside it record the same way. */
    client: new Proxy({}, {
      get(_target, property) {
        if (property === "$transaction") return transaction;
        return (tx as unknown as Record<string | symbol, unknown>)[property];
      }
    }),
    marks: () => calls.flatMap((call) => {
      const mark = chatSearchMarkOf(call);
      return mark ? [mark] : [];
    }),
    /** Where in the log the first call of this name is, -1 when none. */
    indexOf: (predicate: (call: RecordedCall) => boolean) => calls.findIndex(predicate),
    tx
  };
}
