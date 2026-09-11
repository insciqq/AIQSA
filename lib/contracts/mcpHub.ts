import type { McpJsonObject } from "./mcp";
import { z } from "zod";

/** Consume only the public canonical resource URL from OAuth metadata. */
export const mcpHubResourceMetadataSchema = z.object({
  resource: z.string().max(2_048).refine((value) => {
    try {
      const url = new URL(value);
      return ["https:", "http:"].includes(url.protocol) && url.pathname === "/mcp/hub" &&
        !url.username && !url.password && !url.search && !url.hash;
    } catch { return false; }
  })
});

export type McpHubToolDescriptor = Readonly<{
  annotations?: Readonly<{
    destructiveHint?: boolean;
    idempotentHint?: boolean;
    openWorldHint?: boolean;
    readOnlyHint?: boolean;
    title?: string;
  }>;
  description: string | null;
  input_schema: McpJsonObject;
  name: string;
  output_schema?: McpJsonObject;
  server_name: string;
  title?: string;
  tool_id: string;
  tool_version: string;
}>;

export type McpHubDiscoveryResult = Readonly<{
  incomplete: boolean;
  message: string;
  schema_version: 1;
  tools: readonly McpHubToolDescriptor[];
}>;
