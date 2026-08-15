import { builtinModules } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../.."
);

const repositoryRoots = new Set(["app", "components", "features", "lib", "prisma", "scripts", "styles", "tests"]);
const nodeBuiltinNames = new Set(
  builtinModules.filter((moduleName) => !moduleName.startsWith("node:"))
);
const componentServerEntrypoints = [
  "server-only",
  "next/headers",
  "next/server",
  "next/cache",
  "next/og",
  "next/dist/server"
];

const messages = {
  componentServer: "Components must not import server-only modules.",
  componentPrisma: "Components must not import Prisma.",
  componentNode: "Components must not import Node built-ins.",
  contractLayer: "Shared contracts must remain dependency leaves.",
  contractPrisma: "Shared contracts must not import Prisma.",
  contractNode: "Shared contracts must not import Node built-ins.",
  contractReact: "Shared contracts must not import React.",
  domainLayer:
    "Domain modules must remain independent of app, component, and server layers.",
  domainPrisma: "Domain modules must not import Prisma.",
  domainNode: "Domain modules must not import Node built-ins.",
  domainReact: "Domain modules must not import React.",
  apiComponent: "API routes must not import browser components.",
  providerConsumer: "Provider adapters must not import app or component modules.",
  providerPrisma: "Provider adapters must not import Prisma.",
  providerRun: "Provider adapters must not import run orchestration, handlers, or repositories.",
  appShellAdmin: "The app shell must not depend on the admin feature."
};

const toPosixPath = (value) => value.split(path.sep).join("/");

const isInsideRepository = (relativePath) =>
  relativePath !== ".." &&
  !relativePath.startsWith(`..${path.sep}`) &&
  !path.isAbsolute(relativePath);

const repositoryTarget = (specifier, importerFilename) => {
  const pathSpecifier = specifier.split(/[?#]/, 1)[0];
  let absoluteTarget;

  if (pathSpecifier.startsWith("@/")) {
    absoluteTarget = path.resolve(repositoryRoot, pathSpecifier.slice(2));
  } else if (pathSpecifier.startsWith("./") || pathSpecifier.startsWith("../")) {
    absoluteTarget = path.resolve(path.dirname(importerFilename), pathSpecifier);
  } else if (repositoryRoots.has(pathSpecifier.split("/", 1)[0])) {
    absoluteTarget = path.resolve(repositoryRoot, pathSpecifier);
  } else {
    return null;
  }

  const relativeTarget = path.relative(repositoryRoot, absoluteTarget);
  return isInsideRepository(relativeTarget) ? toPosixPath(relativeTarget) : null;
};

const targets = (target, prefix) =>
  target === prefix || target?.startsWith(`${prefix}/`) === true;

const importsPackage = (specifier, packageName) =>
  specifier === packageName || specifier.startsWith(`${packageName}/`);

const importsServerEntrypoint = (specifier, entrypoint) =>
  importsPackage(specifier, entrypoint) || specifier === `${entrypoint}.js`;

const importsNodeBuiltin = (specifier) => {
  if (specifier.startsWith("node:")) {
    return true;
  }

  return nodeBuiltinNames.has(specifier);
};

const targetsServerHandlerOrRepository = (target) => {
  if (!targets(target, "lib/server") || targets(target, "lib/server/providers")) {
    return false;
  }

  return target
    .split("/")
    .map((segment) => segment.replace(/\.[^.]+$/, "").toLowerCase())
    .some(
      (segment) =>
        segment.endsWith("handler") ||
        segment.endsWith("handlers") ||
        segment.includes("repository") ||
        segment.includes("repositories")
    );
};

const componentViolation = ({ specifier, target }) => {
  if (targets(target, "lib/server") || targets(target, "app/api")) {
    return messages.componentServer;
  }
  if (
    componentServerEntrypoints.some((entrypoint) =>
      importsServerEntrypoint(specifier, entrypoint)
    )
  ) {
    return messages.componentServer;
  }
  if (importsPackage(specifier, "@prisma/client") || targets(target, "prisma")) {
    return messages.componentPrisma;
  }
  if (importsNodeBuiltin(specifier)) {
    return messages.componentNode;
  }
  return null;
};

const policyViolation = (policy, dependency) => {
  if (policy === "components" || policy === "app-shell") {
    const violation = componentViolation(dependency);
    if (violation) {
      return violation;
    }
    if (policy === "app-shell" && targets(dependency.target, "components/admin")) {
      return messages.appShellAdmin;
    }
    return null;
  }

  if (policy === "contracts") {
    if (
      ["components", "app", "lib/server", "lib/domain"].some((prefix) =>
        targets(dependency.target, prefix)
      )
    ) {
      return messages.contractLayer;
    }
    if (
      importsPackage(dependency.specifier, "@prisma/client") ||
      targets(dependency.target, "prisma")
    ) {
      return messages.contractPrisma;
    }
    if (importsNodeBuiltin(dependency.specifier)) {
      return messages.contractNode;
    }
    if (
      importsPackage(dependency.specifier, "react") ||
      importsPackage(dependency.specifier, "react-dom")
    ) {
      return messages.contractReact;
    }
    return null;
  }

  if (policy === "domain") {
    if (
      ["components", "app", "lib/server"].some((prefix) =>
        targets(dependency.target, prefix)
      )
    ) {
      return messages.domainLayer;
    }
    if (
      importsPackage(dependency.specifier, "@prisma/client") ||
      targets(dependency.target, "prisma")
    ) {
      return messages.domainPrisma;
    }
    if (importsNodeBuiltin(dependency.specifier)) {
      return messages.domainNode;
    }
    if (
      importsPackage(dependency.specifier, "react") ||
      importsPackage(dependency.specifier, "react-dom")
    ) {
      return messages.domainReact;
    }
    return null;
  }

  if (policy === "api") {
    return ["components", "features"].some((prefix) =>
      targets(dependency.target, prefix)
    )
      ? messages.apiComponent
      : null;
  }

  if (policy === "providers") {
    if (["app", "components"].some((prefix) => targets(dependency.target, prefix))) {
      return messages.providerConsumer;
    }
    if (
      targets(dependency.target, "lib/server/runs") ||
      targetsServerHandlerOrRepository(dependency.target)
    ) {
      return messages.providerRun;
    }
    if (
      importsPackage(dependency.specifier, "@prisma/client") ||
      targets(dependency.target, "prisma")
    ) {
      return messages.providerPrisma;
    }
    return null;
  }

  return null;
};

const staticString = (node) => {
  if (!node) {
    return null;
  }
  if (typeof node.value === "string") {
    return node.value;
  }
  if (node.type === "TemplateLiteral" && node.expressions.length === 0) {
    return node.quasis[0]?.value.cooked ?? node.quasis[0]?.value.raw ?? null;
  }
  return null;
};

const typographyUtilities = (value) =>
  value
    .split(/\s+/u)
    .filter(Boolean)
    .map((utility) => utility.split(":").at(-1));

const classAttributeOpeningElement = (node) => {
  let current = node.parent;
  while (current) {
    if (current.type === "JSXAttribute") {
      return current.name.type === "JSXIdentifier" && current.name.name === "className"
        ? current.parent
        : null;
    }
    if (
      current.type === "VariableDeclarator" ||
      current.type === "CallExpression" ||
      current.type === "Program"
    ) {
      return null;
    }
    current = current.parent;
  }
  return null;
};

const hasHiddenAttribute = (openingElement) =>
  openingElement?.type === "JSXOpeningElement" &&
  openingElement.attributes.some((attribute) => {
    if (
      attribute.type !== "JSXAttribute" ||
      attribute.name.type !== "JSXIdentifier" ||
      attribute.name.name !== "aria-hidden"
    ) {
      return false;
    }
    if (attribute.value?.type === "Literal") {
      return attribute.value.value === true || attribute.value.value === "true";
    }
    return attribute.value?.type === "JSXExpressionContainer" &&
      attribute.value.expression.type === "Literal" &&
      attribute.value.expression.value === true;
  });

const uiTypographyRule = {
  meta: {
    type: "problem",
    docs: {
      description: "Enforce readable semantic typography utilities"
    },
    schema: [],
    messages: {
      incidentalHidden:
        "Incidental microtype is allowed only on a JSX marker with aria-hidden=true.",
      metadataLeading: "Metadata text must keep its readable line-height.",
      tinyText:
        "Use the semantic metadata or incidental typography utilities instead of raw 10–11px text."
    }
  },
  create(context) {
    const check = (node, value) => {
      const utilities = typographyUtilities(value);
      if (utilities.some((utility) => /^text-\[(?:10|11)px\]$/u.test(utility))) {
        context.report({ messageId: "tinyText", node });
      }
      if (
        utilities.includes("text-metadata") &&
        utilities.some((utility) => /^(?:leading-3|leading-4|leading-none|leading-tight)$/u.test(utility))
      ) {
        context.report({ messageId: "metadataLeading", node });
      }
      if (
        utilities.includes("text-incidental") &&
        !hasHiddenAttribute(classAttributeOpeningElement(node))
      ) {
        context.report({ messageId: "incidentalHidden", node });
      }
    };

    return {
      Literal: (node) => {
        if (typeof node.value === "string") check(node, node.value);
      },
      TemplateLiteral: (node) => {
        check(node, node.quasis.map((quasi) => quasi.value.raw).join(" "));
      }
    };
  }
};

const testSupportBoundaryRule = {
  meta: {
    type: "problem",
    docs: {
      description: "Keep test-support modules out of production dependency graphs"
    },
    schema: [],
    messages: {
      productionImport:
        "Production code must not import '{{specifier}}' from the tests/support boundary."
    }
  },
  create(context) {
    const importerFilename = context.physicalFilename ?? context.filename;
    const checkSource = (sourceNode) => {
      const specifier = staticString(sourceNode);
      if (specifier === null) return;
      const target = repositoryTarget(specifier, importerFilename);
      if (targets(target, "tests/support")) {
        context.report({
          node: sourceNode,
          messageId: "productionImport",
          data: { specifier }
        });
      }
    };

    return {
      ImportDeclaration: (node) => checkSource(node.source),
      ExportNamedDeclaration: (node) => checkSource(node.source),
      ExportAllDeclaration: (node) => checkSource(node.source),
      ImportExpression: (node) => checkSource(node.source),
      TSImportType: (node) => checkSource(node.source),
      TSImportEqualsDeclaration: (node) => {
        if (node.moduleReference.type === "TSExternalModuleReference") {
          checkSource(node.moduleReference.expression);
        }
      },
      CallExpression: (node) => {
        if (node.callee.type === "Identifier" && node.callee.name === "require") {
          checkSource(node.arguments[0]);
        }
      }
    };
  }
};

const architectureBoundariesRule = {
  meta: {
    type: "problem",
    docs: {
      description: "Enforce AIQSA repository dependency directions"
    },
    schema: [
      {
        type: "object",
        properties: {
          policy: {
            enum: ["components", "app-shell", "contracts", "domain", "api", "providers"]
          }
        },
        required: ["policy"],
        additionalProperties: false
      }
    ],
    messages: {
      boundary: "'{{specifier}}' import crosses an architecture boundary. {{reason}}",
      unverifiableDynamic:
        "{{kind}} uses a non-literal dependency specifier, so its architecture boundary cannot be verified. Use a string literal."
    }
  },
  create(context) {
    const [{ policy }] = context.options;
    const importerFilename = context.physicalFilename ?? context.filename;

    const checkSource = (sourceNode) => {
      const specifier = staticString(sourceNode);
      if (specifier === null) {
        return;
      }

      const reason = policyViolation(policy, {
        specifier,
        target: repositoryTarget(specifier, importerFilename)
      });
      if (reason) {
        context.report({
          node: sourceNode,
          messageId: "boundary",
          data: { reason, specifier }
        });
      }
    };

    const checkDynamicSource = (sourceNode, reportNode, kind) => {
      if (staticString(sourceNode) === null) {
        context.report({
          node: reportNode,
          messageId: "unverifiableDynamic",
          data: { kind }
        });
        return;
      }
      checkSource(sourceNode);
    };

    return {
      ImportDeclaration: (node) => checkSource(node.source),
      ExportNamedDeclaration: (node) => checkSource(node.source),
      ExportAllDeclaration: (node) => checkSource(node.source),
      ImportExpression: (node) => checkDynamicSource(node.source, node, "import()"),
      TSImportType: (node) => checkSource(node.source),
      TSImportEqualsDeclaration: (node) => {
        if (node.moduleReference.type === "TSExternalModuleReference") {
          checkSource(node.moduleReference.expression);
        }
      },
      CallExpression: (node) => {
        if (node.callee.type === "Identifier" && node.callee.name === "require") {
          checkDynamicSource(node.arguments[0], node, "require()");
        }
      }
    };
  }
};

const architectureBoundariesPlugin = {
  rules: {
    "architecture-boundaries": architectureBoundariesRule,
    "test-support-boundary": testSupportBoundaryRule,
    "ui-typography": uiTypographyRule
  }
};

export default architectureBoundariesPlugin;
