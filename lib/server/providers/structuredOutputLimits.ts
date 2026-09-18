import { constants } from "node:buffer";

function configuredSize(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const value = Number(raw);
  if (!/^\d+$/u.test(raw) || !Number.isSafeInteger(value) || value < 1 || value > constants.MAX_STRING_LENGTH) {
    throw Object.assign(new Error(`structured_output_limit_config_invalid:${name}`), { code: "structured_output_limit_config_invalid" });
  }
  return value;
}

export const STRUCTURED_OUTPUT_LIMITS = Object.freeze({
  maxNameCharacters: 64,
  get maxOutputCharacters() { return configuredSize("AIQSA_STRUCTURED_OUTPUT_MAX_CHARS", 1024 * 1024); },
  maxOutputTokens: 65_536,
  get maxPromptBytes() { return configuredSize("AIQSA_STRUCTURED_INPUT_MAX_BYTES", 16 * 1024 * 1024); },
  get maxPromptCharacters() { return this.maxPromptBytes; },
  get maxSchemaBytes() { return configuredSize("AIQSA_STRUCTURED_SCHEMA_MAX_BYTES", 1024 * 1024); },
  minOutputTokens: 16
});

export function structuredOutputPromptFits(input: Readonly<{
  systemPrompt: string;
  userPrompt: string;
  responseReminder?: string;
  schema?: unknown;
}>): boolean {
  const schemaBytes = input.schema === undefined ? 0 : Buffer.byteLength(JSON.stringify(input.schema), "utf8");
  return Buffer.byteLength(input.systemPrompt, "utf8") + schemaBytes +
      Buffer.byteLength(input.userPrompt, "utf8") + Buffer.byteLength(input.responseReminder ?? "", "utf8") <=
      STRUCTURED_OUTPUT_LIMITS.maxPromptBytes;
}
