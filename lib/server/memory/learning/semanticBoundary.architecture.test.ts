import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import {
  MEMORY_COORDINATOR_JOB_KINDS,
  MEMORY_COORDINATOR_ORPHANED_JOB_KINDS
} from "../coordinator/registry";

const semanticOwners = [
  "extraction/decoder.ts",
  "extraction/adjudication.ts",
  "identity/registry.ts",
  "temporal/resolver.ts",
  "relations/policy.ts",
  "entities/normalization.ts",
  "entities/resolver.ts",
  "../vnext/repository.ts"
] as const;

const semanticTextMethods = new Set([
  "includes", "indexOf", "startsWith", "endsWith"
]);
const regexMethods = new Set(["match", "search", "test"]);
const mechanicalEntityFunctions = new Set([
  "boundedText",
  "normalizeMemoryEntityAlias"
]);
const mechanicalRegexBindings = new Map<string, ReadonlySet<string>>([
  ["extraction/decoder.ts", new Set(["boundedMachineToken", "controlSyntax"])],
  ["extraction/adjudication.ts", new Set(["token"])]
]);

function ancestorFunction(node: ts.Node): string | null {
  let current: ts.Node | undefined = node;
  while (current) {
    if (ts.isFunctionDeclaration(current) && current.name) return current.name.text;
    current = current.parent;
  }
  return null;
}

function allowedMechanicalRegex(path: string, node: ts.Node): boolean {
  if (path === "entities/normalization.ts") {
    if (mechanicalEntityFunctions.has(ancestorFunction(node) ?? "")) return true;
    const declaration = node.parent;
    return ts.isVariableDeclaration(declaration) &&
      ts.isIdentifier(declaration.name) &&
      declaration.name.text === "surroundingPunctuation";
  }
  const allowed = mechanicalRegexBindings.get(path);
  if (!allowed) return false;
  if (ts.isRegularExpressionLiteral(node)) {
    const declaration = node.parent;
    return ts.isVariableDeclaration(declaration) &&
      ts.isIdentifier(declaration.name) && allowed.has(declaration.name.text);
  }
  return ts.isCallExpression(node) &&
    ts.isPropertyAccessExpression(node.expression) &&
    ts.isIdentifier(node.expression.expression) &&
    allowed.has(node.expression.expression.text);
}

function humanLanguageLiteral(node: ts.Expression): boolean {
  return ts.isStringLiteralLike(node) && /\p{L}/u.test(node.text) && (
    /\s/u.test(node.text) || (
      node.text.length > 24 && !/^[A-Za-z0-9._:+@/-]+$/u.test(node.text)
    )
  );
}

function inspectSemanticOwner(path: string, sourceText: string): string[] {
  const source = ts.createSourceFile(
    path,
    sourceText,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS
  );
  const diagnostics: string[] = [];
  const report = (node: ts.Node, rule: string) => {
    const position = source.getLineAndCharacterOfPosition(node.getStart(source));
    diagnostics.push(`${path}:${position.line + 1}:${position.character + 1}:${rule}`);
  };
  const visit = (node: ts.Node) => {
    if (ts.isIdentifier(node) && node.text === "sourceText") {
      report(node, "raw-source-text-api");
    }
    if (path === "relations/policy.ts" && ts.isIdentifier(node) &&
      node.text === "displayText") {
      report(node, "raw-relation-text-api");
    }
    if (ts.isRegularExpressionLiteral(node) && !allowedMechanicalRegex(path, node)) {
      report(node, "regex-semantic-authority");
    }
    if (ts.isNewExpression(node) && ts.isIdentifier(node.expression) &&
      node.expression.text === "RegExp") {
      report(node, "dynamic-regex-semantic-authority");
    }
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
      const method = node.expression.name.text;
      if (regexMethods.has(method) && !allowedMechanicalRegex(path, node)) {
        report(node, "regex-method-semantic-authority");
      }
      if (semanticTextMethods.has(method) && node.arguments[0] &&
        humanLanguageLiteral(node.arguments[0])) {
        report(node, "human-language-literal-branch");
      }
    }
    if (ts.isBinaryExpression(node) &&
      (humanLanguageLiteral(node.left) || humanLanguageLiteral(node.right))) {
      report(node, "human-language-comparison");
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return diagnostics;
}

describe("Memory semantic boundary architecture", () => {
  it("keeps semantic owners free of lexical natural-language authority", () => {
    const violations = semanticOwners.flatMap((path) => {
      const url = new URL(path, import.meta.url);
      return inspectSemanticOwner(path, readFileSync(fileURLToPath(url), "utf8"));
    });
    expect(violations).toEqual([]);
  });

  it("detects reintroduced raw-text, regex and phrase branches", () => {
    expect(inspectSemanticOwner("identity/registry.ts", `
      function unsafe(sourceText: string) {
        return /owns|bought/u.test(sourceText) || sourceText.includes("used to live");
      }
    `).map((violation) => violation.split(":").at(-1))).toEqual(expect.arrayContaining([
      "raw-source-text-api",
      "regex-semantic-authority",
      "regex-method-semantic-authority",
      "human-language-literal-branch"
    ]));
    expect(inspectSemanticOwner("relations/policy.ts", `
      function unsafeRelation(displayText: string) { return displayText.length; }
    `)).toEqual(expect.arrayContaining([
      expect.stringContaining("raw-relation-text-api")
    ]));
  });

  it("[GATE] keeps one active automatic fact writer and retires legacy writers", () => {
    const semanticWriterKinds = new Set([
      "CONSOLIDATE_CANDIDATE",
      "EXTRACT_FACTS",
      "VERIFY_CANDIDATE"
    ]);
    expect(MEMORY_COORDINATOR_JOB_KINDS.filter((kind) =>
      semanticWriterKinds.has(kind))).toEqual(["EXTRACT_FACTS"]);
    expect(MEMORY_COORDINATOR_ORPHANED_JOB_KINDS).toEqual(expect.arrayContaining([
      "CONSOLIDATE_CANDIDATE",
      "VERIFY_CANDIDATE"
    ]));

    const sourceLifecycle = readFileSync(resolve(
      process.cwd(),
      "lib/server/memory/learning/sourceLifecycle.ts"
    ), "utf8");
    expect(sourceLifecycle.match(/kind:\s*"EXTRACT_FACTS"/gu)).toHaveLength(1);
    expect(sourceLifecycle).not.toMatch(
      /kind:\s*"(?:CONSOLIDATE_CANDIDATE|VERIFY_CANDIDATE)"/u
    );

    const defaultCoordinator = readFileSync(resolve(
      process.cwd(),
      "lib/server/memory/coordinator/defaultCoordinator.ts"
    ), "utf8");
    expect(defaultCoordinator).toContain("createPrismaMemoryFactExtractionHandler");
    expect(defaultCoordinator).not.toMatch(
      /createPrismaMemory(?:Consolidation|Verification)Handler/u
    );
  });
});
