import type { AdminProviderDeleteBlocker } from "@/lib/contracts/adminProviders";

type Blocker = Readonly<{ count: number; kind: string }>;

function plural(count: number, singular: string, pluralForm = `${singular}s`): string {
  return `${count} ${count === 1 ? singular : pluralForm}`;
}

const usedBy: Partial<Record<AdminProviderDeleteBlocker["kind"], (count: number) => string>> = {
  access_grants: (count) => plural(count, "access grant"),
  active_child_configuration: () => "models or keys that are still live",
  assistants: (count) => plural(count, "Assistant"),
  chat_defaults: (count) => plural(count, "chat default"),
  credentials: (count) => plural(count, "key"),
  group_assignments: (count) => plural(count, "group override"),
  installation_default: () => "the default chat model",
  memory_bindings: (count) => plural(count, "Memory call"),
  models: (count) => plural(count, "model"),
  run_bindings: (count) => plural(count, "running or recoverable chat"),
  search_references: (count) => plural(count, "Search source"),
  search_revision_references: () => "Search history",
  system_model: () => "a system role",
  user_assignments: (count) => plural(count, "user override"),
  user_defaults: (count) => plural(count, "user default")
};

function joinNames(names: readonly string[]): string {
  if (names.length <= 1) return names[0] ?? "";
  return `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`;
}

/**
 * Plain-language reasons why a provider or key could not be deleted, e.g.
 * "Used by 2 Assistants and a system role — reassign first." Kinds the
 * server may add later fall back to their readable name.
 */
export function describeDeleteBlockers(
  blockers: readonly Blocker[],
  subject: "key" | "model" | "provider"
): string {
  const sentences: string[] = [];
  const kinds = new Set(blockers.map((blocker) => blocker.kind));
  if (kinds.has("code_owned_template")) {
    sentences.push(subject === "model"
      ? "Built-in models can't be removed — turn it off instead."
      : "Built-in providers can't be deleted — turn it off instead.");
  }
  if (kinds.has("connection_default")) {
    sentences.push("It is the default key — choose another default first.");
  }
  const uses = blockers
    .filter((blocker) =>
      blocker.kind !== "code_owned_template" &&
      blocker.kind !== "connection_default" &&
      blocker.kind !== "resource_enabled")
    .map((blocker) => {
      const describe = usedBy[blocker.kind as AdminProviderDeleteBlocker["kind"]];
      return describe ? describe(blocker.count) : blocker.kind.replaceAll("_", " ");
    });
  if (uses.length) sentences.push(`Used by ${joinNames(uses)} — reassign first.`);
  if (kinds.has("resource_enabled") && sentences.length === 0) {
    sentences.push(`Turn the ${subject} off first.`);
  }
  return sentences.join(" ") || `The ${subject} is still in use.`;
}
