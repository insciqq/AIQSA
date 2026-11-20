import { randomUUID } from "node:crypto";
import { Prisma } from "@prisma/client";

/** A preset row as the store reads it. */
export type FakePresetRow = {
  id: string;
  userId: string;
  name: string;
  systemInstructions: string;
  responseReminder: string;
  answerRules: string | null;
  revision: number;
  createdAt: Date;
  updatedAt: Date;
};
type Settings = { activeInstructionPresetId: string | null; instructionSelectionVersion: number };
type Select = Readonly<Record<string, unknown>> | undefined;

function pick<T extends Record<string, unknown>>(row: T, select: Select): Record<string, unknown> {
  if (!select) return { ...row };
  return Object.fromEntries(Object.keys(select).filter((key) => select[key] === true).map((key) => [key, row[key]]));
}

/**
 * Just enough of `user`, `userSettings`, `instructionPreset`, `$queryRaw` and
 * `$transaction` for the instructions store and the agent's service, with
 * rollback: a transaction that throws leaves the rows as they were.
 */
export function fakeInstructionDb(input: Readonly<{ activeUsers: readonly string[] }>) {
  const state = { presets: [] as FakePresetRow[], settings: new Map<string, Settings>() };
  let tick = 0;
  const now = () => new Date(Date.UTC(2026, 10, 20, 9, 0, tick++));
  const active = (userId: unknown) => typeof userId === "string" && input.activeUsers.includes(userId);
  const presetOf = (userId: string, id: string) => state.presets.find((row) => row.userId === userId && row.id === id);

  const instructionPreset = {
    count: async ({ where }: { where: { userId: string } }) => state.presets.filter((row) => row.userId === where.userId).length,
    create: async ({ data, select }: { data: Partial<FakePresetRow> & { userId: string; name: string }; select?: Select }) => {
      if (state.presets.some((row) => row.userId === data.userId && row.name === data.name)) {
        throw new Prisma.PrismaClientKnownRequestError("unique", { clientVersion: "test", code: "P2002" });
      }
      const at = now();
      const row: FakePresetRow = { answerRules: null, createdAt: at, id: randomUUID(), responseReminder: "", revision: 1, systemInstructions: "",
        updatedAt: at, ...data };
      state.presets.push(row);
      return pick(row, select);
    },
    delete: async ({ where }: { where: { userId_id: { userId: string; id: string } } }) => {
      const index = state.presets.findIndex((row) => row.userId === where.userId_id.userId && row.id === where.userId_id.id);
      if (index < 0) throw new Error("fake preset missing");
      const [row] = state.presets.splice(index, 1);
      for (const settings of state.settings.values()) if (settings.activeInstructionPresetId === row!.id) settings.activeInstructionPresetId = null;
    },
    findFirst: async ({ where, select }: { where: { id: string; userId: string; user?: { status: string } }; select?: Select }) => {
      const row = presetOf(where.userId, where.id);
      return row && (!where.user || active(where.userId)) ? pick(row, select) : null;
    },
    findMany: async ({ where, select }: { where: { userId: string }; select?: Select }) =>
      state.presets.filter((row) => row.userId === where.userId).map((row) => pick(row, select)),
    findUnique: async ({ where, select }: { where: { userId_id: { userId: string; id: string } }; select?: Select }) => {
      const row = presetOf(where.userId_id.userId, where.userId_id.id);
      return row ? pick(row, select) : null;
    },
    update: async ({ where, data, select }: { where: { userId_id: { userId: string; id: string } }; data: Record<string, unknown>; select?: Select }) => {
      const row = presetOf(where.userId_id.userId, where.userId_id.id);
      if (!row) throw new Error("fake preset missing");
      const { revision, ...fields } = data;
      Object.assign(row, fields, revision ? { revision: row.revision + 1 } : {}, { updatedAt: now() });
      return pick(row, select);
    }
  };

  const settingsOf = (userId: string) => state.settings.get(userId) ?? null;
  const userSettings = {
    findUnique: async ({ where }: { where: { userId: string } }) => {
      const settings = settingsOf(where.userId);
      if (!settings) return null;
      const preset = settings.activeInstructionPresetId ? state.presets.find((row) => row.id === settings.activeInstructionPresetId) : undefined;
      return { ...settings, activeInstructionPreset: preset ? { ...preset } : null };
    },
    update: async ({ where, data }: { where: { userId: string }; data: Record<string, unknown> }) => {
      const settings = settingsOf(where.userId)!;
      if ("activeInstructionPresetId" in data) settings.activeInstructionPresetId = data.activeInstructionPresetId as string | null;
      if (data.instructionSelectionVersion) settings.instructionSelectionVersion += 1;
      return { ...settings };
    },
    upsert: async ({ where }: { where: { userId: string } }) => {
      if (!state.settings.has(where.userId)) state.settings.set(where.userId, { activeInstructionPresetId: null, instructionSelectionVersion: 0 });
      return { ...settingsOf(where.userId)! };
    }
  };

  const user = {
    findFirst: async ({ where }: { where: { id: string } }) => active(where.id) ? { id: where.id } : null,
    // The store's list, with its nested reads.
    findUnique: async ({ where }: { where: { id: string } }) => {
      if (!active(where.id)) return null;
      const presets = state.presets.filter((row) => row.userId === where.id)
        .map(({ id, name, revision, systemInstructions, updatedAt }) => ({ id, name, revision, systemInstructions, updatedAt }));
      return { instructionPresets: presets, settings: settingsOf(where.id) };
    }
  };

  /** The owner lock: the user id is the statement's one value. */
  const $queryRaw = async (sql: Prisma.Sql) => active(sql.values[0]) ? [{ id: sql.values[0] }] : [];
  const client = { $queryRaw, instructionPreset, user, userSettings };
  const db = {
    ...client,
    $transaction: async <Value>(change: (tx: typeof client) => Promise<Value>) => {
      const saved = { presets: state.presets.map((row) => ({ ...row })), settings: new Map([...state.settings].map(([key, value]) => [key, { ...value }])) };
      try {
        return await change(client);
      } catch (error) {
        state.presets = saved.presets;
        state.settings = saved.settings;
        throw error;
      }
    }
  };
  return { db: db as never, state };
}
