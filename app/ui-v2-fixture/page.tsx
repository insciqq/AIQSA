import { isTestAuthEnabled } from "@/lib/server/auth/config";
import type { Metadata } from "next";
import { notFound } from "next/navigation";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  robots: {
    follow: false,
    index: false
  },
  title: "UI v2 fixture"
};

type UiV2FixtureQuery = Readonly<{
  fixture?: string;
  state?: string;
}>;

function fixtureState<const States extends readonly string[]>(
  value: string | undefined,
  states: States,
  fallback: States[number]
): States[number] {
  return value !== undefined && states.includes(value) ? value as States[number] : fallback;
}

async function renderFixture(query: UiV2FixtureQuery) {
  if (query.fixture === "navigation") {
    const state = fixtureState(
      query.state,
      ["default", "destinations", "empty", "error", "loading", "search"] as const,
      "default"
    );
    const { NavigationV2Gallery } = await import("./_fixtures/NavigationV2Gallery");
    return <NavigationV2Gallery state={state} />;
  }
  if (query.fixture === "conversation") {
    const state = fixtureState(
      query.state,
      ["basic", "containment", "earlier", "empty", "error", "jump", "loading", "unavailable"] as const,
      "basic"
    );
    const { ConversationV2Gallery } = await import("./_fixtures/ConversationV2Gallery");
    return <ConversationV2Gallery state={state} />;
  }
  if (query.fixture === "run-lifecycle") {
    const { RunLifecycleV2Gallery } = await import("./_fixtures/RunLifecycleV2Gallery");
    return <RunLifecycleV2Gallery />;
  }
  if (query.fixture === "composer") {
    const state = fixtureState(
      query.state,
      [
        "add",
        "assistant",
        "assistant-knowledge",
        "attachments",
        "default",
        "error",
        "knowledge",
        "model",
        "project-knowledge",
        "zero"
      ] as const,
      "default"
    );
    const { ComposerV2Gallery } = await import("./_fixtures/ComposerV2Gallery");
    return <ComposerV2Gallery state={state} />;
  }
  if (query.fixture === "answer-outputs") {
    const state = fixtureState(
      query.state,
      [
        "approval",
        "citation-assistant",
        "citation-personal",
        "citation-project",
        "citation-visual",
        "complete",
        "empty",
        "memory",
        "reasoning"
      ] as const,
      "complete"
    );
    const { AnswerOutputsV2Gallery } = await import("./_fixtures/AnswerOutputsV2Gallery");
    return <AnswerOutputsV2Gallery state={state} />;
  }
  if (query.fixture === "branches") {
    const state = fixtureState(
      query.state,
      ["default", "drawer", "edit", "error", "linear", "loading", "streaming"] as const,
      "default"
    );
    const { BranchesV2Gallery } = await import("./_fixtures/BranchesV2Gallery");
    return <BranchesV2Gallery state={state} />;
  }
  if (query.fixture === "library") {
    const state = fixtureState(
      query.state,
      ["assistants", "dirty", "files", "knowledge", "memory", "memory-disabled", "skills"] as const,
      "assistants"
    );
    const { LibraryV2Gallery } = await import("./_fixtures/LibraryV2Gallery");
    return <LibraryV2Gallery state={state} />;
  }
  if (query.fixture === "assistants") {
    const state = fixtureState(
      query.state,
      ["advanced", "dirty", "editor", "empty", "error", "list", "loading"] as const,
      "list"
    );
    const { AssistantsV2Gallery } = await import("./_fixtures/AssistantsV2Gallery");
    return <AssistantsV2Gallery state={state} />;
  }
  if (query.fixture === "settings") {
    const state = fixtureState(
      query.state,
      ["appearance", "archived", "dirty", "mcp", "memory"] as const,
      "appearance"
    );
    const { SettingsV2Gallery } = await import("./_fixtures/SettingsV2Gallery");
    return <SettingsV2Gallery state={state} />;
  }
  if (query.fixture === "projects") {
    const state = fixtureState(
      query.state,
      ["contributor", "empty", "error", "landing", "overview", "setup", "viewer"] as const,
      "landing"
    );
    const { ProjectsV2Gallery } = await import("./_fixtures/ProjectsV2Gallery");
    return <ProjectsV2Gallery state={state} />;
  }
  notFound();
}

export default async function UiV2FixturePage({
  searchParams
}: {
  searchParams: Promise<UiV2FixtureQuery>;
}) {
  if (!isTestAuthEnabled()) notFound();
  return renderFixture(await searchParams);
}
