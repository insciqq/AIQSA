import {
  assertKnowledgeVisualEvalGates,
  runKnowledgeVisualEval
} from "../tests/knowledge-evals/visual";

async function main(): Promise<void> {
  const report = await runKnowledgeVisualEval();
  assertKnowledgeVisualEvalGates(report);
  process.stdout.write(`${JSON.stringify(report)}\n`);
}

void main().catch(() => {
  process.stderr.write("knowledge_visual_eval_failed\n");
  process.exitCode = 1;
});
