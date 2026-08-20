import { stderr, stdout } from "node:process";
import { assertKnowledgePlannerReleaseGates } from "../tests/knowledge-evals/plannerRelease";

assertKnowledgePlannerReleaseGates()
  .then((report) => stdout.write(`${JSON.stringify(report, null, 2)}\n`))
  .catch((error: unknown) => {
    stderr.write(`knowledge planner release evaluation failed: ${error instanceof Error ? error.message : "unknown_error"}\n`);
    process.exitCode = 1;
  });
