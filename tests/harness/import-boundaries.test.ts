import { ESLint } from "eslint";
import { builtinModules } from "node:module";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";

const repositoryRoot = process.cwd();
const fixtureRoot = path.join(repositoryRoot, "tests/fixtures/import-boundaries");
const eslint = new ESLint({ cwd: repositoryRoot });

const boundaryRuleId = "aiqsa-architecture/architecture-boundaries";
const boundaryMessage = (specifier: string, message: string) =>
  `'${specifier}' import crosses an architecture boundary. ${message}`;
const unverifiableDynamicMessage = (kind: string) =>
  `${kind} uses a non-literal dependency specifier, so its architecture boundary cannot be verified. Use a string literal.`;

type InvalidFixture = {
  fixture: string;
  filePath: string;
  expected: Array<[specifier: string, message: string]>;
};

const invalidFixtures: InvalidFixture[] = [
  {
    fixture: "components-invalid.txt",
    filePath: "components/importBoundaryExample.tsx",
    expected: [
      ["@/lib/server/auth/config", "Components must not import server-only modules."],
      ["../lib/server/prisma", "Components must not import server-only modules."],
      ["lib/server/prisma", "Components must not import server-only modules."],
      ["@/components/../lib/server/prisma", "Components must not import server-only modules."],
      ["../components/../lib/server/prisma", "Components must not import server-only modules."],
      ["@/app/api/me/settings/route", "Components must not import server-only modules."],
      ["@/prisma/seed", "Components must not import Prisma."],
      ["prisma/seed", "Components must not import Prisma."],
      ["@prisma/client", "Components must not import Prisma."],
      ["node:fs", "Components must not import Node built-ins."],
      ["fs", "Components must not import Node built-ins."],
      ["fs/promises", "Components must not import Node built-ins."],
      ["@/lib/server/prisma", "Components must not import server-only modules."],
      ["lib/server/prisma", "Components must not import server-only modules."],
      ["@/lib/server/prisma", "Components must not import server-only modules."],
      ["server-only", "Components must not import server-only modules."],
      ["next/headers", "Components must not import server-only modules."],
      ["next/server", "Components must not import server-only modules."],
      ["next/cache", "Components must not import server-only modules."],
      ["next/og", "Components must not import server-only modules."],
      ["next/headers.js", "Components must not import server-only modules."],
      ["next/server.js", "Components must not import server-only modules."],
      ["next/cache.js", "Components must not import server-only modules."],
      ["next/og.js", "Components must not import server-only modules."],
      ["next/dist/server/web/exports", "Components must not import server-only modules."]
    ]
  },
  {
    fixture: "contracts-invalid.txt",
    filePath: "lib/contracts/importBoundaryExample.ts",
    expected: [
      ["@/components/chat/Composer", "Shared contracts must remain dependency leaves."],
      ["../../components/chat/Composer", "Shared contracts must remain dependency leaves."],
      ["@/lib/server/auth/config", "Shared contracts must remain dependency leaves."],
      ["../server/auth/config", "Shared contracts must remain dependency leaves."],
      ["@/lib/domain/usage", "Shared contracts must remain dependency leaves."],
      ["../domain/usage", "Shared contracts must remain dependency leaves."],
      ["@/app/page", "Shared contracts must remain dependency leaves."],
      ["../../app/page", "Shared contracts must remain dependency leaves."],
      ["@/prisma/seed", "Shared contracts must not import Prisma."],
      ["prisma/seed", "Shared contracts must not import Prisma."],
      ["@prisma/client", "Shared contracts must not import Prisma."],
      ["node:crypto", "Shared contracts must not import Node built-ins."],
      ["react", "Shared contracts must not import React."],
      ["react/jsx-runtime", "Shared contracts must not import React."],
      ["components/chat/Composer", "Shared contracts must remain dependency leaves."],
      ["lib/server/prisma", "Shared contracts must remain dependency leaves."],
      ["lib/domain/usage", "Shared contracts must remain dependency leaves."],
      ["app/page", "Shared contracts must remain dependency leaves."],
      ["@/lib/contracts/../server/prisma", "Shared contracts must remain dependency leaves."],
      ["../contracts/../server/prisma", "Shared contracts must remain dependency leaves."],
      ["crypto", "Shared contracts must not import Node built-ins."],
      ["@/lib/server/prisma", "Shared contracts must remain dependency leaves."],
      ["components/chat/Composer", "Shared contracts must remain dependency leaves."]
    ]
  },
  {
    fixture: "domain-invalid.txt",
    filePath: "lib/domain/importBoundaryExample.ts",
    expected: [
      ["@/components/chat/Composer", "Domain modules must remain independent of app, component, and server layers."],
      ["../../components/chat/Composer", "Domain modules must remain independent of app, component, and server layers."],
      ["@/lib/server/prisma", "Domain modules must remain independent of app, component, and server layers."],
      ["../server/prisma", "Domain modules must remain independent of app, component, and server layers."],
      ["@/app/page", "Domain modules must remain independent of app, component, and server layers."],
      ["../../app/page", "Domain modules must remain independent of app, component, and server layers."],
      ["@/prisma/seed", "Domain modules must not import Prisma."],
      ["prisma/seed", "Domain modules must not import Prisma."],
      ["@prisma/client", "Domain modules must not import Prisma."],
      ["node:crypto", "Domain modules must not import Node built-ins."],
      ["react", "Domain modules must not import React."],
      ["react-dom/server", "Domain modules must not import React."],
      ["components/chat/Composer", "Domain modules must remain independent of app, component, and server layers."],
      ["lib/server/prisma", "Domain modules must remain independent of app, component, and server layers."],
      ["app/page", "Domain modules must remain independent of app, component, and server layers."],
      ["@/lib/domain/../server/prisma", "Domain modules must remain independent of app, component, and server layers."],
      ["../domain/../server/prisma", "Domain modules must remain independent of app, component, and server layers."],
      ["path", "Domain modules must not import Node built-ins."],
      ["components/chat/Composer", "Domain modules must remain independent of app, component, and server layers."]
    ]
  },
  {
    fixture: "api-invalid.txt",
    filePath: "app/api/import-boundary/route.ts",
    expected: [
      ["@/components/app-shell/PowerAppShell", "API routes must not import browser components."],
      ["../../../components/app-shell/PowerAppShell", "API routes must not import browser components."],
      ["components/app-shell/PowerAppShell", "API routes must not import browser components."],
      ["@/app/../components/app-shell/PowerAppShell", "API routes must not import browser components."],
      ["../../../app/../components/app-shell/PowerAppShell", "API routes must not import browser components."],
      ["components/app-shell/PowerAppShell", "API routes must not import browser components."],
      ["@/components/app-shell/PowerAppShell", "API routes must not import browser components."]
    ]
  },
  {
    fixture: "providers-invalid.txt",
    filePath: "lib/server/providers/importBoundaryExample.ts",
    expected: [
      ["@/app/page", "Provider adapters must not import app or component modules."],
      ["../../../app/page", "Provider adapters must not import app or component modules."],
      ["@/components/chat/Composer", "Provider adapters must not import app or component modules."],
      ["../../../components/chat/Composer", "Provider adapters must not import app or component modules."],
      ["@prisma/client", "Provider adapters must not import Prisma."],
      ["@/prisma/seed", "Provider adapters must not import Prisma."],
      ["prisma/seed", "Provider adapters must not import Prisma."],
      ["@/lib/server/runs/handlers", "Provider adapters must not import run orchestration, handlers, or repositories."],
      ["../runs/handlers", "Provider adapters must not import run orchestration, handlers, or repositories."],
      ["@/lib/server/runs/prismaRepository", "Provider adapters must not import run orchestration, handlers, or repositories."],
      ["../runs/runRepositoryContract", "Provider adapters must not import run orchestration, handlers, or repositories."],
      ["app/page", "Provider adapters must not import app or component modules."],
      ["components/chat/Composer", "Provider adapters must not import app or component modules."],
      ["lib/server/runs/handlers", "Provider adapters must not import run orchestration, handlers, or repositories."],
      ["@/lib/server/runs/runExecution", "Provider adapters must not import run orchestration, handlers, or repositories."],
      ["../runs/runExecution", "Provider adapters must not import run orchestration, handlers, or repositories."],
      ["@/lib/server/providers/../runs/runExecution", "Provider adapters must not import run orchestration, handlers, or repositories."],
      ["../providers/../runs/runExecution", "Provider adapters must not import run orchestration, handlers, or repositories."],
      ["@/lib/server/runs", "Provider adapters must not import run orchestration, handlers, or repositories."],
      ["../runs", "Provider adapters must not import run orchestration, handlers, or repositories."],
      ["lib/server/runs/runExecution", "Provider adapters must not import run orchestration, handlers, or repositories."],
      ["components/chat/Composer", "Provider adapters must not import app or component modules."],
      ["@/lib/server/auth/handlers", "Provider adapters must not import run orchestration, handlers, or repositories."],
      ["../chats/prismaRepository", "Provider adapters must not import run orchestration, handlers, or repositories."],
      ["lib/server/admin/repositories/usage", "Provider adapters must not import run orchestration, handlers, or repositories."]
    ]
  },
  {
    fixture: "app-shell-invalid.txt",
    filePath: "components/app-shell/importBoundaryExample.tsx",
    expected: [
      ["@/components/admin/AdminPanel", "The app shell must not depend on the admin feature."],
      ["../admin/AdminPanel", "The app shell must not depend on the admin feature."],
      ["@/lib/server/prisma", "Components must not import server-only modules."],
      ["components/admin/AdminPanel", "The app shell must not depend on the admin feature."],
      ["@/components/app-shell/../admin/AdminPanel", "The app shell must not depend on the admin feature."],
      ["../app-shell/../admin/AdminPanel", "The app shell must not depend on the admin feature."],
      ["components/admin/AdminPanel", "The app shell must not depend on the admin feature."],
      ["@/components/admin/AdminPanel", "The app shell must not depend on the admin feature."]
    ]
  }
];

describe("architecture import boundaries", () => {
  it("rejects invalid dependencies in every protected layer", async () => {
    for (const { fixture, filePath, expected } of invalidFixtures) {
      const source = await readFile(path.join(fixtureRoot, fixture), "utf8");
      const [result] = await eslint.lintText(source, {
        filePath: path.join(repositoryRoot, filePath)
      });

      expect(result.messages.filter(({ fatal }) => fatal), fixture).toEqual([]);
      expect(
        result.messages
          .filter(({ ruleId }) => ruleId === boundaryRuleId)
          .map(({ ruleId, message }) => ({ ruleId, message })),
        fixture
      ).toEqual(
        expected.map(([specifier, message]) => ({
          ruleId: boundaryRuleId,
          message: boundaryMessage(specifier, message)
        }))
      );
    }
  });

  it("fails closed for non-literal dependencies in every protected layer", async () => {
    const filePaths = [
      "components/nonLiteralDependency.tsx",
      "components/app-shell/nonLiteralDependency.tsx",
      "lib/contracts/nonLiteralDependency.ts",
      "lib/domain/nonLiteralDependency.ts",
      "app/api/non-literal/route.ts",
      "lib/server/providers/nonLiteralDependency.ts"
    ];
    for (const filePath of filePaths) {
      const [result] = await eslint.lintText(
        'const dependency = "./allowed";\nvoid import(dependency);\nrequire(dependency);',
        { filePath: path.join(repositoryRoot, filePath) }
      );

      expect(result.messages.filter(({ fatal }) => fatal), filePath).toEqual([]);
      expect(
        result.messages
          .filter(({ ruleId }) => ruleId === boundaryRuleId)
          .map(({ ruleId, message }) => ({ ruleId, message })),
        filePath
      ).toEqual([
        { ruleId: boundaryRuleId, message: unverifiableDynamicMessage("import()") },
        { ruleId: boundaryRuleId, message: unverifiableDynamicMessage("require()") }
      ]);
    }
  });

  it("rejects every Node built-in spelling from components", async () => {
    const builtinSpecifiers = [
      ...new Set(
        builtinModules.flatMap((moduleName) =>
          moduleName.startsWith("node:") ? [moduleName] : [moduleName, `node:${moduleName}`]
        )
      )
    ];
    const source = builtinSpecifiers
      .map((moduleName) => `import ${JSON.stringify(moduleName)};`)
      .join("\n");
    const [result] = await eslint.lintText(source, {
      filePath: path.join(repositoryRoot, "components/allNodeBuiltins.tsx")
    });

    expect(result.messages.filter(({ fatal }) => fatal)).toEqual([]);
    expect(
      result.messages
        .filter(({ ruleId }) => ruleId === boundaryRuleId)
        .map(({ ruleId, message }) => ({ ruleId, message }))
    ).toEqual(
      builtinSpecifiers.map((specifier) => ({
        ruleId: boundaryRuleId,
        message: boundaryMessage(specifier, "Components must not import Node built-ins.")
      }))
    );
  });

  it("allows supported dependencies in every protected layer", async () => {
    const fixtures = [
    {
      filePath: "components/importBoundaryValid.tsx",
      source:
        'import "@/lib/contracts/chats";\nimport "@/lib/domain/usage";\nimport "react";\nimport "next/navigation";\nimport "next/link";\nimport "next/image";'
    },
    {
      filePath: "lib/contracts/importBoundaryValid.ts",
      source: 'import "./catalog";\nimport "vitest";'
    },
    {
      filePath: "lib/domain/importBoundaryValid.ts",
      source: 'import "../contracts/catalog";\nimport "./usage";'
    },
    {
      filePath: "app/api/import-boundary/valid/route.ts",
      source: 'import "@/lib/server/auth/config";\nimport "next/server";'
    },
    {
      filePath: "lib/server/providers/importBoundaryValid.ts",
      source:
        'import "../../domain/modelRunEvents";\nimport "../tools/bridges";\nimport "../auth/config";\nimport "./types";'
    },
    {
      filePath: "components/app-shell/importBoundaryValid.tsx",
      source:
        'import "@/components/chat/Composer";\nimport "@/lib/contracts/chats";\nimport "@/lib/domain/usage";\nimport "react";'
    }
    ];
    for (const { filePath, source } of fixtures) {
      const [result] = await eslint.lintText(source, {
        filePath: path.join(repositoryRoot, filePath)
      });
      expect(result.messages, filePath).toEqual([]);
    }
  });

  it("allows normalized supported dependencies in every protected layer", async () => {
    const fixtures = [
    {
      filePath: "components/importBoundaryNormalizedValid.tsx",
      source:
        'import "lib/domain/usage";\nimport "@/components/../lib/contracts/chats";\nvoid import("lib/domain/usage");\nrequire("@/lib/contracts/chats");'
    },
    {
      filePath: "lib/contracts/importBoundaryNormalizedValid.ts",
      source:
        'import "@/lib/contracts/../contracts/catalog";\nvoid import("./catalog");\nrequire("vitest");'
    },
    {
      filePath: "lib/domain/importBoundaryNormalizedValid.ts",
      source:
        'import "lib/contracts/catalog";\nimport "@/lib/domain/../contracts/catalog";\nvoid import("./usage");'
    },
    {
      filePath: "app/api/import-boundary/valid/normalized/route.ts",
      source:
        'import "lib/server/auth/config";\nimport "@/app/../lib/server/prisma";\nvoid import("lib/domain/usage");'
    },
    {
      filePath: "lib/server/providers/importBoundaryNormalizedValid.ts",
      source:
        'import "lib/domain/modelRunEvents";\nimport "@/lib/server/providers/../tools/bridges";\nvoid import("lib/server/auth/config");\nrequire("./types");'
    },
    {
      filePath: "components/app-shell/importBoundaryNormalizedValid.tsx",
      source:
        'import "components/chat/Composer";\nimport "@/components/app-shell/../chat/Composer";\nvoid import("lib/domain/usage");'
    }
    ];
    for (const { filePath, source } of fixtures) {
      const [result] = await eslint.lintText(source, {
        filePath: path.join(repositoryRoot, filePath)
      });
      expect(result.messages.filter(({ fatal }) => fatal), filePath).toEqual([]);
      expect(result.messages.filter(({ ruleId }) => ruleId === boundaryRuleId), filePath).toEqual([]);
    }
  });
});
