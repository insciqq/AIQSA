import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";

const activeOwners = [
  "lib/domain/memory/retrieval/cardinality.ts",
  "lib/domain/memory/retrieval/temporal.ts",
  "lib/domain/memory/retrieval/unicodeDecimal.ts",
  "lib/server/memory/embedding/contract.ts",
  "lib/server/memory/history/language.ts",
  "lib/server/memory/operational/counters.ts",
  "lib/server/memory/operational/snapshot.ts"
] as const;

const reservedMetadataLabels = new Set(["mul", "und"]);

function source(path: string): string {
  return readFileSync(resolve(process.cwd(), path), "utf8");
}

function lexicalLiteral(node: ts.Node): boolean {
  return ts.isStringLiteralLike(node) &&
    /^\p{L}[\p{L}\p{M}'’‐‑-]{1,}$/u.test(node.text) &&
    !/\p{Lu}/u.test(node.text);
}

function lexicalLiteralCount(node: ts.Node): number {
  let count = lexicalLiteral(node) ? 1 : 0;
  ts.forEachChild(node, (child) => {
    count += lexicalLiteralCount(child);
  });
  return count;
}

function regexCarriesWords(value: string): boolean {
  const body = value
    .replace(/^\//u, "")
    .replace(/\/[a-z]*$/u, "")
    .replace(/\\[pP]\{[^}]+\}/gu, "")
    .replace(/\\u\{?[a-f0-9]+\}?/giu, "")
    .replace(/\\[A-Za-z]/gu, "")
    .replace(/\[[^\]]*\]/gu, "");
  return (body.match(/\p{L}{2,}/gu) ?? [])
    .some((word) => word !== "mixed");
}

function comparedString(node: ts.BinaryExpression): string | null {
  if (ts.isStringLiteralLike(node.left)) return node.left.text;
  if (ts.isStringLiteralLike(node.right)) return node.right.text;
  return null;
}

function inspectOwner(path: string, sourceText: string): string[] {
  const parsed = ts.createSourceFile(
    path,
    sourceText,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS
  );
  const violations: string[] = [];
  const report = (node: ts.Node, rule: string) => {
    const position = parsed.getLineAndCharacterOfPosition(node.getStart(parsed));
    violations.push(`${path}:${position.line + 1}:${position.character + 1}:${rule}`);
  };
  const visit = (node: ts.Node) => {
    if (ts.isIdentifier(node) &&
      /(?:english|russian|spanish|serbian|cyrillic|latin)/iu.test(node.text)) {
      report(node, "fixed-language-identifier");
    }
    if ((ts.isArrayLiteralExpression(node) || ts.isNewExpression(node)) &&
      lexicalLiteralCount(node) >= 4) {
      report(node, "natural-language-dictionary");
    }
    if (ts.isRegularExpressionLiteral(node) && regexCarriesWords(node.text)) {
      report(node, "natural-language-regex");
    }
    if (ts.isBinaryExpression(node) && [
      ts.SyntaxKind.EqualsEqualsEqualsToken,
      ts.SyntaxKind.EqualsEqualsToken,
      ts.SyntaxKind.ExclamationEqualsEqualsToken,
      ts.SyntaxKind.ExclamationEqualsToken
    ].includes(node.operatorToken.kind)) {
      const literal = comparedString(node);
      const expression = node.getText(parsed);
      if (literal && /^[a-z]{2,3}$/u.test(literal) &&
        !reservedMetadataLabels.has(literal) &&
        /language|locale|script|bucket/iu.test(expression)) {
        report(node, "fixed-language-code-branch");
      }
      if (literal && /^[A-Z][a-z]{3}$/u.test(literal) &&
        /script/iu.test(expression)) {
        report(node, "fixed-script-code-branch");
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(parsed);

  if (/\b(?:English|Russian|Spanish|Serbian)\b/iu.test(sourceText)) {
    violations.push(`${path}:fixed-language-name`);
  }
  if (/\\p\{Script=/u.test(sourceText)) {
    violations.push(`${path}:script-routing`);
  }
  return violations;
}

describe("Memory language-neutral helper architecture", () => {
  it("keeps active helpers free of fixed-language dictionaries and routing", () => {
    expect(activeOwners.flatMap((path) => inspectOwner(path, source(path))))
      .toEqual([]);
  });

  it("detects a reintroduced lexicon, natural-language regex, or locale branch", () => {
    const violations = inspectOwner("unsafe.ts", `
      const monthWords = new Map([
        ["january", 1], ["february", 2], ["march", 3], ["april", 4]
      ]);
      const temporal = /today|yesterday|tomorrow/u;
      function route(language: string) {
        return language === "en" ? monthWords : temporal;
      }
    `);
    expect(violations).toEqual(expect.arrayContaining([
      expect.stringContaining("natural-language-dictionary"),
      expect.stringContaining("natural-language-regex"),
      expect.stringContaining("fixed-language-code-branch")
    ]));
  });
});
