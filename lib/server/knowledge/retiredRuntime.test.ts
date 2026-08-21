import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const repositoryRoot = resolve(import.meta.dirname, "../../..");
const serverRoot = join(repositoryRoot, "lib/server");
const runExecutionPath = join(serverRoot, "runs", "runExecution.ts");
const runPreparationPath = join(serverRoot, "runs", "runPreparation.ts");

const retiredKnowledgeRuntimeModules = [
  "knowledgeStrategyDispatchLineage",
  "knowledgeStrategyExecution",
  "knowledgeStrategyMapOutput",
  "knowledgeStrategyPlan",
  "knowledgeStrategyRepository",
  "knowledgeStrategyRuntime",
  "knowledgeStrategySummaryEvidence",
  "observationGrounding",
  "planner",
  "plannerTargetResolution",
  "semanticArithmetic",
  "semanticGrounding",
  "semanticShadow",
  "structuredPlanner",
  "structuredRetrieval",
  "visualRuntime"
] as const;

function productionTypeScriptFiles(directory: string): readonly string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return productionTypeScriptFiles(path);
    return entry.isFile() && path.endsWith(".ts") && !path.endsWith(".test.ts")
      ? [path]
      : [];
  });
}

describe("retired Knowledge runtime surface", () => {
  it("keeps planner, strategy, semantic, and query-time analysis modules absent", () => {
    const existing = retiredKnowledgeRuntimeModules.flatMap((moduleName) => {
      const path = join(serverRoot, "knowledge", `${moduleName}.ts`);
      return existsSync(path) ? [relative(repositoryRoot, path)] : [];
    });

    expect(existing).toEqual([]);
  });

  it("has no production server import of a retired Knowledge runtime module", () => {
    const retiredImport = new RegExp(
      String.raw`(?:from\s+|import\s*\(|require\s*\()\s*["'][^"']*(?:${retiredKnowledgeRuntimeModules.join("|")})(?:\.[cm]?[jt]s)?["']`,
      "u"
    );
    const violations = productionTypeScriptFiles(serverRoot).flatMap((path) =>
      retiredImport.test(readFileSync(path, "utf8"))
        ? [relative(repositoryRoot, path)]
        : []);

    expect(violations).toEqual([]);
  });

  it("uses search_knowledge for new tool loops while retaining historical focused replay", () => {
    const execution = readFileSync(runExecutionPath, "utf8");
    const preparation = readFileSync(runPreparationPath, "utf8");

    // These assertions make the active graph fail closed if the removed
    // planner/strategy loop is accidentally reintroduced under a new import.
    expect(execution.match(/input\.knowledgeExecutor(?:!)?\.execute\(/gu)).toHaveLength(2);
    expect(execution.match(/focusedKnowledgeEvidenceDispatchDraft\(/gu)).toHaveLength(1);
    expect(execution).toContain("isKnowledgeCall(call.name)");
    expect(execution).not.toMatch(/knowledgePlanner|automaticKnowledgeBranchesForDispatch/u);
    expect(preparation).toContain("knowledgeRetrievalTool");
    expect(preparation).not.toContain("createKnowledgeFocusedRequest");
    expect(preparation).not.toContain("knowledgeFocusedRequest");
  });
});
