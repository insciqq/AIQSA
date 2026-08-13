import nextVitals from "eslint-config-next/core-web-vitals";
import aiqsaArchitecture from "./scripts/eslint/architecture-boundaries.mjs";

const architectureBoundary = (policy) => ["error", { policy }];
const architectureModules = "**/*.{js,jsx,mjs,cjs,ts,tsx,mts,cts}";

const eslintConfig = [
  ...nextVitals,
  {
    ignores: [
      ".next/**",
      "**/*.d.mts",
      "coverage/**",
      "node_modules/**",
      "playwright-report/**",
      "test-results/**"
    ]
  },
  {
    plugins: {
      "aiqsa-architecture": aiqsaArchitecture
    }
  },
  {
    files: [
      `app/${architectureModules}`,
      `components/${architectureModules}`,
      `features/${architectureModules}`,
      `lib/${architectureModules}`
    ],
    ignores: ["**/*.test.*", "**/*.spec.*"],
    rules: {
      "aiqsa-architecture/no-memory-reference": "error"
    }
  },
  {
    files: [`components/${architectureModules}`],
    rules: {
      "aiqsa-architecture/architecture-boundaries": architectureBoundary("components")
    }
  },
  {
    files: [
      `components/${architectureModules}`,
      `features/${architectureModules}`
    ],
    rules: {
      "aiqsa-architecture/v2-presentation-boundaries": "error"
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
