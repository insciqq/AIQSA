import { McpServer, type CallToolResult } from "@modelcontextprotocol/server";
import { createSkillBundle, parseSkillMarkdown } from "../skills/bundle";
import { SkillBundleError } from "../skills/bundleErrors";
import { SKILLS_MCP_TRANSFER_MAX_BYTES } from "../../contracts/skillsMcp";
import { createSkillSchema, deleteSkillSchema, downloadSkillSchema, getSkillSchema, listSkillsSchema, updateSkillSchema } from "./contracts";
import { SkillsStoreError, type SkillsStoreAuthority, type SkillsStoreService } from "./service";

function result(value: object, isError = false): CallToolResult {
  return { content: [{ type: "text", text: JSON.stringify(value) }], structuredContent: { ...value }, ...(isError ? { isError: true } : {}) };
}
export function skillsStoreErrorCode(error: unknown): string {
  return error instanceof SkillsStoreError ? error.code : error instanceof SkillBundleError ? error.issue.code : "skills_store_unavailable";
}
function transferDescriptor(operation: "create" | "update", fields: { operationKey: string; skillId?: string; expectedVersion?: number }) {
  return {
    transfer: { path: "/mcp/skills/bundle", method: "POST", contentType: "application/json", maxBytes: SKILLS_MCP_TRANSFER_MAX_BYTES,
      body: { operation, ...fields },
      files: "Add every package file as {path, contentBase64, executable}, including root SKILL.md. Use the local transfer client; never copy binary payloads or OAuth tokens into model context." }
  };
}
export function createSkillsMcpServer(input: { service: SkillsStoreService; authority: SkillsStoreAuthority }): McpServer {
  const server = new McpServer({ name: "aiqsa-skills", version: "1.0.0" }, {
    instructions: "Personal Skill package store. Download complete packages and install locally; uploaded scripts are never executed by this server. Sync is performed by the agent using ordinary version-guarded operations. Names alone do not prove identity. Never delete merely because a package is absent on one side. Keep binary transfer and OAuth tokens outside model context. For full packages use the local AIQSA transfer client described in /AGENTS.md. Reuse an operationKey only for the exact same write after a lost response, through the same OAuth client/connection. Native MCP and the transfer helper have separate client-bound receipts."
  });
  const call = async (operation: () => Promise<object>) => {
    try { return result(await operation()); }
    catch (error) { return result({ code: skillsStoreErrorCode(error) }, true); }
  };
  server.registerTool("list_skills", {
    description: "List your personal Skill packages, including chat-disabled packages. Set includeArchived to include archives. Shared packages owned by other users are excluded.",
    annotations: { readOnlyHint: true, idempotentHint: true }, inputSchema: listSkillsSchema
  }, (args) => call(() => input.service.list(input.authority, args)));
  server.registerTool("get_skill", {
    description: "Read current personal Skill metadata and a complete file manifest with SHA-256 checksums. No package bytes are returned.",
    annotations: { readOnlyHint: true, idempotentHint: true }, inputSchema: getSkillSchema
  }, (args) => call(() => input.service.get(input.authority, args.skillId)));
  server.registerTool("download_skill", {
    description: "Prepare an authenticated full ZIP download of one exact version. The transfer client fetches the archive directly, verifies its checksum and installs locally.",
    annotations: { readOnlyHint: true, idempotentHint: true }, inputSchema: downloadSkillSchema
  }, (args) => call(() => input.service.download(input.authority, args.skillId, args.version)));
  server.registerTool("create_skill", {
    description: "Create a new private personal Skill. Provide markdown only for a complete standalone SKILL.md; omit it to get the full-package transfer descriptor. Never drop supplemental files. Existing matching names are never overwritten.",
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true }, inputSchema: createSkillSchema
  }, (args) => call(async () => {
    await input.authority.assertActive("write");
    return args.markdown === undefined ? transferDescriptor("create", args)
      : input.service.write(input.authority, { action: "create", operationKey: args.operationKey,
        bundle: createSkillBundle(parseSkillMarkdown(Buffer.from(args.markdown), "skill")) });
  }));
  server.registerTool("update_skill", {
    description: "Replace the entire package at expectedVersion, preserving its identity and library settings. Omit markdown for the full-package transfer descriptor. A conflict must be resolved before retrying with a new version/key.",
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true }, inputSchema: updateSkillSchema
  }, (args) => call(async () => {
    await input.authority.assertActive("write");
    return args.markdown === undefined ? transferDescriptor("update", args)
      : input.service.write(input.authority, { action: "update", operationKey: args.operationKey, skillId: args.skillId,
        expectedVersion: args.expectedVersion, bundle: createSkillBundle(parseSkillMarkdown(Buffer.from(args.markdown), "skill")) });
  }));
  server.registerTool("delete_skill", {
    description: "Delete your personal Skill using its exact current version and the normal AIQSA dependency lifecycle. Only do this for explicit user deletion intent. Previously downloaded copies remain local.",
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true }, inputSchema: deleteSkillSchema
  }, (args) => call(() => input.service.delete(input.authority, args)));
  return server;
}
