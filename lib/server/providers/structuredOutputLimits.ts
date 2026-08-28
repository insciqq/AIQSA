export const STRUCTURED_OUTPUT_LIMITS = Object.freeze({
  maxNameCharacters: 64,
  maxOutputCharacters: 65_536,
  maxOutputTokens: 8_192,
  maxPromptBytes: 256_000,
  maxPromptCharacters: 256_000,
  maxSchemaBytes: 32 * 1024,
  minOutputTokens: 16
});

export function structuredOutputPromptFits(input: Readonly<{
  systemPrompt: string;
  userPrompt: string;
}>): boolean {
  return input.systemPrompt.length + input.userPrompt.length <=
      STRUCTURED_OUTPUT_LIMITS.maxPromptCharacters &&
    Buffer.byteLength(input.systemPrompt, "utf8") +
      Buffer.byteLength(input.userPrompt, "utf8") <=
      STRUCTURED_OUTPUT_LIMITS.maxPromptBytes;
}
