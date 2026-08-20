import {
  assertKnowledgeDocumentContextIntegrityGates,
  runKnowledgeDocumentContextIntegrityEval
} from "../tests/knowledge-evals/documentContextIntegrity";

try {
  const report = runKnowledgeDocumentContextIntegrityEval();
  assertKnowledgeDocumentContextIntegrityGates(report);
  process.stdout.write(`${JSON.stringify(report)}\n`);
} catch {
  process.stderr.write("knowledge_document_context_integrity_eval_failed\n");
  process.exitCode = 1;
}
