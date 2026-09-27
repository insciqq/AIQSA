import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync
} from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = realpathSync(fileURLToPath(new URL("..", import.meta.url)));
const require = createRequire(import.meta.url);
const eslint = path.join(path.dirname(require.resolve("eslint/package.json")), "bin/eslint.js");
const args = process.argv.slice(2);

function entries(relative) {
  try {
    return readdirSync(path.join(root, relative), { withFileTypes: true })
      .sort((left, right) => left.name.localeCompare(right.name));
  } catch (error) {
    if (error.code === "ENOENT") return [];
    throw error;
  }
}

function cacheLocation() {
  const inputs = createHash("sha256");
  const add = (value) => inputs.update(value).update("\0");
  add(process.version);
  for (const relative of ["eslint.config.mjs", "package.json", "package-lock.json", "scripts/lint.mjs"]) {
    add(relative);
    add(readFileSync(path.join(root, relative)));
  }

  function inventory(relative, contents) {
    add(relative);
    for (const entry of entries(relative)) {
      const child = `${relative}/${entry.name}`;
      add(`${entry.isDirectory() ? "directory" : entry.isSymbolicLink() ? "symlink" : "file"}:${child}`);
      if (entry.isDirectory()) inventory(child, contents);
      else if (contents && entry.isFile()) add(readFileSync(path.join(root, child)));
    }
  }

  // ESLint's config hash does not include the implementation of local plugins.
  inventory("scripts/eslint", true);
  // Next's no-html-link-for-pages rule reads these directory entries, including
  // nested filenames other than page.tsx. Source contents are cached by ESLint.
  for (const relative of ["app", "pages", "src/app", "src/pages"]) inventory(relative, false);

  const checkout = createHash("sha256").update(root).digest("hex");
  const directory = path.resolve(root, process.env.AIQSA_ESLINT_CACHE_DIR || "node_modules/.cache/aiqsa/eslint", checkout);
  const filename = `${inputs.digest("hex")}.eslintcache`;
  mkdirSync(directory, { recursive: true });
  // A new input signature needs a fresh cache, not an ever-growing history.
  for (const entry of readdirSync(directory)) {
    if (/^[a-f0-9]{64}\.eslintcache$/.test(entry) && entry !== filename) {
      rmSync(path.join(directory, entry), { force: true });
    }
  }
  return path.join(directory, filename);
}

// Native cache overrides bypass our input fingerprint. Run custom configurations
// and cache locations/strategies uncached; AIQSA_ESLINT_CACHE_DIR relocates the
// managed cache without weakening its invalidation rules.
const nativeCacheValueOptions = ["--cache-location", "--cache-file", "--cache-strategy"];
const unmanagedOptions = args.some((arg) =>
  arg === "-c" || (arg.startsWith("-c") && !arg.startsWith("--")) ||
  ["--config", "--rule", ...nativeCacheValueOptions]
    .some((option) => arg === option || arg.startsWith(`${option}=`)) ||
  arg === "--no-config-lookup"
);
const cacheArgs = args.includes("--no-cache") || unmanagedOptions
  ? []
  : ["--cache", "--cache-strategy", "content", "--cache-location", cacheLocation()];
function uncachedArguments() {
  const forwarded = [];
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (nativeCacheValueOptions.includes(arg)) {
      // Leave malformed options to ESLint's parser and preserve its exit code.
      if (!args[index + 1] || args[index + 1].startsWith("-")) return [...args, "--no-cache"];
      index += 1;
    } else if (nativeCacheValueOptions.some((option) => arg.startsWith(`${option}=`))) {
      continue;
    } else if (arg === "--cache" || arg === "--no-cache" || arg.startsWith("--cache=")) {
      if (args[index + 1] === "true" || args[index + 1] === "false") index += 1;
    } else {
      forwarded.push(arg);
    }
  }
  return [...forwarded, "--no-cache"];
}
const result = spawnSync(process.execPath, [
  eslint, ".", "--max-warnings=0", ...cacheArgs,
  ...(unmanagedOptions ? uncachedArguments() : args)
], {
  cwd: root,
  stdio: "inherit"
});
if (result.error) throw result.error;
if (result.signal) process.kill(process.pid, result.signal);
else process.exitCode = result.status ?? 1;
