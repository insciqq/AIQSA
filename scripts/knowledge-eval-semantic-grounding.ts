import { stderr, stdout } from "node:process";
import {
  knowledgeSemanticGroundingCliErrorCode,
  KNOWLEDGE_SEMANTIC_GROUNDING_CLI_USAGE,
  runKnowledgeSemanticGroundingCli
} from "../tests/knowledge-evals/semanticGroundingCli";

runKnowledgeSemanticGroundingCli(process.argv.slice(2))
  .then((report) => stdout.write(report
    ? `${JSON.stringify(report, null, 2)}\n`
    : `${KNOWLEDGE_SEMANTIC_GROUNDING_CLI_USAGE}\n`))
  .catch((error: unknown) => {
    stderr.write(`knowledge semantic benchmark failed: ${
      knowledgeSemanticGroundingCliErrorCode(error)}\n`);
    process.exitCode = 1;
  });
