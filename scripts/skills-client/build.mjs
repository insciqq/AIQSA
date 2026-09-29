import { build } from "esbuild";
import { fileURLToPath } from "node:url";

await build({
  entryPoints: [fileURLToPath(new URL("./main.ts", import.meta.url))],
  outfile: fileURLToPath(new URL("../../public/agents/skills-client.mjs", import.meta.url)),
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  legalComments: "inline",
  minify: false,
  banner: { js: "// AIQSA personal Skill transfer client. Source: https://github.com/insciqq/AIQSA/tree/main/scripts/skills-client\nimport { createRequire as __createRequire } from 'node:module'; const require = __createRequire(import.meta.url);" }
});
