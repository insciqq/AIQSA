"use client";

import type { AssistantEditorView } from "@/components/assistants/libraryViewContracts";
import { SkillLibraryDialog } from "@/components/skills/SkillLibraryDialog";
import { UiV2Button, UiV2IconButton, UiV2Switch } from "@/components/ui-v2";
import { SettingsSegmentV2 } from "@/features/settings-v2/ChatDefaultsRowsV2";
import type { AssistantSkillDelivery, AssistantSkillLink } from "@/lib/contracts/assistants";
import { SKILL_ASSISTANT_MAX_AVAILABLE, SKILL_MAX_PINNED } from "@/lib/contracts/skills";
import { useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { assistantSkillCounts } from "./assistantEditorSummaries";

const deliveryOptions = [
  { label: "Always", value: "always" },
  { label: "On demand", value: "on_demand" }
] as const satisfies readonly { label: string; value: AssistantSkillDelivery }[];

export const ASSISTANT_SKILL_LIMITS_TEXT =
  `Up to ${SKILL_MAX_PINNED} Always and ${SKILL_ASSISTANT_MAX_AVAILABLE} On demand Skills. Always Skills are delivered in this order.`;

/**
 * One list of Skill links. Each link is delivered Always or On demand; the
 * switch decides whether the model may load other Skills on demand. Links are
 * delivered in list order; there is no separate order number.
 */
export function AssistantSkillsRowV2({ editor, locked }: Readonly<{
  editor: AssistantEditorView;
  locked: boolean;
}>) {
  const [pickerOpen, setPickerOpen] = useState(false);
  const opener = useRef<HTMLButtonElement>(null);
  const limitsId = useId();
  const switchCaptionId = useId();
  const value = editor.draft.rows.skills.value;
  const links = value.links;
  const counts = assistantSkillCounts(editor.draft.rows);
  const names = new Map(editor.options.selectedSkills.map((skill) => [skill.id, skill]));
  const change = (next: Partial<typeof value>) => editor.onRowChange("skills", { value: { ...value, ...next } });
  const setDelivery = (skillId: string, delivery: AssistantSkillDelivery) =>
    change({ links: links.map((link) => link.skillId === skillId ? { ...link, delivery } : link) });
  const select = (ids: readonly string[]) => {
    let always = counts.always;
    change({
      links: ids.map((skillId): AssistantSkillLink => {
        const existing = links.find((link) => link.skillId === skillId);
        if (existing) return existing;
        // New links are Always while Always has room, then On demand.
        const delivery: AssistantSkillDelivery = always < SKILL_MAX_PINNED ? "always" : "on_demand";
        if (delivery === "always") always += 1;
        return { delivery, skillId };
      })
    });
  };

  return (
    <div className="v2-assistant-skills">
      <div className="v2-assistant-skills-switch">
        <span>
          <strong>Load Skills on demand</strong>
          <small id={switchCaptionId}>Off keeps Always Skills and disables loading others</small>
        </span>
        <UiV2Switch
          aria-describedby={switchCaptionId}
          checked={value.mode === "auto"}
          disabled={locked}
          label="Load Skills on demand"
          onChange={(on) => change({ mode: on ? "auto" : "off" })}
        />
      </div>
      {links.length > 0 ? (
        <ul aria-label="Linked Skills" className="v2-assistant-skill-links">
          {links.map((link) => {
            const skill = names.get(link.skillId);
            const name = skill?.name ?? "Selected Skill";
            return (
              <li data-unavailable={skill?.available === false || undefined} key={link.skillId}>
                <strong className="v2-assistant-skill-name">{name}</strong>
                {skill?.available === false ? (
                  <small className="v2-assistant-skill-note">Unavailable · remove it or ask for access</small>
                ) : null}
                <SettingsSegmentV2
                  label={`Delivery for ${name}`}
                  options={deliveryOptions}
                  value={link.delivery}
                  onChange={(delivery) => setDelivery(link.skillId, delivery)}
                />
                <UiV2IconButton
                  disabled={locked}
                  icon="close"
                  label={`Remove ${name}`}
                  onClick={() => change({ links: links.filter((candidate) => candidate.skillId !== link.skillId) })}
                />
              </li>
            );
          })}
        </ul>
      ) : <p className="v2-assistant-setup-note">No Skills linked.</p>}
      <div className="v2-assistant-skills-footer">
        <UiV2Button disabled={locked} icon="plus" ref={opener} onClick={() => setPickerOpen(true)}>Add Skills…</UiV2Button>
        <span
          aria-describedby={limitsId}
          className="v2-assistant-skills-count v2-focusable"
          data-tooltip={ASSISTANT_SKILL_LIMITS_TEXT}
          data-tooltip-side="left"
          tabIndex={0}
        >
          {counts.always} always · {counts.onDemand} on demand
        </span>
        <span className="v2-sr-only" id={limitsId}>{ASSISTANT_SKILL_LIMITS_TEXT}</span>
      </div>
      {pickerOpen ? createPortal(
        <SkillLibraryDialog
          assistantSelection
          restoreFocus={() => opener.current}
          selectedIds={links.map((link) => link.skillId)}
          selectedSkills={editor.options.selectedSkills}
          selectionLimit={SKILL_MAX_PINNED + SKILL_ASSISTANT_MAX_AVAILABLE}
          onClose={() => setPickerOpen(false)}
          onSelectionChange={(ids) => { if (!locked) select(ids); }}
        />,
        document.body
      ) : null}
    </div>
  );
}
