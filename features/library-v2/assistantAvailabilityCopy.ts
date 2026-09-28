import type { AssistantCardState } from "@/components/assistants/libraryViewContracts";
import type {
  AssistantAvailability,
  AssistantAvailabilityDependency,
  AssistantAvailabilityReason,
  AssistantRowAvailability,
  AssistantRowKey,
  AssistantSummary
} from "@/lib/contracts/assistants";

export type AssistantUnavailabilityCopy = Readonly<{
  action?: Readonly<{
    kind: "mcp-settings" | "open-editor";
    label: string;
  }>;
  explanation: string;
  /** A full sentence with its period, as the chat's notice words it. */
  headline: string;
}>;

/**
 * Turns the client-safe availability projection into user copy. Dependency
 * names are deliberately ignored for shared Assistants even if a malformed or
 * future response includes them, preserving the foreign-dependency boundary.
 */
export function assistantUnavailabilityCopy(
  assistant: Pick<AssistantSummary, "availability" | "owned">
): AssistantUnavailabilityCopy | null {
  if (assistant.availability.ok) return null;

  if (assistant.availability.reason === "archived") {
    return {
      explanation: assistant.owned ? "Restore it to use it in new chats." : "It can no longer be used in new chats.",
      headline: assistant.owned ? "You archived this Assistant." : "This Assistant was archived by its owner."
    };
  }

  if (assistant.availability.reason === "knowledge_not_ready") {
    return {
      explanation: "Required Knowledge has no ready documents yet. Try again when the documents are ready.",
      headline: "Knowledge is not ready yet."
    };
  }
  if (assistant.availability.reason === "knowledge_unavailable") {
    return {
      explanation: "Required Knowledge could not be checked. Try again later or ask an administrator to check its configuration.",
      headline: "Knowledge is temporarily unavailable."
    };
  }

  if (assistant.availability.reason === "skills_access" || assistant.availability.reason === "knowledge_access") {
    const resource = assistant.availability.reason === "skills_access" ? "Skills" : "Knowledge";
    return {
      ...(assistant.owned ? { action: { kind: "open-editor" as const, label: "Edit setup" } } : {}),
      explanation: assistant.owned ? `Remove or replace unavailable ${resource} in this Assistant's setup.`
        : `Required ${resource} ${resource === "Skills" ? "are" : "is"} not available to you.`,
      headline: `This Assistant needs available ${resource}.`
    };
  }

  if (!assistant.owned) {
    if (assistant.availability.reason === "model_access") {
      return {
        explanation: "The saved model setup is not available to you.",
        headline: "This Assistant needs a model you cannot use."
      };
    }
    if (assistant.availability.reason === "search_access") {
      return {
        explanation: "A saved Search dependency is not available to you.",
        headline: "This Assistant needs Search access."
      };
    }
    return {
      explanation: "A saved tool dependency is not available to you.",
      headline: "This Assistant needs tools you cannot use."
    };
  }

  const dependencies = assistant.availability.dependencies ?? [];
  const mcpDependencies = dependencies.filter((dependency) => dependency.kind === "mcp");
  const modelDependency = dependencies.find((dependency) => dependency.kind === "model");
  const namedModelDependency = modelDependency?.name === "Saved model"
    ? undefined
    : modelDependency;

  if (assistant.availability.reason === "tools_access" && mcpDependencies.length > 0) {
    if (mcpDependencies.some((dependency) => dependency.name === "Required MCP tools")) {
      return {
        action: { kind: "open-editor", label: "Edit setup" },
        explanation: mcpDependencies.length === 1
          ? "A required MCP server is no longer available to you."
          : "One or more required MCP servers are no longer available to you.",
        headline: "This Assistant needs MCP tools you cannot use."
      };
    }
    if (mcpDependencies.length === 1) {
      const [dependency] = mcpDependencies;
      return {
        action: { kind: "mcp-settings", label: "Fix in MCP servers…" },
        explanation: `${dependency!.name} is turned off or needs attention.`,
        headline: `This Assistant needs the ${dependency!.name} tools.`
      };
    }
    return {
      action: { kind: "mcp-settings", label: "Fix in MCP servers…" },
      explanation: "Some required MCP servers are turned off or need attention.",
      headline: `This Assistant needs ${mcpDependencies.length} MCP servers.`
    };
  }

  if (assistant.availability.reason === "search_access") {
    return {
      action: { kind: "open-editor", label: "Edit setup" },
      explanation: "Choose Search sources currently available to you.",
      headline: "This Assistant needs Search access."
    };
  }

  if (assistant.availability.reason === "tools_access" && !modelDependency) {
    return {
      action: { kind: "open-editor", label: "Edit setup" },
      explanation: "Remove or replace the unavailable saved tool dependency.",
      headline: "This Assistant needs tools you cannot use."
    };
  }

  return {
    action: { kind: "open-editor", label: "Edit setup" },
    explanation: namedModelDependency
      ? `${namedModelDependency.name} or one of its saved controls needs to be changed.`
      : "Choose a model setup currently available to you.",
    headline: namedModelDependency
      ? `This Assistant needs changes for ${namedModelDependency.name}.`
      : "This Assistant needs a model you cannot use."
  };
}

/** What is missing, for an owner, when the availability names no dependency. */
const unnamedAttention: Readonly<Record<Exclude<AssistantAvailabilityReason, "archived">, string>> = {
  knowledge_access: "its Knowledge isn't available",
  knowledge_not_ready: "its Knowledge isn't ready yet",
  knowledge_unavailable: "its Knowledge can't be checked right now",
  model_access: "its model isn't available",
  search_access: "a Search source isn't available",
  skills_access: "a linked Skill isn't available",
  tools_access: "an MCP server isn't available"
};

/**
 * The status line of a gallery card (PRD 5.5): nothing when it is usable,
 * "Archived", the neutral "Not available to you" for someone else's
 * Assistant, and for the owner the missing dependencies by name, or their
 * count from three upwards.
 */
export function assistantCardStatusText(
  state: AssistantCardState,
  availability: AssistantAvailability
): string | null {
  switch (state.kind) {
    case "ready":
      return null;
    case "archived":
      return "Archived";
    case "unavailable":
      return "Not available to you";
    case "attention": {
      if (state.count >= 3) return `${state.count} dependencies unavailable`;
      if (state.names.length > 0) {
        return `Needs attention: ${state.names.join(", ")} ${state.names.length > 1 ? "aren't" : "isn't"} available`;
      }
      const reason = availability.ok || availability.reason === "archived" ? null : availability.reason;
      return `Needs attention: ${reason ? unnamedAttention[reason] : "a dependency isn't available"}`;
    }
  }
}

/** The Setup row an unavailable Assistant's reason points at. */
export function assistantBlockedRow(availability: AssistantAvailability): AssistantRowKey | null {
  if (availability.ok) return null;
  switch (availability.reason) {
    case "archived": return null;
    case "model_access": return "model";
    case "search_access": return "search";
    case "tools_access": return "tools";
    case "skills_access": return "skills";
    case "knowledge_access":
    case "knowledge_not_ready":
    case "knowledge_unavailable": return "knowledge";
  }
}

function dependencyNames(dependencies: readonly AssistantAvailabilityDependency[] | undefined): string[] {
  return [...new Set(dependencies?.map((dependency) => dependency.name) ?? [])];
}

/**
 * The availability deviation of one Setup row in the detail sheet, or null
 * when the row is usable as configured. Owners read the missing names;
 * everyone else only the fact (D-10). A fixed row that blocks the
 * Assistant reads "Not available to you"; an adjustable one falls back.
 */
export function assistantRowDeviationCopy(input: Readonly<{
  availability: AssistantAvailability;
  owned: boolean;
  row: AssistantRowKey;
  rowAvailability: AssistantRowAvailability;
}>): string | null {
  const { availability, owned, row } = input;
  if (assistantBlockedRow(availability) === row && !availability.ok) {
    if (availability.reason === "knowledge_not_ready") return "Not ready yet";
    if (availability.reason === "knowledge_unavailable") return "Can't be checked right now";
    const names = owned ? dependencyNames(availability.dependencies) : [];
    return names.length > 0
      ? `Not available to you: ${names.join(", ")}`
      : "Not available to you";
  }
  const deviation = row === "controls" || row === "skills" ? undefined : input.rowAvailability[row];
  if (!deviation) return null;
  const names = owned ? dependencyNames(deviation.dependencies) : [];
  return names.length > 0
    ? `${names.join(", ")} ${names.length > 1 ? "aren't" : "isn't"} available to you. Your default will be used.`
    : "Your default will be used";
}
