"use client";

import { UiV2Icon, UiV2MenuActions, type UiV2MenuAction } from "@/components/ui-v2";
import { UiV2ResponsiveMenu } from "@/components/ui-v2/ResponsiveMenuV2";
import { useMenuDismissalV2 } from "@/components/ui-v2/useMenuDismissalV2";
import type { ConnectComputerSource } from "@/features/connect/connectShellContext";
import { connectFolderName } from "@/features/connect/connectText";
import type { ChatComputerBinding, ConnectComputerWire } from "@/lib/contracts/computer";
import { useState } from "react";
import { ComputerPickerV2, type ComputerPickerStepV2 } from "./ComputerPickerV2";
import { useComposerComputerPickerRequests } from "./computerPickerRequest";
import { useComposerComputers, type ComposerComputersV2 } from "./useComposerComputers";
import "./computer-picker.css";

/**
 * The chat's computer in the composer (AIQSA Connect): the effective choice
 * for the next messages and how to change it. Changes apply to future
 * messages only; the chat keeps the choice the server last accepted.
 */
export type ComposerComputerControlV2 = Readonly<{
  binding: ChatComputerBinding | null;
  onChange(binding: ChatComputerBinding | null): void;
  /** Fixtures and tests pass a fixed list; the live composer reads the feed. */
  source?: ConnectComputerSource;
}>;

export type ComposerComputerStateV2 = "loading" | "offline" | "online" | "removed" | "unavailable";

/** What the chip says about the chosen computer: removed only once the list is known not to hold it. */
export function composerComputerStateV2(
  binding: ChatComputerBinding,
  computers: ComposerComputersV2
): Readonly<{ computer: ConnectComputerWire | null; state: ComposerComputerStateV2 }> {
  if (computers.disabled) return { computer: null, state: "unavailable" };
  if (computers.computers === null) return { computer: null, state: "loading" };
  const computer = computers.computers.find((candidate) => candidate.id === binding.deviceId) ?? null;
  if (!computer) return { computer: null, state: "removed" };
  return { computer, state: computer.online ? "online" : "offline" };
}

type PickerRequest = Readonly<{ computerId: string | null; step: ComputerPickerStepV2 }>;

function ComputerChipV2({ binding, computers, onOpenPicker, onStop }: Readonly<{
  binding: ChatComputerBinding;
  computers: ComposerComputersV2;
  onOpenPicker(request: PickerRequest): void;
  onStop(): void;
}>) {
  const [open, setOpen] = useState(false);
  const { closeForAction, menuRef, triggerRef } = useMenuDismissalV2({ onClose: () => setOpen(false), open });
  const { computer, state } = composerComputerStateV2(binding, computers);
  const folder = connectFolderName(binding.cwd);
  const lost = state === "removed" || state === "unavailable";
  const label = state === "removed"
    ? "Computer removed"
    : state === "unavailable"
      ? "AIQSA Connect is off"
      : `${computer?.name ?? "Computer"} · ${folder}`;
  const description = state === "removed"
    ? "The chosen computer is no longer connected to your account. Choose another one or stop using it."
    : state === "unavailable"
      ? "AIQSA Connect was turned off, so the agent cannot use your computer."
      : `${computer?.name ?? "Computer"}${state === "offline" ? " (offline)" : ""} · ${binding.cwd}`;
  const actions: UiV2MenuAction[] = lost
    ? [
        ...(state === "removed"
          ? [{ icon: "monitor" as const, label: "Choose another computer", onSelect: () => onOpenPicker({ computerId: null, step: "computer" }) }]
          : []),
        { icon: "close", label: "Stop using computer", onSelect: onStop, separatorBefore: state === "removed" }
      ]
    : [
        { icon: "folder", label: "Change folder", onSelect: () => onOpenPicker({ computerId: binding.deviceId, step: "folder" }) },
        { icon: "monitor", label: "Change computer", onSelect: () => onOpenPicker({ computerId: null, step: "computer" }) },
        { icon: "close", label: "Stop using computer", onSelect: onStop, separatorBefore: true }
      ];
  return (
    <>
      <button
        aria-expanded={open}
        aria-haspopup="menu"
        aria-label={`Computer: ${description}`}
        className="v2-composer-indicator v2-composer-computer v2-focusable"
        data-glyph="monitor"
        data-state={state}
        data-testid="composer-v2-computer"
        data-tooltip={description}
        data-tooltip-side="top"
        onClick={() => setOpen((value) => !value)}
        ref={triggerRef}
        type="button"
      >
        <span aria-hidden="true" className="v2-composer-indicator-face">
          <span className="v2-composer-indicator-icon">
            <UiV2Icon className="v2-composer-indicator-glyph" name={lost ? "alert" : "monitor"} />
            {state === "online" || state === "offline" ? (
              <span className="v2-composer-computer-dot" data-online={state === "online" || undefined} />
            ) : null}
          </span>
          <span className="v2-composer-indicator-label v2-composer-computer-label">{label}</span>
          {state === "offline" ? <span className="v2-composer-computer-offline">offline</span> : null}
        </span>
      </button>
      {open ? (
        <UiV2ResponsiveMenu align="start" anchorRef={triggerRef} label="Computer" menuRef={menuRef} onClose={() => setOpen(false)}>
          <UiV2MenuActions actions={actions} onClose={closeForAction} />
        </UiV2ResponsiveMenu>
      ) : null}
    </>
  );
}

/**
 * The chip and the picker. The `+` menu and a refused send open the picker
 * through `picker`; the chip opens it from its own menu.
 */
export function ComposerComputerV2({ control, onPickerChange, picker, restoreFocus }: Readonly<{
  control: ComposerComputerControlV2;
  onPickerChange(request: PickerRequest | null): void;
  picker: PickerRequest | null;
  /** Where focus goes when the picker closes after a choice, the chip being gone or new. */
  restoreFocus?(): void;
}>) {
  const computers = useComposerComputers(Boolean(control.binding) || picker !== null, control.source);
  useComposerComputerPickerRequests(() => onPickerChange({ computerId: null, step: "computer" }), true);
  return (
    <>
      {control.binding ? (
        <ComputerChipV2
          binding={control.binding}
          computers={computers}
          onOpenPicker={onPickerChange}
          onStop={() => {
            control.onChange(null);
            restoreFocus?.();
          }}
        />
      ) : null}
      {picker ? (
        <ComputerPickerV2
          binding={control.binding}
          computers={computers}
          initialComputerId={picker.step === "folder" ? picker.computerId : null}
          onChoose={(binding) => control.onChange(binding)}
          onClose={() => onPickerChange(null)}
        />
      ) : null}
    </>
  );
}

export type { PickerRequest as ComposerComputerPickerRequestV2 };
