"use client";

import type { ShellComposerView } from "@/components/app-shell/powerAppShellV2Contracts";
import { UiV2Button } from "@/components/ui-v2";
import { ChatDefaultsRowsV2 } from "@/features/settings-v2/ChatDefaultsRowsV2";
import { SettingsRowV2 } from "@/features/settings-v2/SettingsV2";
import { SettingsSelectV2 } from "@/features/settings-v2/SettingsSelectV2";
import { SectionHeading } from "./LibraryV2";
import type { LibraryTabIdV2 } from "./contracts";
import { useEffect, useRef } from "react";

type ChatDefaultsView = Pick<ShellComposerView, "catalog" | "chatDefaults" | "makeModelDefault" | "useOrganizationModelDefault"> & {
  knowledge: Pick<ShellComposerView["knowledge"], "bases">;
};

export function ChatDefaultsPanelV2({ composer, onNavigate }: Readonly<{
  composer: ChatDefaultsView;
  onNavigate(tab: LibraryTabIdV2): void;
}>) {
  const defaults = composer.chatDefaults;
  return <section className="v2-studio-settings-page" data-testid="studio-chat-defaults">
    <SectionHeading description="How a new chat starts. Chats you already have keep their own choices.">Chat defaults</SectionHeading>
    <SettingsDefaultModelRowV2 composer={composer} />
    {defaults?.assistant ? <SettingsDefaultAssistantRowV2 assistant={defaults.assistant} /> : null}
    {defaults ? <ChatDefaultsRowsV2
      knowledgeBases={composer.knowledge.bases}
      knowledgePlan={defaults.knowledgePlan} mcpMode={defaults.mcpMode} skillsMode={defaults.skillsMode}
      onSkillsMode={defaults.setSkillsMode} searchPlan={defaults.searchPlan}
      searchStrategies={composer.catalog?.searchStrategies ?? []}
      onKnowledgePlan={defaults.setKnowledgePlan} onMcpMode={defaults.setMcpMode} onSearchPlan={defaults.setSearchPlan}
      onResetSearchPlan={defaults.resetSearchPlan} searchPreferenceSource={defaults.searchPreferenceSource}
      onOpenMcp={() => onNavigate("mcp")} onOpenSkills={() => onNavigate("skills")}
    /> : <p className="v2-settings-note" role="status">Defaults are unavailable until the model catalog loads.</p>}
  </section>;
}

/* Chat defaults › Default model: the personal default from the picker, or the
   organization default; the catalog stays the server-filtered source. */
function SettingsDefaultModelRowV2({ composer }: Readonly<{ composer: ChatDefaultsView }>) {
  const catalog = composer.catalog;
  const personal = catalog?.defaults.personalModelDefault ?? null;
  const models = catalog?.models ?? [];
  const value = personal ? `${personal.provider}:${personal.modelId}` : "";
  return (
    <SettingsRowV2
      description="Used for new chats until you pick another model in the composer."
      title="Default model"
    >
      <SettingsSelectV2
        disabled={!catalog || models.length === 0}
        label="Default model"
        options={[
          {
            label: catalog?.defaults.organizationModelDefault ? "Organization default" : "Installation default",
            value: ""
          },
          ...(personal && !models.some(model => `${model.provider}:${model.modelId}` === value)
            ? [{ label: "Unavailable model", value }] : []),
          ...models.map((model) => ({
            label: model.displayName,
            sub: catalog?.providers.find(provider => provider.id === model.provider)?.name,
            value: `${model.provider}:${model.modelId}`
          }))
        ]}
        value={value}
        onChange={(next) => {
          if (!next) {
            composer.useOrganizationModelDefault?.();
            return;
          }
          const model = models.find((candidate) => `${candidate.provider}:${candidate.modelId}` === next);
          if (model) composer.makeModelDefault?.(model);
        }}
      />
    </SettingsRowV2>
  );
}

type DefaultAssistantView = NonNullable<NonNullable<ChatDefaultsView["chatDefaults"]>["assistant"]>;

const NO_ASSISTANT = "";

/* Chat defaults › Assistant: a new personal chat starts with it as if the user
   had chosen it. A saved Assistant that is no longer available is named as
   such and never applied; only the user clears it. */
function SettingsDefaultAssistantRowV2({ assistant }: Readonly<{ assistant: DefaultAssistantView }>) {
  const { assistantId, assistants, assistantsState, loadAssistants } = assistant;
  const requested = useRef(false);
  useEffect(() => {
    if (assistants !== null || requested.current) return;
    requested.current = true;
    loadAssistants();
  }, [assistants, loadAssistants]);
  const choices = (assistants ?? [])
    .filter((candidate) => !candidate.archived && candidate.availability.ok)
    .sort((left, right) => Number(right.pinned) - Number(left.pinned) || left.name.localeCompare(right.name));
  const savedLabel = assistants === null
    ? assistantsState === "error" ? "Assistants didn't load" : "Loading…"
    : assistants.find((candidate) => candidate.id === assistantId)?.name ?? "Unavailable Assistant";
  return (
    <SettingsRowV2
      description="Starts every new personal chat. Projects use their own."
      testId="settings-default-assistant"
      title="Assistant"
    >
      {assistant.unavailable ? <>
        <span className="v2-settings-row-description" role="status">No longer available</span>
        <UiV2Button onClick={() => assistant.set(null)}>Clear</UiV2Button>
      </> : <>
        <SettingsSelectV2
          disabled={assistants === null}
          label="Default Assistant"
          options={[
            { label: "None", value: NO_ASSISTANT },
            ...(assistantId && !choices.some((candidate) => candidate.id === assistantId)
              ? [{ label: savedLabel, value: assistantId }] : []),
            ...choices.map((candidate) => ({ label: candidate.name, value: candidate.id }))
          ]}
          value={assistantId ?? NO_ASSISTANT}
          onChange={(next) => {
            if (next !== (assistantId ?? NO_ASSISTANT)) assistant.set(next || null);
          }}
        />
        {assistants === null && assistantsState === "error"
          ? <UiV2Button onClick={() => loadAssistants()}>Retry</UiV2Button>
          : null}
      </>}
    </SettingsRowV2>
  );
}
