import { Prisma, type PrismaClient } from "@prisma/client";
import {
  INSTRUCTION_PRESET_MAX_COUNT, decodeInstructionPresetMutation,
  type InstructionPreset, type InstructionPresetMutation, type InstructionPresetState
} from "../../contracts/instructionPresets";

export class InstructionPresetError extends Error {
  constructor(readonly code: "instruction_preset_invalid" | "instruction_preset_not_found" |
    "instruction_preset_conflict" | "instruction_selection_conflict" | "instruction_preset_name_conflict" |
    "instruction_preset_limit" | "instruction_presets_unavailable") { super(code); }
}
export type InstructionPresetSelection = Readonly<{
  presetId: string | null;
  revision: number | null;
  selectionVersion: number;
}>;
export type PersonalInstructionSnapshot = InstructionPresetSelection & Readonly<{
  systemInstructions: string;
  responseReminder: string;
}>;
export interface InstructionPresetStore {
  list(userId: string): Promise<InstructionPresetState>;
  get(userId: string, id: string): Promise<InstructionPreset | null>;
  mutate(userId: string, mutation: InstructionPresetMutation): Promise<void>;
  resolveForRun(userId: string): Promise<PersonalInstructionSnapshot>;
}

async function lockOwner(tx: Prisma.TransactionClient, userId: string, write: boolean): Promise<void> {
  // The no-op owner write also invalidates a repeatable-read admission that
  // waited on a concurrent edit: it must retry, never admit stale instructions.
  const owners = await tx.$queryRaw<Array<{ id: string }>>(write
    ? Prisma.sql`UPDATE "User" SET "id" = "id" WHERE "id" = ${userId} AND "status" = 'active' RETURNING "id"`
    : Prisma.sql`SELECT "id" FROM "User" WHERE "id" = ${userId} AND "status" = 'active' FOR UPDATE`);
  if (owners.length !== 1) throw new InstructionPresetError("instruction_presets_unavailable");
}

async function resolveSnapshot(client: Pick<Prisma.TransactionClient, "userSettings">, userId: string): Promise<PersonalInstructionSnapshot> {
  const settings = await client.userSettings.findUnique({
    where: { userId },
    select: { activeInstructionPresetId: true, instructionSelectionVersion: true,
      activeInstructionPreset: { select: { id: true, userId: true, revision: true, systemInstructions: true, responseReminder: true } } }
  });
  const preset = settings?.activeInstructionPreset;
  if (settings?.activeInstructionPresetId && (!preset || preset.userId !== userId)) {
    throw new InstructionPresetError("instruction_selection_conflict");
  }
  return {
    presetId: preset?.id ?? null, revision: preset?.revision ?? null,
    selectionVersion: settings?.instructionSelectionVersion ?? 0,
    systemInstructions: preset?.systemInstructions ?? "", responseReminder: preset?.responseReminder ?? ""
  };
}

/** Initial durable acceptance only. Preparation/recovery use their snapshot. */
export async function assertInstructionPresetSelection(
  tx: Prisma.TransactionClient, userId: string, accepted: InstructionPresetSelection
): Promise<void> {
  await lockOwner(tx, userId, false);
  const current = await resolveSnapshot(tx, userId);
  if (current.presetId !== accepted.presetId || current.revision !== accepted.revision ||
    current.selectionVersion !== accepted.selectionVersion) throw new InstructionPresetError("instruction_selection_conflict");
}

const detailSelect = {
  id: true, name: true, systemInstructions: true, responseReminder: true, revision: true, updatedAt: true
} as const;

export function createInstructionPresetStore(prisma: PrismaClient): InstructionPresetStore {
  return {
    async list(userId) {
      return prisma.$transaction(async (tx) => {
        const user = await tx.user.findUnique({ where: { id: userId, status: "active" }, select: {
          settings: { select: { activeInstructionPresetId: true, instructionSelectionVersion: true } },
          instructionPresets: { select: { id: true, name: true, systemInstructions: true, revision: true, updatedAt: true }, orderBy: [{ createdAt: "asc" }, { id: "asc" }] }
        } });
        if (!user) throw new InstructionPresetError("instruction_presets_unavailable");
        return {
          activePresetId: user.settings?.activeInstructionPresetId ?? null,
          selectionVersion: user.settings?.instructionSelectionVersion ?? 0,
          presets: user.instructionPresets.map(({ systemInstructions, updatedAt, ...row }) => ({
            ...row, firstLine: systemInstructions.split(/\r?\n/u, 1)[0].slice(0, 160), updatedAt: updatedAt.toISOString()
          }))
        };
      }, { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead });
    },
    async get(userId, id) {
      const row = await prisma.instructionPreset.findFirst({ where: { id, userId, user: { status: "active" } }, select: detailSelect });
      return row ? { ...row, updatedAt: row.updatedAt.toISOString() } : null;
    },
    async resolveForRun(userId) {
      return prisma.$transaction((tx) => resolveSnapshot(tx, userId), { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead });
    },
    async mutate(userId, input) {
      const mutation = decodeInstructionPresetMutation(input);
      if (!mutation) throw new InstructionPresetError("instruction_preset_invalid");
      try {
        await prisma.$transaction(async (tx) => {
          await lockOwner(tx, userId, true);
          const settings = await tx.userSettings.upsert({ where: { userId }, create: { userId }, update: {},
            select: { activeInstructionPresetId: true, instructionSelectionVersion: true } });
          if (mutation.action === "select") {
            if (mutation.selectionVersion !== settings.instructionSelectionVersion) throw new InstructionPresetError("instruction_selection_conflict");
            if (mutation.id !== null && !await tx.instructionPreset.findUnique({ where: { userId_id: { userId, id: mutation.id } }, select: { id: true } })) {
              throw new InstructionPresetError("instruction_preset_not_found");
            }
            await tx.userSettings.update({ where: { userId }, data: { activeInstructionPresetId: mutation.id, instructionSelectionVersion: { increment: 1 } } });
            return;
          }
          if (mutation.action === "create") {
            if (await tx.instructionPreset.count({ where: { userId } }) >= INSTRUCTION_PRESET_MAX_COUNT) throw new InstructionPresetError("instruction_preset_limit");
            await tx.instructionPreset.create({ data: { userId, ...mutation.value } });
            return;
          }
          const preset = await tx.instructionPreset.findUnique({ where: { userId_id: { userId, id: mutation.id } }, select: { revision: true } });
          if (!preset) throw new InstructionPresetError("instruction_preset_not_found");
          if (preset.revision !== mutation.revision) throw new InstructionPresetError("instruction_preset_conflict");
          if (mutation.action === "update") {
            await tx.instructionPreset.update({ where: { userId_id: { userId, id: mutation.id } }, data: { ...mutation.value, revision: { increment: 1 } } });
          } else {
            if (settings.activeInstructionPresetId === mutation.id) await tx.userSettings.update({ where: { userId }, data: {
              activeInstructionPresetId: null, instructionSelectionVersion: { increment: 1 }
            } });
            await tx.instructionPreset.delete({ where: { userId_id: { userId, id: mutation.id } } });
          }
        });
      } catch (error) {
        if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
          throw new InstructionPresetError("instruction_preset_name_conflict");
        }
        throw error;
      }
    }
  };
}
