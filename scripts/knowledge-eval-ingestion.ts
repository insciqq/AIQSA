import { stderr, stdout } from "node:process";
import { assertKnowledgeIngestionReleaseGates } from "../tests/knowledge-evals/ingestionRelease";

assertKnowledgeIngestionReleaseGates()
  .then((report) => stdout.write(`${JSON.stringify(report, null, 2)}\n`))
  .catch((error: unknown) => {
    stderr.write(`knowledge ingestion release evaluation failed: ${error instanceof Error ? error.message : "unknown_error"}\n`);
    process.exitCode = 1;
  });
