import type { AssistantSummary } from "@/lib/contracts/assistants";

export type AssistantUnavailabilityCopy = Readonly<{
  action?: Readonly<{
    kind: "mcp-settings" | "open-editor";
    label: string;
  }>;
  explanation: string;
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

  if (!assistant.owned) {
    if (assistant.availability.reason === "model_access") {
      return {
        explanation: "The saved model setup is not available to you.",
        headline: "Needs a model you cannot use"
      };
    }
    if (assistant.availability.reason === "search_access") {
      return {
        explanation: "A saved Search dependency is not available to you.",
        headline: "Needs Search access"
      };
    }
    return {
      explanation: "A saved tool dependency is not available to you.",
      headline: "Needs tools you cannot use"
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
        headline: "Needs MCP tools you cannot use"
      };
    }
    if (mcpDependencies.length === 1) {
      const [dependency] = mcpDependencies;
      return {
        action: { kind: "mcp-settings", label: "Fix in Settings…" },
        explanation: `${dependency!.name} is turned off or needs attention.`,
        headline: `Needs the ${dependency!.name} tools`
      };
    }
    return {
      action: { kind: "mcp-settings", label: "Fix in Settings…" },
      explanation: "Some required MCP servers are turned off or need attention.",
      headline: `Needs ${mcpDependencies.length} MCP servers`
    };
  }

  if (assistant.availability.reason === "search_access") {
    return {
      action: { kind: "open-editor", label: "Edit setup" },
      explanation: "Choose Search sources currently available to you.",
      headline: "Needs Search access"
    };
  }

  if (assistant.availability.reason === "tools_access" && !modelDependency) {
    return {
      action: { kind: "open-editor", label: "Edit setup" },
      explanation: "Remove or replace the unavailable saved tool dependency.",
      headline: "Needs tools you cannot use"
    };
  }

  return {
    action: { kind: "open-editor", label: "Edit setup" },
    explanation: namedModelDependency
      ? `${namedModelDependency.name} or one of its saved controls needs to be changed.`
      : "Choose a model setup currently available to you.",
    headline: namedModelDependency
      ? `Needs changes for ${namedModelDependency.name}`
      : "Needs a model you cannot use"
  };
}
