import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { prisma } from "../lib/server/prisma";
import {
  assertKnowledgeHierarchicalIndexEvaluation,
  runKnowledgeHierarchicalIndexEvaluation
} from "../tests/knowledge-evals/hierarchicalIndexes";
import { assertDisposableStatefulTestTarget } from "./stateful-test-target";

function outputPath(arguments_: readonly string[]): string | null {
  let selected: string | null = null;
  for (let index = 0; index < arguments_.length; index += 1) {
    const argument = arguments_[index]!;
    if (argument === "--help") {
      process.stdout.write(
        "Usage: npm run eval:knowledge:indexes -- [--output <path>]\n"
      );
      return "help";
    }
    if (argument === "--output") {
      const value = arguments_[index + 1];
      if (!value || value.startsWith("--")) {
        throw new Error("knowledge_eval_output_path_missing");
      }
      selected = resolve(value);
      index += 1;
      continue;
    }
    if (argument.startsWith("--output=")) {
      const value = argument.slice("--output=".length);
      if (!value) throw new Error("knowledge_eval_output_path_missing");
      selected = resolve(value);
      continue;
    }
    throw new Error("knowledge_eval_argument_invalid");
  }
  return selected;
}

async function main(): Promise<void> {
  const selectedOutput = outputPath(process.argv.slice(2));
  if (selectedOutput === "help") return;
  assertDisposableStatefulTestTarget(process.env);
  try {
    const report = await runKnowledgeHierarchicalIndexEvaluation(prisma);
    const serialized = `${JSON.stringify(report, null, 2)}\n`;
    if (selectedOutput) await writeFile(selectedOutput, serialized, "utf8");
    process.stdout.write(serialized);
    assertKnowledgeHierarchicalIndexEvaluation(report);
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((error: unknown) => {
  const code = error instanceof Error ? error.message : "knowledge_index_eval_failed";
  process.stderr.write(`Knowledge hierarchical index evaluation failed: ${code}\n`);
  process.exitCode = 1;
});
