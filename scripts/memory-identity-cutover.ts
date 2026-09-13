import "./worker-bootstrap.cjs";
import { maintenanceFailureCode } from "./maintenance-observability";
import { logEvent } from "../lib/server/observability";
import { prisma } from "../lib/server/prisma";
import { createPrismaMemoryIdentityCutoverRepository } from
  "../lib/server/memory/learning/identity/cutover";

function argument(name: string): string | null {
  const prefix = `--${name}=`;
  const values = process.argv.slice(2).filter((value) => value.startsWith(prefix));
  return values.length === 1 ? values[0]!.slice(prefix.length) : null;
}

function validUserId(value: string | null): value is string {
  return value !== null && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u.test(value);
}

async function main(): Promise<void> {
  const operation = argument("operation");
  const userId = argument("user-id");
  if (![
    "inventory",
    "inventory-all",
    "preflight",
    "reconcile"
  ].includes(operation ?? "") || (
    operation !== "inventory-all" && !validUserId(userId)
  )) {
    throw new Error("memory_identity_cutover_arguments_invalid");
  }
  const repository = createPrismaMemoryIdentityCutoverRepository(prisma);
  if (operation === "inventory-all") {
    const inventory = await repository.inventoryAll();
    console.log(JSON.stringify({ inventory, operation }));
    return;
  }
  if (!validUserId(userId)) {
    throw new Error("memory_identity_cutover_arguments_invalid");
  }
  if (operation === "reconcile") {
    const result = await repository.reconcile(userId);
    console.log(JSON.stringify({ operation, result }));
    return;
  }
  const inventory = operation === "preflight"
    ? await repository.assertActivationReady(userId)
    : await repository.inventory(userId);
  console.log(JSON.stringify({ inventory, operation }));
}

void main().catch((error: unknown) => {
  logEvent("runtime_lifecycle", { subsystem: "memory", stage: "preflight", outcome: "failed", code: maintenanceFailureCode(error, "memory_identity_cutover_failed"), action: "stop" });
  process.exitCode = 1;
}).finally(async () => {
  await prisma.$disconnect().catch(() => undefined);
});
