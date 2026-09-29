import { z } from "zod";

export type AgentClient = "codex" | "claude";
export type AgentConnection = "hub" | "skills" | "memory";

export const AGENT_CONNECTION_PATHS = {
  hub: "/mcp/hub",
  skills: "/mcp/skills",
  memory: "/mcp"
} as const;

export const agentConnectionMetadataSchema = z.strictObject({
  origin: z.string().max(2_048).refine((value) => {
    try {
      const url = new URL(value);
      return ["https:", "http:"].includes(url.protocol) && url.origin === value && !url.username && !url.password;
    } catch { return false; }
  }),
  hubEnabled: z.boolean()
});

export function quoteAgentCommandArgument(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

/** URLs here originate from validated canonical installation metadata. */
export function agentConnectionCommands(client: AgentClient, connection: AgentConnection, origin: string): string {
  const name = `aiqsa-${connection}`;
  const url = new URL(AGENT_CONNECTION_PATHS[connection], origin).toString();
  const quotedUrl = quoteAgentCommandArgument(url);
  return client === "codex"
    ? `codex mcp add ${name} --url ${quotedUrl}\ncodex mcp login ${name}`
    : `claude mcp add --transport http --scope user ${name} ${quotedUrl}`;
}
