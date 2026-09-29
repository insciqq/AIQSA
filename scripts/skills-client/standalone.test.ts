import { execFile } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { expect, it } from "vitest";

it("runs the published bundle outside the repository without installed dependencies", async () => {
  const directory = await mkdtemp(join(tmpdir(), "aiqsa-client-bundle-test-"));
  try {
    const file = join(directory, "skills-client.mjs");
    const output = await build({
      entryPoints: [fileURLToPath(new URL("./main.ts", import.meta.url))], outfile: file, bundle: true,
      platform: "node", format: "esm", target: "node22", write: false,
      banner: { js: "import { createRequire as __createRequire } from 'node:module'; const require = __createRequire(import.meta.url);" }
    });
    await writeFile(file, output.outputFiles![0]!.contents);
    const command = promisify(execFile);
    expect((await command(process.execPath, [file, "help"], { cwd: directory })).stdout).toContain("No command executes downloaded files.");
    const packageDirectory = join(directory, "fixture");
    await mkdir(packageDirectory);
    await writeFile(join(packageDirectory, "SKILL.md"), "---\nname: fixture\ndescription: Synthetic\n---\nUse locally.\n");
    await writeFile(join(packageDirectory, "binary.bin"), Buffer.from([0, 255, 254, 1]));
    const result = JSON.parse((await command(process.execPath, [file, "inspect", "--directory", packageDirectory], { cwd: directory })).stdout);
    expect(result).toMatchObject({ fileCount: 2 });
    expect(result.localDigest).toMatch(/^[a-f0-9]{64}$/u);
    const source = output.outputFiles![0]!.text;
    expect(source).not.toContain("lib/server/observability/");
    expect(source).not.toContain("lib/server/providers/");
  } finally { await rm(directory, { recursive: true, force: true }); }
});
