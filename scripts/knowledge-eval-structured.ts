import {
  assertKnowledgeStructuredEvalGates,
  runKnowledgeStructuredEval
} from "../tests/knowledge-evals/structured";

async function main(): Promise<void> {
  const report = await runKnowledgeStructuredEval();
  assertKnowledgeStructuredEvalGates(report);
  process.stdout.write(`${JSON.stringify(report)}\n`);
}

void main().catch(() => {
  process.stderr.write("knowledge_structured_eval_failed\n");
  process.exitCode = 1;
});
