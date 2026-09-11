import type { McpJsonObject } from "./mcp";

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
