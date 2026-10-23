import nextVitals from "eslint-config-next/core-web-vitals";
import aiqsaArchitecture from "./scripts/eslint/architecture-boundaries.mjs";

const architectureBoundary = (policy) => ["error", { policy }];
const architectureModules = "**/*.{js,jsx,mjs,cjs,ts,tsx,mts,cts}";

const eslintConfig = [
  ...nextVitals,
  {
    ignores: [
      ".aiqsa/**",
      ".next/**",
      "**/*.d.mts",
      "**/*.d.cts",
      "benchmarks/**",
      "coverage/**",
      "node_modules/**",
      "playwright-report/**",
      "scripts/longmemeval-qualification.test.ts",
      "test-results/**"
    ]
  },
  {
    plugins: {
      "aiqsa-architecture": aiqsaArchitecture
    }
  },
  {
    files: [architectureModules],
    ignores: ["**/*.d.ts"],
    rules: {
      "no-restricted-syntax": [
        "error",
        {
          selector: "PropertyDefinition[declare=true]",
          message:
            "Do not use TypeScript `declare` class fields: Playwright's Babel transform (preset-typescript without allowDeclareFields) cannot load any module containing one, which breaks every spec that imports it. Declare the member type-only through interface declaration merging instead."
        }
      ]
    }
  },
  {
    files: [architectureModules],
    ignores: ["**/*.test.*", "**/*.spec.*", "tests/**"],
    rules: {
      "aiqsa-architecture/test-support-boundary": "error"
    }
  },
  {
    files: [`app/${architectureModules}`, `components/${architectureModules}`],
    rules: {
      "aiqsa-architecture/ui-typography": "error"
    }
  },
  {
    files: [`components/${architectureModules}`],
    rules: {
      "aiqsa-architecture/architecture-boundaries": architectureBoundary("components")
    }
  },
  {
    files: [`features/${architectureModules}`],
    rules: {
      "aiqsa-architecture/architecture-boundaries": architectureBoundary("components")
    }
  },
  {
    files: [`components/app-shell/${architectureModules}`],
    rules: {
      "aiqsa-architecture/architecture-boundaries": architectureBoundary("app-shell")
    }
  },
  {
    files: [`lib/contracts/${architectureModules}`],
    rules: {
      "aiqsa-architecture/architecture-boundaries": architectureBoundary("contracts")
    }
  },
  {
    files: [`lib/domain/${architectureModules}`],
    rules: {
      "aiqsa-architecture/architecture-boundaries": architectureBoundary("domain")
    }
  },
  {
    files: [`app/api/${architectureModules}`],
    rules: {
      "aiqsa-architecture/architecture-boundaries": architectureBoundary("api")
    }
  },
  {
    files: [`lib/server/providers/${architectureModules}`],
    rules: {
      "aiqsa-architecture/architecture-boundaries": architectureBoundary("providers")
    }
  }
];

export default eslintConfig;
