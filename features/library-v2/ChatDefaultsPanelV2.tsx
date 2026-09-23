"use client";

import type { ShellComposerView } from "@/components/app-shell/powerAppShellV2Contracts";
import { ChatDefaultsRowsV2 } from "@/features/settings-v2/ChatDefaultsRowsV2";
import { SettingsRowV2 } from "@/features/settings-v2/SettingsV2";
import { SettingsSelectV2 } from "@/features/settings-v2/SettingsSelectV2";
import { SectionHeading } from "./LibraryV2";
import type { LibraryTabIdV2 } from "./contracts";

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
