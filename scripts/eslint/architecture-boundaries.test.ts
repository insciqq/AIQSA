import { ESLint } from "eslint";
import path from "node:path";
import { describe, expect, it } from "vitest";

const repositoryRoot = process.cwd();
const eslint = new ESLint({ cwd: repositoryRoot });
const boundaryRuleId = "aiqsa-architecture/architecture-boundaries";
const testSupportRuleId = "aiqsa-architecture/test-support-boundary";
const typographyRuleId = "aiqsa-architecture/ui-typography";

const boundaryCases = [
  {
    filePath: "components/importBoundaryExample.tsx",
    reason: "Components must not import server-only modules.",
    specifier: "@/lib/server/prisma"
  },
  {
    filePath: "components/app-shell/importBoundaryExample.tsx",
    reason: "The app shell must not depend on the admin feature.",
    specifier: "@/components/admin/AdminPanel"
  },
  {
    filePath: "lib/contracts/importBoundaryExample.ts",
    reason: "Shared contracts must remain dependency leaves.",
    specifier: "@/lib/domain/usage"
  },
  {
    filePath: "lib/domain/importBoundaryExample.ts",
    reason: "Domain modules must remain independent of app, component, and server layers.",
    specifier: "@/app/page"
  },
  {
    filePath: "app/api/import-boundary/route.ts",
    reason: "API routes must not import browser components.",
    specifier: "@/features/workspace-v2/PowerAppShellV2"
  },
  {
    filePath: "lib/server/providers/importBoundaryExample.ts",
    reason: "Provider adapters must not import run orchestration, handlers, or repositories.",
    specifier: "@/lib/server/runs/runExecution"
  }
] as const;

describe("repository lint policies", () => {
  it.each(boundaryCases)("rejects a representative $filePath boundary", async ({
    filePath,
    reason,
    specifier
  }) => {
    const [result] = await eslint.lintText(`import ${JSON.stringify(specifier)};`, {
      filePath: path.join(repositoryRoot, filePath)
    });

    expect(result.messages.filter(({ fatal }) => fatal)).toEqual([]);
    expect(result.messages.filter(({ ruleId }) => ruleId === boundaryRuleId)).toEqual([
      expect.objectContaining({
        message: `'${specifier}' import crosses an architecture boundary. ${reason}`,
        ruleId: boundaryRuleId
      })
    ]);
  }, 15_000);

  it("fails closed for a non-literal dependency", async () => {
    const [result] = await eslint.lintText(
      'const dependency = "./allowed";\nvoid import(dependency);',
      { filePath: path.join(repositoryRoot, "components/nonLiteralDependency.tsx") }
    );

    expect(result.messages.filter(({ ruleId }) => ruleId === boundaryRuleId)).toEqual([
      expect.objectContaining({
        message:
          "import() uses a non-literal dependency specifier, so its architecture boundary cannot be verified. Use a string literal.",
        ruleId: boundaryRuleId
      })
    ]);
  });

  it("keeps test support out of production dependency graphs", async () => {
    const specifier = "@/tests/support/auth";
    const [productionResult] = await eslint.lintText(
      `import ${JSON.stringify(specifier)};`,
      { filePath: path.join(repositoryRoot, "lib/server/auth/productionConsumer.ts") }
    );
    const [testResult] = await eslint.lintText(
      `import ${JSON.stringify(specifier)};`,
      { filePath: path.join(repositoryRoot, "lib/server/auth/consumer.test.ts") }
    );

    expect(
      productionResult.messages.filter(({ ruleId }) => ruleId === testSupportRuleId)
    ).toEqual([
      expect.objectContaining({
        message:
          `Production code must not import '${specifier}' from a test/fixture support boundary.`,
        ruleId: testSupportRuleId
      })
    ]);
    expect(testResult.messages.filter(({ ruleId }) => ruleId === testSupportRuleId)).toEqual([]);
  });

  it("keeps UI fixture modules inside their gated route and tests", async () => {
    const specifier = "@/app/ui-v2-fixture/_fixtures/ComposerV2Gallery";
    const [productionResult] = await eslint.lintText(
      `import ${JSON.stringify(specifier)};`,
      { filePath: path.join(repositoryRoot, "features/composer-v2/productionConsumer.tsx") }
    );
    const [ownerResult] = await eslint.lintText(
      `import ${JSON.stringify(specifier)};`,
      { filePath: path.join(repositoryRoot, "app/ui-v2-fixture/owner.tsx") }
    );
    const [testResult] = await eslint.lintText(
      `import ${JSON.stringify(specifier)};`,
      { filePath: path.join(repositoryRoot, "features/composer-v2/consumer.test.tsx") }
    );

    expect(
      productionResult.messages.filter(({ ruleId }) => ruleId === testSupportRuleId)
    ).toEqual([
      expect.objectContaining({
        message:
          `Production code must not import '${specifier}' from a test/fixture support boundary.`,
        ruleId: testSupportRuleId
      })
    ]);
    expect(ownerResult.messages.filter(({ ruleId }) => ruleId === testSupportRuleId)).toEqual([]);
    expect(testResult.messages.filter(({ ruleId }) => ruleId === testSupportRuleId)).toEqual([]);
  });

  it("rejects unreadable typography utilities", async () => {
    const [result] = await eslint.lintText(
      [
        'const tiny = "text-[10px]";',
        'const metadata = "text-metadata leading-tight";',
        'export const Marker = () => <span className="text-incidental">1</span>;'
      ].join("\n"),
      { filePath: path.join(repositoryRoot, "components/TypographyExample.tsx") }
    );

    expect(
      result.messages
        .filter(({ ruleId }) => ruleId === typographyRuleId)
        .map(({ message }) => message)
    ).toEqual([
      "Use the semantic metadata or incidental typography utilities instead of raw 10–11px text.",
      "Metadata text must keep its readable line-height.",
      "Incidental microtype is allowed only on a JSX marker with aria-hidden=true."
    ]);
  });

  it("allows readable metadata and hidden incidental markers", async () => {
    const [result] = await eslint.lintText(
      [
        'const metadata = "text-metadata leading-5";',
        'export const Marker = () => <span aria-hidden="true" className="text-incidental">1</span>;'
      ].join("\n"),
      { filePath: path.join(repositoryRoot, "components/TypographyExample.tsx") }
    );

    expect(result.messages.filter(({ ruleId }) => ruleId === typographyRuleId)).toEqual([]);
  });
});
