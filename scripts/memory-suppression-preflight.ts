import "./worker-bootstrap.cjs";
import { logEvent } from "../lib/server/observability";
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
    logEvent("runtime_lifecycle", { subsystem: "memory", stage: "preflight", outcome: "failed", code: "memory_suppression_preflight_arguments_invalid", action: "stop" });
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
    logEvent("runtime_lifecycle", { subsystem: "memory", stage: "preflight", outcome: "blocked", code: result.code, action: "stop" });
    process.exitCode = 1;
    return;
  }
  logEvent("runtime_lifecycle", { subsystem: "memory", stage: "preflight", outcome: "completed" });
}

main();
