import { readdirSync, readFileSync } from "node:fs";
import { relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { describe, expect, it } from "vitest";

/**
 * The retired Dream columns of UserMemorySettings are dropped by the next
 * release. This release's writers keep running while Compose replaces them
 * after that migration, so no runtime Prisma call may return the full row
 * (Prisma would select the dropped columns) and no runtime code may name them.
 */
const repositoryRoot = resolve(fileURLToPath(new URL(".", import.meta.url)), "../../../..");
const runtimeRoots = ["app", "lib"] as const;
const retiredColumns = [
  "synthesisEnabled",
  "synthesisEnabledAt",
  "synthesisPolicyVersion",
  "lastSynthesisAt"
] as const;
/** Delegate methods that return no settings row. */
const rowlessMethods = new Set([
  "aggregate",
  "count",
  "createMany",
  "deleteMany",
  "groupBy",
  "updateMany"
]);

function runtimeSources(): string[] {
  return runtimeRoots.flatMap((root) =>
    readdirSync(resolve(repositoryRoot, root), { recursive: true, withFileTypes: true })
      .filter((entry) => entry.isFile() && /\.tsx?$/u.test(entry.name) &&
        !/\.test\.tsx?$/u.test(entry.name))
      .map((entry) => resolve(entry.parentPath, entry.name)));
}

function selectsExplicitly(call: ts.CallExpression): boolean {
  const [args] = call.arguments;
  return Boolean(args && ts.isObjectLiteralExpression(args) &&
    args.properties.some((property) =>
      (ts.isPropertyAssignment(property) || ts.isShorthandPropertyAssignment(property)) &&
      ts.isIdentifier(property.name) && property.name.text === "select"));
}

function settingsDelegateViolations(path: string, sourceText: string): string[] {
  const source = ts.createSourceFile(path, sourceText, ts.ScriptTarget.Latest, true,
    path.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const violations: string[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isPropertyAccessExpression(node) && node.name.text === "userMemorySettings") {
      const line = source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;
      const method = node.parent;
      const call = method?.parent;
      if (!ts.isPropertyAccessExpression(method) || method.expression !== node ||
        !call || !ts.isCallExpression(call) || call.expression !== method) {
        violations.push(`${path}:${line} userMemorySettings is used outside a direct call`);
      } else if (!rowlessMethods.has(method.name.text) && !selectsExplicitly(call)) {
        violations.push(`${path}:${line} userMemorySettings.${method.name.text} has no select`);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return violations;
}

describe("retired UserMemorySettings Dream columns", () => {
  it("are neither named nor implicitly selected by runtime code", () => {
    const sources = runtimeSources();
    expect(sources.length).toBeGreaterThan(100);
    const violations = sources.flatMap((absolute) => {
      const path = relative(repositoryRoot, absolute);
      const text = readFileSync(absolute, "utf8");
      const named = path.startsWith("lib/contracts/")
        ? []
        : retiredColumns.filter((column) => new RegExp(`\\b${column}\\b`, "u").test(text))
          .map((column) => `${path} names ${column}`);
      return [...named, ...settingsDelegateViolations(path, text)];
    });
    expect(violations).toEqual([]);
  });

  it("reports a settings call that would return the full row", () => {
    expect(settingsDelegateViolations("probe.ts", [
      "await tx.userMemorySettings.update({ data: {}, where: { userId } });",
      "await tx.userMemorySettings.findUnique({ select: { userId: true }, where: { userId } });",
      "await tx.userMemorySettings.updateMany({ data: {}, where: { userId } });",
      "const delegate = tx.userMemorySettings;"
    ].join("\n"))).toEqual([
      "probe.ts:1 userMemorySettings.update has no select",
      "probe.ts:4 userMemorySettings is used outside a direct call"
    ]);
  });
});
