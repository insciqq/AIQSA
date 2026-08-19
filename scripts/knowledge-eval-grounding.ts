import {
  assertKnowledgeGroundingEvalGates,
  runKnowledgeGroundingEval
} from "../tests/knowledge-evals/grounding";

const report = runKnowledgeGroundingEval();
assertKnowledgeGroundingEvalGates(report);
process.stdout.write(`${JSON.stringify(report)}\n`);
