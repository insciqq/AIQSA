"use client";

import type { AssistantEditorView } from "@/components/assistants/libraryViewContracts";
import { UiV2Button, UiV2Icon } from "@/components/ui-v2";
import { AssistantAvatarV2 } from "@/components/ui-v2/AssistantAvatarV2";
import { useMenuDismissalV2 } from "@/components/ui-v2/useMenuDismissalV2";
import {
  ASSISTANT_AVATAR_PALETTES,
  ASSISTANT_AVATAR_SHAPES,
  ASSISTANT_CATEGORIES,
  ASSISTANT_CATEGORY_LABELS,
  ASSISTANT_DESCRIPTION_MAX_LENGTH,
  ASSISTANT_NAME_MAX_LENGTH,
  type AssistantAvatarRecipe,
  type AssistantAvatarRotation,
  type AssistantCategory
} from "@/lib/contracts/assistants";
import { useEffect, useId, useRef, useState, type KeyboardEvent } from "react";

const capitalized = (value: string) => value.charAt(0).toLocaleUpperCase() + value.slice(1);

/** One recipe choice at a time; arrows move and choose, as a radio group does. */
function RecipeChoiceGroup<T extends string>({ label, onChange, options, preview, value }: Readonly<{
  label: string;
  onChange(value: T): void;
  options: readonly T[];
  preview(value: T): AssistantAvatarRecipe;
  value: T;
}>) {
  const onKeyDown = (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
    const next = event.key === "ArrowRight" || event.key === "ArrowDown" ? (index + 1) % options.length
      : event.key === "ArrowLeft" || event.key === "ArrowUp" ? (index - 1 + options.length) % options.length
        : event.key === "Home" ? 0 : event.key === "End" ? options.length - 1 : null;
    if (next === null) return;
    event.preventDefault();
    onChange(options[next]!);
    (event.currentTarget.parentElement?.children[next] as HTMLElement | undefined)?.focus();
  };
  return (
    <div aria-label={label} className="v2-assistant-recipe-choices" role="radiogroup">
      {options.map((option, index) => (
        <button
          aria-checked={option === value}
          aria-label={capitalized(option)}
          className="v2-assistant-recipe-choice v2-focusable"
          data-recipe-choice={option === value || undefined}
          key={option}
          role="radio"
          tabIndex={option === value ? 0 : -1}
          type="button"
          onClick={() => onChange(option)}
          onKeyDown={(event) => onKeyDown(event, index)}
        >
          <AssistantAvatarV2 recipe={preview(option)} size={28} />
        </button>
      ))}
    </div>
  );
}

/** "Change": palette, shape and rotation of the generated avatar; no uploads. */
function AvatarRecipePickerV2({ disabled, onChange, onRandomize, recipe }: Readonly<{
  disabled: boolean;
  onChange(recipe: AssistantAvatarRecipe): void;
  onRandomize(): void;
  recipe: AssistantAvatarRecipe;
}>) {
  const [open, setOpen] = useState(false);
  const panelId = useId();
  const { closeForAction, menuRef, triggerRef } = useMenuDismissalV2<HTMLButtonElement, HTMLDivElement>({
    onClose: () => setOpen(false),
    open
  });
  useEffect(() => {
    if (open) menuRef.current?.querySelector<HTMLElement>("[role='radio'][aria-checked='true']")?.focus();
  }, [menuRef, open]);
  const rotation = recipe.rotations[1];
  return (
    <div className="v2-assistant-avatar-picker">
      <AssistantAvatarV2 recipe={recipe} size={64} />
      <button
        aria-controls={open ? panelId : undefined}
        aria-expanded={open}
        aria-haspopup="dialog"
        className="v2-assistant-avatar-change v2-focusable"
        disabled={disabled}
        ref={triggerRef}
        type="button"
        onClick={() => setOpen((current) => !current)}
      >
        <UiV2Icon name="wand" />Change
      </button>
      {open ? (
        <div aria-label="Avatar" className="v2-assistant-recipe-popover" id={panelId} ref={menuRef} role="dialog">
          <p>Color</p>
          <RecipeChoiceGroup
            label="Color"
            options={ASSISTANT_AVATAR_PALETTES}
            preview={(paletteId) => ({ ...recipe, paletteId })}
            value={recipe.paletteId}
            onChange={(paletteId) => onChange({ ...recipe, paletteId })}
          />
          <p>Shape</p>
          <RecipeChoiceGroup
            label="Shape"
            options={ASSISTANT_AVATAR_SHAPES}
            preview={(foregroundShape) => ({ ...recipe, foregroundShape })}
            value={recipe.foregroundShape}
            onChange={(foregroundShape) => onChange({ ...recipe, foregroundShape })}
          />
          <div className="v2-assistant-recipe-actions">
            <UiV2Button
              icon="regenerate"
              onClick={() => onChange({
                ...recipe,
                rotations: [recipe.rotations[0], ((rotation + 1) % 4) as AssistantAvatarRotation]
              })}
            >
              Rotate
            </UiV2Button>
            <UiV2Button icon="wand" onClick={onRandomize}>Randomize</UiV2Button>
            <UiV2Button tone="primary" onClick={closeForAction}>Done</UiV2Button>
          </div>
        </div>
      ) : null}
    </div>
  );
}

export function AssistantIdentityV2({ editor, locked }: Readonly<{
  editor: AssistantEditorView;
  locked: boolean;
}>) {
  const { draft } = editor;
  const nameError = editor.errors?.fields.name;
  const nameRef = useRef<HTMLInputElement>(null);
  // Focus on open, after the Studio crumb has taken focus for the new subview.
  useEffect(() => {
    const frame = requestAnimationFrame(() => nameRef.current?.focus({ preventScroll: true }));
    return () => cancelAnimationFrame(frame);
  }, []);
  return (
    <div className="v2-assistant-identity">
      <AvatarRecipePickerV2
        disabled={locked}
        recipe={draft.avatar}
        onChange={(avatar) => editor.onChange({ avatar })}
        onRandomize={editor.onGenerateAvatar}
      />
      <div className="v2-assistant-identity-fields">
        <div className="v2-assistant-field" data-invalid={Boolean(nameError) || undefined}>
          <label htmlFor="assistant-editor-name">Name <small>Required</small></label>
          <input
            aria-describedby={nameError ? "assistant-editor-name-error" : undefined}
            aria-invalid={Boolean(nameError) || undefined}
            aria-required="true"
            autoComplete="off"
            disabled={locked}
            id="assistant-editor-name"
            maxLength={ASSISTANT_NAME_MAX_LENGTH}
            placeholder="For example, Release-note writer"
            ref={nameRef}
            value={draft.name}
            onChange={(event) => editor.onChange({ name: event.currentTarget.value })}
          />
          {nameError ? <p className="v2-assistant-field-error" id="assistant-editor-name-error">{nameError}</p> : null}
        </div>
        <div className="v2-assistant-field">
          <label htmlFor="assistant-editor-description">Description</label>
          <textarea
            aria-describedby="assistant-editor-description-help"
            disabled={locked}
            id="assistant-editor-description"
            maxLength={ASSISTANT_DESCRIPTION_MAX_LENGTH}
            rows={2}
            value={draft.description}
            onChange={(event) => editor.onChange({ description: event.currentTarget.value })}
          />
          <small id="assistant-editor-description-help">Shown to people who pick this Assistant. Not sent to the model.</small>
        </div>
        <div className="v2-assistant-field v2-assistant-field-narrow">
          <label htmlFor="assistant-editor-category">Category</label>
          <select
            disabled={locked}
            id="assistant-editor-category"
            value={draft.category ?? ""}
            onChange={(event) => editor.onChange({
              category: (event.currentTarget.value || null) as AssistantCategory | null
            })}
          >
            <option value="">None</option>
            {ASSISTANT_CATEGORIES.map((category) => (
              <option key={category} value={category}>{ASSISTANT_CATEGORY_LABELS[category]}</option>
            ))}
          </select>
        </div>
      </div>
    </div>
  );
}
