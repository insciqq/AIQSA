import {
  ConversationV2Gallery,
  type ConversationGalleryState
} from "@/features/conversation-v2/ConversationV2Gallery";
import {
  NavigationV2Gallery,
  type NavigationGalleryState
} from "@/features/navigation-v2/NavigationV2Gallery";
import { RunLifecycleV2Gallery } from "@/features/run-lifecycle-v2/RunLifecycleV2Gallery";
import {
  ComposerV2Gallery,
  type ComposerGalleryState
} from "@/features/composer-v2/ComposerV2Gallery";
import {
  AnswerOutputsV2Gallery,
  type AnswerOutputsGalleryState
} from "@/features/answer-outputs-v2/AnswerOutputsV2Gallery";
import {
  BranchesV2Gallery,
  type BranchesGalleryState
} from "@/features/branches-v2/BranchesV2Gallery";
import { generatedArtifactsFeatureMode } from "@/lib/server/featureFlags/generatedArtifacts";
import type { ArtifactsFixtureState } from "@/features/artifacts-v2/fixtures";
import type { LibraryGalleryStateV2 } from "@/features/library-v2/LibraryV2Gallery";
import type { SettingsGalleryStateV2 } from "@/features/settings-v2/SettingsV2Gallery";
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

export default async function UiV2FixturePage({
  searchParams
}: {
  searchParams: Promise<{ fixture?: string; state?: string }>;
}) {
  if (!isTestAuthEnabled()) {
    notFound();
  }

  const query = await searchParams;
  if (query.fixture === "navigation") {
    const state = ["default", "empty", "error", "loading", "search"].includes(
      query.state ?? ""
    ) ? (query.state as NavigationGalleryState) : "default";
    return <NavigationV2Gallery state={state} />;
  }
  if (query.fixture === "conversation") {
    const state = [
      "basic",
      "containment",
      "earlier",
      "empty",
      "error",
      "loading",
      "unavailable"
    ].includes(query.state ?? "") ? (query.state as ConversationGalleryState) : "basic";
    return <ConversationV2Gallery state={state} />;
  }
  if (query.fixture === "run-lifecycle") {
    return <RunLifecycleV2Gallery />;
  }
  if (query.fixture === "composer") {
    const state = [
      "assistant",
      "attachments",
      "capabilities",
      "default",
      "error",
      "model",
      "zero"
    ].includes(query.state ?? "") ? (query.state as ComposerGalleryState) : "default";
    return <ComposerV2Gallery state={state} />;
  }
  if (query.fixture === "answer-outputs") {
    const state = ["approval", "complete", "empty", "reasoning"].includes(query.state ?? "")
      ? (query.state as AnswerOutputsGalleryState)
      : "complete";
    return <AnswerOutputsV2Gallery state={state} />;
  }
  if (query.fixture === "branches") {
    const state = ["default", "drawer", "edit", "error", "linear", "loading", "streaming"].includes(
      query.state ?? ""
    ) ? (query.state as BranchesGalleryState) : "default";
    return <BranchesV2Gallery state={state} />;
  }
  if (query.fixture === "artifacts") {
    if (generatedArtifactsFeatureMode(process.env) !== "fixtures") {
      notFound();
    }
    const state = [
      "cancelled",
      "default",
      "drawer",
      "failed",
      "generating",
      "preview-unavailable",
      "stack"
    ].includes(query.state ?? "") ? (query.state as ArtifactsFixtureState) : "default";
    const { ArtifactsV2Gallery } = await import(
      "@/features/artifacts-v2/ArtifactsV2Gallery"
    );
    return <ArtifactsV2Gallery state={state} />;
  }
  if (query.fixture === "library") {
    const state = [
      "assistants",
      "dirty",
      "files",
      "knowledge",
      "memory",
      "memory-disabled"
    ].includes(query.state ?? "") ? (query.state as LibraryGalleryStateV2) : "assistants";
    const { LibraryV2Gallery } = await import("@/features/library-v2/LibraryV2Gallery");
    return <LibraryV2Gallery state={state} />;
  }
  if (query.fixture === "settings") {
    const state = ["appearance", "dirty", "mcp"].includes(query.state ?? "")
      ? (query.state as SettingsGalleryStateV2)
      : "appearance";
    const { SettingsV2Gallery } = await import("@/features/settings-v2/SettingsV2Gallery");
    return <SettingsV2Gallery state={state} />;
  }
  notFound();
}
