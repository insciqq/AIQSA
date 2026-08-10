import {
  loadMemorySuppressionKeyring,
  MEMORY_SUPPRESSION_GUARDED_OPERATIONS,
  preflightMemorySuppressionKeys,
  type MemorySuppressionPreflightOperation
} from "../lib/server/memory/suppressionKeyring";

function parseOperation(value: string): MemorySuppressionPreflightOperation | null {
  if (value === "restore") return value;
  return MEMORY_SUPPRESSION_GUARDED_OPERATIONS.find((operation) => operation === value) ?? null;
}

function main(): void {
  const [operationValue, requiredKeyIdsValue, ...extra] = process.argv.slice(2);
  const operation = operationValue ? parseOperation(operationValue) : null;
  if (!operation || requiredKeyIdsValue === undefined || extra.length > 0) {
    console.error(
      "AIQSA Memory suppression preflight unavailable: memory_suppression_preflight_arguments_invalid"
    );
    process.exitCode = 2;
    return;
  }

  const requiredKeyIds = requiredKeyIdsValue === ""
    ? []
    : requiredKeyIdsValue.split(",");
  const result = preflightMemorySuppressionKeys(
    loadMemorySuppressionKeyring(),
    requiredKeyIds,
    operation
  );
  if (result.status === "blocked") {
    console.error(`AIQSA Memory suppression preflight unavailable: ${result.code}`);
    process.exitCode = 1;
    return;
  }
  console.error(`AIQSA Memory suppression preflight passed: ${operation}`);
}

main();
