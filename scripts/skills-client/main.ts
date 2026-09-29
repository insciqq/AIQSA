import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { SKILLS_MCP_TRANSFER_MAX_BYTES, SKILLS_MCP_TOOL_RESPONSE_MAX_BYTES, type SkillStoreDownload, type SkillStoreWriteRequest } from "../../lib/contracts/skillsMcp";
import { installationOrigin, StoreSession, withSession } from "./auth";
import { ClientError, fail, installPackage, localDigest, readPackage, recordUploadOrigin, verifiedArchive } from "./files";

export const HELP = `AIQSA personal Skill package transfer (Node.js 22 or later)

Download this client from the AIQSA installation you trust. It stores its own OAuth
credentials with private permissions; it never reads Codex or Claude credentials.

node skills-client.mjs COMMAND --origin https://aiqsa.example [OPTIONS]
  login    [--write]               Open the printed consent URL in a browser
  list     [--query TEXT] [--cursor ID] [--limit NUMBER]
  get      --skill ID
  download --skill ID --version N --directory EXACT_DESTINATION
  install  --skill ID --version N --client codex|claude --name DIRECTORY_NAME
  create   --directory PACKAGE --operation-key UNIQUE_KEY --write
  update   --directory PACKAGE --skill ID --expected-version N --operation-key SAME_RETRY_KEY --write
  delete   --skill ID --expected-version N --operation-key SAME_RETRY_KEY --write
  inspect  --directory PACKAGE     Compute file manifest digest locally (no origin needed)

Common: --state-dir DIRECTORY chooses isolated client credentials.
download/install refuse conflicting local packages. An intentional replacement
requires --replace-digest DIGEST from inspect; local bytes are checked again.
install defaults to ~/.agents/skills (Codex) or ~/.claude/skills (Claude Code).
--skills-dir DIRECTORY can explicitly select an isolated native Skills directory.
No command executes downloaded files. Install does not install dependencies.
Use the same client credential directory, account, operation key and identical
package/version to recover a lost write response. Native MCP has a separate
client identity. There is no sync command; compare selected packages.
`;

type Options = Record<string, string | true>;
export function parseArguments(argv: string[]): { command: string; options: Options } {
  const command = argv[0] ?? "help";
  const options: Options = {};
  const flags = new Set(["write"]);
  const names = new Set(["origin", "state-dir", "query", "cursor", "limit", "skill", "version", "directory", "client", "name", "skills-dir", "operation-key", "expected-version", "replace-digest", "write"]);
  for (let index = 1; index < argv.length; index += 1) {
    const key = argv[index]?.slice(2);
    if (!argv[index]?.startsWith("--") || !key || !names.has(key) || options[key] !== undefined) fail("arguments_invalid");
    if (flags.has(key)) options[key] = true;
    else {
      const value = argv[++index];
      if (!value || value.startsWith("--")) fail("arguments_invalid");
      options[key] = value;
    }
  }
  return { command, options };
}
const required = (options: Options, key: string): string => typeof options[key] === "string" ? options[key] as string : fail(`missing_${key.replaceAll("-", "_")}`);
const optional = (options: Options, key: string): string | undefined => typeof options[key] === "string" ? options[key] as string : undefined;
const positive = (value: string): number => /^\d+$/u.test(value) && Number.isSafeInteger(Number(value)) && Number(value) > 0 ? Number(value) : fail("version_invalid");

export async function callTool(session: StoreSession, origin: string, name: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
  const client = new Client({ name: "AIQSA Skill transfer", version: "1.0.0" });
  const transport = new StreamableHTTPClientTransport(new URL("/mcp/skills", origin), {
    fetch: (url, init) => session.request(url instanceof Request ? url.url : String(url), init, SKILLS_MCP_TOOL_RESPONSE_MAX_BYTES),
    reconnectionOptions: { maxRetries: 0, initialReconnectionDelay: 1000, maxReconnectionDelay: 1000, reconnectionDelayGrowFactor: 1 }
  });
  try {
    await client.connect(transport);
    const result = await client.callTool({ name, arguments: args });
    const value = result.structuredContent ?? (() => {
      if (!Array.isArray(result.content)) return null;
      const block = result.content.find(item => item.type === "text");
      try { return block && "text" in block ? JSON.parse(String(block.text)) as unknown : null; } catch { return null; }
    })();
    if (!value || typeof value !== "object" || Array.isArray(value)) fail("tool_response_invalid");
    if (result.isError) {
      const code = (value as Record<string, unknown>).code;
      fail(typeof code === "string" && /^[a-z][a-z_]{0,79}$/u.test(code) ? code : "store_operation_failed");
    }
    return value as Record<string, unknown>;
  } finally { await client.close(); }
}

function destination(options: Options, command: string): string {
  if (command === "download") return resolve(required(options, "directory"));
  const client = required(options, "client");
  if (client !== "codex" && client !== "claude") fail("client_invalid");
  const name = required(options, "name");
  if (!/^[a-z0-9][a-z0-9-]{0,63}$/u.test(name)) fail("skill_directory_name_invalid");
  const root = optional(options, "skills-dir") ?? join(homedir(), client === "codex" ? ".agents" : ".claude", "skills");
  return resolve(root, name);
}

export async function run(argv = process.argv.slice(2)): Promise<unknown> {
  const { command, options } = parseArguments(argv);
  if (["help", "--help", "-h"].includes(command)) { process.stdout.write(HELP); return undefined; }
  if (command === "inspect") {
    const files = await readPackage(required(options, "directory"));
    return { localDigest: localDigest(files), fileCount: files.length, byteSize: files.reduce((sum, file) => sum + file.bytes.length, 0) };
  }
  if (!["login", "list", "get", "download", "install", "create", "update", "delete"].includes(command)) fail("command_invalid");
  const origin = installationOrigin(required(options, "origin"));
  const write = options.write === true;
  if (["create", "update", "delete"].includes(command) && !write) fail("write_option_required");
  return withSession({ origin, write, stateDirectory: optional(options, "state-dir") }, async session => {
    if (command === "login") { await session.authorize(true); return { authorized: true, writeRequested: write, writeGranted: session.hasWriteAccess() }; }
    if (command === "list") return callTool(session, origin, "list_skills", {
      ...(options.query ? { query: required(options, "query") } : {}),
      ...(options.cursor ? { cursor: required(options, "cursor") } : {}),
      ...(options.limit ? { limit: positive(required(options, "limit")) } : {})
    });
    if (command === "get") return callTool(session, origin, "get_skill", { skillId: required(options, "skill") });
    if (command === "download" || command === "install") {
      const directory = destination(options, command);
      const skillId = required(options, "skill");
      const version = positive(required(options, "version"));
      const detail = await callTool(session, origin, "download_skill", { skillId, version }) as unknown as SkillStoreDownload;
      if (detail.id !== skillId || detail.version !== version || !Array.isArray(detail.files) || !detail.archive || !/^\/mcp\/skills\/bundle\?/u.test(detail.archive.path)) fail("download_metadata_invalid");
      const response = await session.request(detail.archive.path, undefined, SKILLS_MCP_TRANSFER_MAX_BYTES);
      if (!response.ok) fail(response.status === 401 ? "login_required" : response.status === 409 ? "version_conflict" : "download_failed");
      const files = verifiedArchive(Buffer.from(await response.arrayBuffer()), detail);
      return { skillId, version, ...await installPackage({ directory, files, origin, detail, replaceDigest: optional(options, "replace-digest") }) };
    }
    const operationKey = required(options, "operation-key");
    if (!/^[A-Za-z0-9_-]{16,128}$/u.test(operationKey)) fail("operation_key_invalid");
    if (command === "delete") return callTool(session, origin, "delete_skill", {
      skillId: required(options, "skill"), expectedVersion: positive(required(options, "expected-version")), operationKey
    });
    const directory = required(options, "directory");
    const files = await readPackage(directory);
    const payload: SkillStoreWriteRequest = {
      operation: command as "create" | "update", operationKey,
      ...(command === "update" ? { skillId: required(options, "skill"), expectedVersion: positive(required(options, "expected-version")) } : {}),
      files: files.map(file => ({ path: file.path, contentBase64: file.bytes.toString("base64"), executable: file.executable === true }))
    };
    const body = JSON.stringify(payload);
    if (Buffer.byteLength(body) > SKILLS_MCP_TRANSFER_MAX_BYTES) fail("package_too_large");
    // Ensure a changed source is never represented as the snapshot selected earlier.
    if (localDigest(await readPackage(directory)) !== localDigest(files)) fail("local_changed");
    const response = await session.request("/mcp/skills/bundle", { method: "POST", headers: { "Content-Type": "application/json" }, body });
    const result = await response.json() as Record<string, unknown>;
    if (!response.ok) {
      const code = result.code ?? result.error;
      fail(typeof code === "string" && /^[a-z][a-z_]{0,79}$/u.test(code) ? code : "store_operation_failed");
    }
    if (typeof result.skillId !== "string" || typeof result.version !== "number" || typeof result.bundleDigest !== "string") fail("mutation_response_invalid");
    const digest = localDigest(files);
    const provenanceSaved = await recordUploadOrigin({ directory, origin, skillId: result.skillId, version: result.version, bundleDigest: result.bundleDigest, localDigest: digest });
    return { ...result, localDigest: digest, provenanceSaved };
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  run().then(value => { if (value !== undefined) process.stdout.write(JSON.stringify(value) + "\n"); }).catch(error => {
    // OAuth SDK/network exceptions can carry response contents. Never print them.
    process.stderr.write(JSON.stringify({ error: error instanceof ClientError ? error.message : "request_failed", retry: "For a write with an unknown outcome, keep the same operation key, version and package." }) + "\n");
    process.exitCode = 1;
  });
}
