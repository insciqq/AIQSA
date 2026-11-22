/** Shared pieces of the smokes that drive the Codex CLI against AIQSA (inbound MCP, paid Workspace stands). */

function unquoteTomlString(value: string): string | null {
  const trimmed = value.trim();
  const match = trimmed.match(/^(["'])(.*)\1$/u);
  return match ? match[2] ?? null : null;
}

function assignment(line: string): Readonly<{ key: string; raw: string }> | null {
  const match = line.match(/^\s*([A-Za-z0-9_-]+)\s*=\s*(.+?)\s*$/u);
  if (!match || !match[1] || !match[2] || match[2].includes("#")) return null;
  return { key: match[1], raw: match[2] };
}

/** The reviewed codex-lb provider of the user's Codex config as `-c` overrides; nothing else of the config leaves it. */
export function codexLbOverridesFromConfig(config: string): Readonly<{
  args: readonly string[];
  configuredModel: string;
}> {
  const topLevel = new Map<string, string>();
  const provider = new Map<string, string>();
  let section = "";

  for (const line of config.split(/\r?\n/u)) {
    const sectionMatch = line.match(/^\s*\[([^\]]+)\]\s*$/u);
    if (sectionMatch) {
      section = sectionMatch[1] ?? "";
      continue;
    }
    const parsed = assignment(line);
    if (!parsed) continue;
    if (!section) topLevel.set(parsed.key, parsed.raw);
    if (section === "model_providers.codex-lb") {
      provider.set(parsed.key, parsed.raw);
    }
  }

  const providerName = unquoteTomlString(topLevel.get("model_provider") ?? "");
  const configuredModel = unquoteTomlString(topLevel.get("model") ?? "");
  if (providerName !== "codex-lb" || !configuredModel) {
    throw new Error("codex_smoke_codex_lb_profile_required");
  }

  const required = [
    "name",
    "base_url",
    "wire_api",
    "env_key",
    "requires_openai_auth"
  ] as const;
  if (required.some((key) => !provider.has(key))) {
    throw new Error("codex_smoke_codex_lb_profile_incomplete");
  }
  if (unquoteTomlString(provider.get("env_key") ?? "") !== "CODEX_LB_API_KEY") {
    throw new Error("codex_smoke_codex_lb_env_invalid");
  }
  const baseUrl = unquoteTomlString(provider.get("base_url") ?? "");
  try {
    const parsed = new URL(baseUrl ?? "");
    if (!(["http:", "https:"].includes(parsed.protocol)) ||
      parsed.username || parsed.password || parsed.hash) {
      throw new Error("invalid");
    }
  } catch {
    throw new Error("codex_smoke_codex_lb_url_invalid");
  }

  const allowed = [
    "name",
    "base_url",
    "wire_api",
    "supports_websockets",
    "env_key",
    "requires_openai_auth"
  ] as const;
  const args = ["-c", `model_provider=${topLevel.get("model_provider")}`];
  for (const key of allowed) {
    const raw = provider.get(key);
    if (raw) args.push("-c", `model_providers.codex-lb.${key}=${raw}`);
  }
  return { args, configuredModel };
}

/** The installation's own consent URL in bounded child output, or null. */
export function findAuthorizationUrl(text: string, issuer: string): string | null {
  const expected = new URL(issuer);
  const candidates = text.match(/https?:\/\/[^\s\u0000-\u001f"'<>]+/gu) ?? [];
  for (const candidate of candidates) {
    try {
      const parsed = new URL(candidate.replace(/[),.;]+$/u, ""));
      if (parsed.origin === expected.origin && parsed.pathname === "/oauth/authorize") {
        return parsed.toString();
      }
    } catch {
      // Continue scanning bounded child output for the actual authorization URL.
    }
  }
  return null;
}
