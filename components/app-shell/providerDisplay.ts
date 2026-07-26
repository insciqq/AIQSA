export function providerDisplayName(provider: string): string {
  const names: Record<string, string> = {
    anthropic: "Anthropic",
    fake: "Fake",
    gemini: "Gemini",
    openai: "OpenAI",
    openrouter: "OpenRouter"
  };

  return names[provider] ?? provider;
}
