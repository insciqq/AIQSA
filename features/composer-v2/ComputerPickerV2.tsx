"use client";

import { UiV2Button, UiV2Icon } from "@/components/ui-v2";
import { UiV2Sheet } from "@/components/ui-v2/SheetV2";
import {
  loadConnectComputerDirs,
  loadConnectComputerRecentDirs,
  statConnectComputerPath,
  type ConnectFailureCode
} from "@/features/connect/connectApi";
import {
  connectChildPath,
  connectComputerSystemLabel,
  connectDisplayPath,
  connectErrorMessage,
  connectLastSeenLabel
} from "@/features/connect/connectText";
import { useConnectNow } from "@/features/connect/useConnectNow";
import {
  isComputerPath,
  type ChatComputerBinding,
  type ConnectComputerDirsResponse,
  type ConnectComputerRecentDirsResponse,
  type ConnectComputerWire
} from "@/lib/contracts/computer";
import { CONNECT_PAGE_PATH } from "@/lib/contracts/connect";
import { useEffect, useId, useState, type FormEvent } from "react";
import type { ComposerComputersV2 } from "./useComposerComputers";

export type ComputerPickerStepV2 = "computer" | "folder";

type Loaded<T> =
  | Readonly<{ kind: "loading" }>
  | Readonly<{ data: T; kind: "ready" }>
  | Readonly<{ code: ConnectFailureCode; kind: "failed" }>;

/** One request's answer, kept with the key it was asked for so a newer request reads as loading. */
function useKeyedRequest<T>(
  key: string | null,
  load: (signal: AbortSignal) => Promise<Readonly<{ data: T; ok: true }> | Readonly<{ code: ConnectFailureCode; ok: false }>>
): Loaded<T> | null {
  const [answer, setAnswer] = useState<Readonly<{ key: string; value: Loaded<T> }> | null>(null);
  useEffect(() => {
    if (key === null) return;
    const controller = new AbortController();
    void load(controller.signal).then((result) => {
      if (controller.signal.aborted) return;
      setAnswer({ key, value: result.ok ? { data: result.data, kind: "ready" } : { code: result.code, kind: "failed" } });
    });
    return () => controller.abort();
    // `load` closes over the same inputs as `key`.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  if (key === null) return null;
  return answer?.key === key ? answer.value : { kind: "loading" };
}

function ComputerRowV2({ computer, current, now, onSelect }: Readonly<{
  computer: ConnectComputerWire;
  current: boolean;
  now: number;
  onSelect(): void;
}>) {
  return (
    <li>
      <button
        aria-current={current || undefined}
        className="v2-computer-picker-row v2-focusable"
        data-online={computer.online || undefined}
        data-testid="computer-picker-computer"
        onClick={onSelect}
        type="button"
      >
        <span aria-hidden="true" className="v2-computer-picker-row-icon">
          <UiV2Icon name="monitor" />
          <span className="v2-connect-online-dot" data-online={computer.online || undefined} />
        </span>
        <span className="v2-computer-picker-row-copy">
          <strong>{computer.name}</strong>
          <small>{connectComputerSystemLabel(computer)} · {connectLastSeenLabel(computer.online, computer.lastSeenAt, now)}</small>
        </span>
        {current ? <UiV2Icon className="v2-computer-picker-current" name="check" /> : <UiV2Icon name="chevron-right" />}
      </button>
    </li>
  );
}

function ComputerStepV2({ binding, computers, onSelect }: Readonly<{
  binding: ChatComputerBinding | null;
  computers: ComposerComputersV2;
  onSelect(computerId: string): void;
}>) {
  const now = useConnectNow();
  if (computers.disabled) {
    return <p className="v2-connect-alert" role="alert">{connectErrorMessage("connect_disabled")}</p>;
  }
  if (computers.computers === null) {
    return computers.loadError ? (
      <p className="text-sm text-ink-secondary" role="alert">{connectErrorMessage(computers.loadError)} Retrying automatically.</p>
    ) : (
      <p className="text-sm text-ink-muted" role="status">Loading your computers…</p>
    );
  }
  if (computers.computers.length === 0) {
    return (
      <div className="flex flex-col gap-3" data-testid="computer-picker-empty">
        <p className="text-sm leading-6 text-ink-secondary">
          You have no computers yet. Install AIQSA Connect on a computer, approve it, then choose it here.
        </p>
        <a className="v2-connect-link v2-focusable self-start text-sm" href={CONNECT_PAGE_PATH}>Add a computer in AIQSA Connect</a>
      </div>
    );
  }
  return (
    <div className="flex flex-col gap-4">
      <ul aria-label="Your computers" className="v2-computer-picker-list">
        {computers.computers.map((computer) => (
          <ComputerRowV2
            computer={computer}
            current={binding?.deviceId === computer.id}
            key={computer.id}
            now={now}
            onSelect={() => onSelect(computer.id)}
          />
        ))}
      </ul>
      <a className="v2-connect-link v2-focusable self-start text-sm" href={CONNECT_PAGE_PATH}>Add a computer</a>
    </div>
  );
}

function stepFailure(code: ConnectFailureCode): string {
  return connectErrorMessage(code);
}

function FolderStepV2({ binding, computer, onChoose }: Readonly<{
  binding: ChatComputerBinding | null;
  computer: ConnectComputerWire;
  onChoose(binding: ChatComputerBinding): void;
}>) {
  const pathId = useId();
  const online = computer.online;
  const recent = useKeyedRequest<ConnectComputerRecentDirsResponse>(
    online ? `${computer.id}:recent` : null,
    (signal) => loadConnectComputerRecentDirs(computer.id, signal)
  );
  const home = recent?.kind === "ready" ? recent.data.home : computer.info?.home ?? null;
  const [browsePath, setBrowsePath] = useState<string | null>(null);
  const browse = useKeyedRequest<ConnectComputerDirsResponse>(
    online && browsePath !== null ? `${computer.id}:dirs:${browsePath}` : null,
    (signal) => loadConnectComputerDirs(computer.id, browsePath ?? "~", signal)
  );
  const [typed, setTyped] = useState(binding?.deviceId === computer.id ? binding.cwd : "");
  const [checking, setChecking] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function choose(path: string) {
    const cwd = path.trim();
    setError(null);
    if (!isComputerPath(cwd)) {
      setError("Enter a folder path, like ~/Documents or C:\\Users\\you\\Documents.");
      return;
    }
    // An offline computer cannot be asked; the agent finds out when it uses the folder.
    if (!online) {
      onChoose({ cwd, deviceId: computer.id });
      return;
    }
    setChecking(cwd);
    const result = await statConnectComputerPath(computer.id, cwd);
    setChecking(null);
    if (!result.ok) {
      setError(stepFailure(result.code));
      return;
    }
    if (!result.data.exists) {
      setError(connectErrorMessage("computer_path_not_found"));
      return;
    }
    if (result.data.kind !== "dir") {
      setError(connectErrorMessage("computer_not_a_directory"));
      return;
    }
    onChoose({ cwd: result.data.path, deviceId: computer.id });
  }

  function submitTyped(event: FormEvent) {
    event.preventDefault();
    void choose(typed);
  }

  const shortcuts: { label: string; path: string }[] = [];
  if (online) {
    if (recent?.kind === "ready") {
      shortcuts.push({ label: "Home", path: recent.data.home });
      for (const dir of recent.data.dirs) {
        if (dir !== recent.data.home) shortcuts.push({ label: connectDisplayPath(dir, recent.data.home), path: dir });
      }
    }
  } else {
    shortcuts.push({ label: "Home", path: "~" });
    if (binding?.deviceId === computer.id && binding.cwd !== "~") shortcuts.push({ label: binding.cwd, path: binding.cwd });
  }

  if (browsePath !== null) {
    return (
      <div className="flex min-w-0 flex-col gap-3" data-testid="computer-picker-browse">
        {browse?.kind === "ready" ? (
          <>
            <p className="v2-computer-picker-path" data-testid="computer-picker-browse-path" title={browse.data.path}>
              {connectDisplayPath(browse.data.path, home)}
            </p>
            <ul aria-label="Folders" className="v2-computer-picker-list">
              {browse.data.parent !== null ? (
                <li>
                  <button className="v2-computer-picker-row v2-focusable" onClick={() => setBrowsePath(browse.data.parent)} type="button">
                    <UiV2Icon name="arrow-up" />
                    <span className="v2-computer-picker-row-copy"><strong>Up one level</strong></span>
                  </button>
                </li>
              ) : null}
              {browse.data.dirs.map((name) => (
                <li key={name}>
                  <button
                    className="v2-computer-picker-row v2-focusable"
                    data-testid="computer-picker-dir"
                    onClick={() => setBrowsePath(connectChildPath(browse.data.path, name, computer.os))}
                    type="button"
                  >
                    <UiV2Icon name="folder" />
                    <span className="v2-computer-picker-row-copy"><strong>{name}</strong></span>
                    <UiV2Icon name="chevron-right" />
                  </button>
                </li>
              ))}
            </ul>
            {browse.data.dirs.length === 0 ? <p className="text-metadata text-ink-muted">No subfolders.</p> : null}
            {browse.data.truncated ? (
              <p className="text-metadata text-ink-muted">Only the first folders are listed. Type a path to go further.</p>
            ) : null}
            {error ? <p className="v2-connect-alert" role="alert">{error}</p> : null}
            <div className="flex flex-wrap gap-2">
              <UiV2Button busy={checking !== null} onClick={() => void choose(browse.data.path)} tone="primary">
                Use this folder
              </UiV2Button>
              <UiV2Button onClick={() => setBrowsePath(null)}>Back</UiV2Button>
            </div>
          </>
        ) : browse?.kind === "failed" ? (
          <>
            <p className="v2-connect-alert" role="alert">{stepFailure(browse.code)}</p>
            <UiV2Button className="self-start" onClick={() => setBrowsePath(null)}>Back</UiV2Button>
          </>
        ) : (
          <p className="text-sm text-ink-muted" role="status">Reading folders…</p>
        )}
      </div>
    );
  }

  return (
    <div className="flex min-w-0 flex-col gap-5" data-testid="computer-picker-folder">
      <p className="text-sm leading-6 text-ink-secondary">
        Commands start in this folder and relative paths are read from it. The agent can still reach other folders.
      </p>
      {!online ? (
        <p className="text-sm leading-6 text-ink-secondary" data-testid="computer-picker-offline" role="note">
          {computer.name} is offline, so its folders cannot be listed or checked now. You can still choose one;
          the agent checks it when the computer is back.
        </p>
      ) : null}
      {online && recent?.kind === "loading" ? <p className="text-sm text-ink-muted" role="status">Reading recent folders…</p> : null}
      {online && recent?.kind === "failed" ? <p className="v2-connect-alert" role="alert">{stepFailure(recent.code)}</p> : null}
      {shortcuts.length > 0 ? (
        <ul aria-label="Suggested folders" className="v2-computer-picker-list">
          {shortcuts.map((shortcut) => (
            <li key={shortcut.path}>
              <button
                aria-current={binding?.deviceId === computer.id && binding.cwd === shortcut.path ? true : undefined}
                className="v2-computer-picker-row v2-focusable"
                data-testid="computer-picker-shortcut"
                disabled={checking !== null}
                onClick={() => void choose(shortcut.path)}
                title={shortcut.path}
                type="button"
              >
                <UiV2Icon name={shortcut.label === "Home" ? "user" : "folder"} />
                <span className="v2-computer-picker-row-copy">
                  <strong>{shortcut.label}</strong>
                  {shortcut.label === "Home" && shortcut.path !== "~" ? <small>{shortcut.path}</small> : null}
                </span>
                {checking === shortcut.path ? <span aria-hidden="true" className="v2-spinner" /> : null}
              </button>
            </li>
          ))}
        </ul>
      ) : null}
      {online ? (
        <UiV2Button className="self-start" icon="folder" onClick={() => setBrowsePath(home ?? "~")}>Browse…</UiV2Button>
      ) : null}
      <form className="flex flex-col gap-2" noValidate onSubmit={submitTyped}>
        <label className="v2-connect-field-label" htmlFor={pathId}>Or type a folder path</label>
        <div className="flex min-w-0 flex-wrap gap-2">
          <input
            autoCapitalize="off"
            autoComplete="off"
            className="v2-connect-input min-w-0 flex-[1_1_14rem] font-mono"
            id={pathId}
            onChange={(event) => setTyped(event.target.value)}
            placeholder={computer.os === "windows" ? "C:\\Users\\you\\Documents" : "~/Documents"}
            spellCheck={false}
            value={typed}
          />
          <UiV2Button busy={checking !== null && checking === typed.trim()} disabled={!typed.trim()} type="submit">
            Use
          </UiV2Button>
        </div>
      </form>
      {error ? <p className="v2-connect-alert" data-testid="computer-picker-error" role="alert">{error}</p> : null}
    </div>
  );
}

export type ComputerPickerV2Props = Readonly<{
  binding: ChatComputerBinding | null;
  computers: ComposerComputersV2;
  /** The computer whose folder to choose first ("Change folder"); none starts with the list. */
  initialComputerId: string | null;
  onChoose(binding: ChatComputerBinding): void;
  onClose(): void;
}>;

/** "Use a computer…": the user's computers, then a folder on the chosen one (§8, D-17). */
export function ComputerPickerV2({ binding, computers, initialComputerId, onChoose, onClose }: ComputerPickerV2Props) {
  const [computerId, setComputerId] = useState<string | null>(initialComputerId);
  const computer = computerId ? computers.computers?.find((candidate) => candidate.id === computerId) ?? null : null;
  const folderStep = computer !== null;
  return (
    <UiV2Sheet
      description={folderStep
        ? `Choose the folder the agent starts in on ${computer.name}.`
        : "The agent works with files and runs commands there, with your permissions on that computer."}
      onClose={onClose}
      open
      phoneFullScreen
      testId="computer-picker"
      title={folderStep ? "Choose a folder" : "Use a computer"}
      footer={folderStep ? (
        <UiV2Button icon="arrow-left" onClick={() => setComputerId(null)}>All computers</UiV2Button>
      ) : null}
    >
      {folderStep ? (
        <FolderStepV2
          binding={binding}
          computer={computer}
          key={computer.id}
          onChoose={(next) => {
            onChoose(next);
            onClose();
          }}
        />
      ) : (
        <ComputerStepV2 binding={binding} computers={computers} onSelect={setComputerId} />
      )}
    </UiV2Sheet>
  );
}
