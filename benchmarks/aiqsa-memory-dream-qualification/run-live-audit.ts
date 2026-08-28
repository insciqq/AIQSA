import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { evaluateDreamLiveAudit } from "./live";

const input = process.argv[2];
if (!input || process.argv.length !== 3) {
  throw new Error("usage: run-live-audit.ts <reviewed-audit.json>");
}
const value: unknown = JSON.parse(await readFile(resolve(input), "utf8"));
process.stdout.write(`${JSON.stringify(evaluateDreamLiveAudit(value), null, 2)}\n`);
