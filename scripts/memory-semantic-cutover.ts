import { prisma } from "../lib/server/prisma";
import {
  decideMemorySemanticCutover,
  loadMemorySemanticCutoverInventory,
  type MemorySemanticCutoverDisposition
} from "../lib/server/memory/operational/cutover";
import { loadMemoryOperationalSnapshot } from
  "../lib/server/memory/operational/snapshot";

const dispositions = Object.freeze({
  "preproduction-purge-reset": "PREPRODUCTION_PURGE_RESET",
  "reprocess-required": "REPROCESS_REQUIRED",
  "retained-dormant-excluded": "RETAINED_DORMANT_EXCLUDED",
  "retained-operator-review": "RETAINED_OPERATOR_REVIEW",
  "zero-noop": "ZERO_NOOP"
} as const satisfies Record<string, MemorySemanticCutoverDisposition>);

function argument(name: string): string | null {
  const prefix = `--${name}=`;
  const values = process.argv.slice(2).filter((value) => value.startsWith(prefix));
  if (values.length !== 1) return null;
  return values[0]!.slice(prefix.length);
}

function disposition(): MemorySemanticCutoverDisposition | null {
  const value = argument("disposition");
  return value && value in dispositions
    ? dispositions[value as keyof typeof dispositions]
    : null;
}

function windowHours(): number | null {
  const value = argument("window-hours") ?? "24";
  if (!/^(?:[1-9]|[1-9][0-9]|[1-6][0-9]{2}|7[0-3][0-9]|74[0-4])$/u.test(value)) {
    return null;
  }
  return Number(value);
}

async function main(): Promise<void> {
  const selectedDisposition = disposition();
  const hours = windowHours();
  const expectedArguments = process.argv.slice(2).every((value) =>
    value.startsWith("--disposition=") || value.startsWith("--window-hours="));
  if (!selectedDisposition || !hours || !expectedArguments) {
    console.error(
      "AIQSA Memory semantic cutover blocked: memory_cutover_arguments_invalid"
    );
    process.exitCode = 2;
    return;
  }
  const to = new Date();
  const from = new Date(to.getTime() - hours * 60 * 60_000);
  const [inventory, operational] = await Promise.all([
    loadMemorySemanticCutoverInventory(prisma),
    loadMemoryOperationalSnapshot(prisma, { from, to })
  ]);
  const decision = decideMemorySemanticCutover(inventory, selectedDisposition);
  console.log(JSON.stringify({ decision, inventory, operational }));
  if (decision.status !== "READY") process.exitCode = 2;
}

void main().catch(() => {
  console.error(
    "AIQSA Memory semantic cutover blocked: memory_cutover_inventory_unavailable"
  );
  process.exitCode = 1;
}).finally(async () => {
  await prisma.$disconnect().catch(() => undefined);
});
