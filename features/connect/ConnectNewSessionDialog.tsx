"use client";

import { UiV2Button } from "@/components/ui-v2";
import { UiV2Sheet } from "@/components/ui-v2/SheetV2";
import {
  CONNECT_CONTROL_CHARACTER_PATTERN,
  CONNECT_MAX_CWD_LENGTH,
  CONNECT_MAX_TITLE_LENGTH,
  CONNECT_PROGRAMS,
  CONNECT_REQUESTED_CWD_PATTERN,
  connectSessionPath,
  type ConnectDevice,
  type ConnectProgram,
  type ConnectRecentDirsResponse
} from "@/lib/contracts/connect";
import { useRouter } from "next/navigation";
import { useEffect, useId, useState, type FormEvent } from "react";
import { createConnectSession, loadConnectRecentDirs } from "./connectApi";
import { useConnectShell } from "./connectShellContext";
import {
  CONNECT_PROGRAM_LABELS,
  connectDefaultSessionTitle,
  connectDisplayPath,
  connectErrorMessage
} from "./connectText";

/** The answer for one computer; another computer's answer means its folders are still loading. */
type RecentDirs =
  | Readonly<{ data: ConnectRecentDirsResponse; deviceId: string; state: "ready" }>
  | Readonly<{ deviceId: string; state: "unavailable" }>;

export function connectFolderError(value: string): string | null {
  const cwd = value.trim();
  if (!cwd) return "Enter a folder.";
  if (cwd.length > CONNECT_MAX_CWD_LENGTH || CONNECT_CONTROL_CHARACTER_PATTERN.test(cwd) ||
    !CONNECT_REQUESTED_CWD_PATTERN.test(cwd)) {
    return "Enter an absolute path, or one that starts with ~.";
  }
  return null;
}

/**
 * Starts a session on one of the user's online computers. The title is
 * optional: left empty, the computer names it after the program and folder.
 */
export function ConnectNewSessionDialog({
  devices,
  initialDeviceId,
  onClose
}: Readonly<{
  /** Online computers only. */
  devices: readonly ConnectDevice[];
  initialDeviceId: string | null;
  onClose(): void;
}>) {
  const router = useRouter();
  const { leave } = useConnectShell();
  const formId = useId();
  const [deviceId, setDeviceId] = useState(() =>
    devices.find((device) => device.id === initialDeviceId)?.id ?? devices[0]?.id ?? "");
  const [cwd, setCwd] = useState("~");
  const [program, setProgram] = useState<ConnectProgram>("claude");
  const [title, setTitle] = useState("");
  const [recent, setRecent] = useState<RecentDirs | null>(null);
  const [busy, setBusy] = useState(false);
  const [folderError, setFolderError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const device = devices.find((candidate) => candidate.id === deviceId) ?? null;

  useEffect(() => {
    if (!deviceId) return;
    const controller = new AbortController();
    void loadConnectRecentDirs(deviceId, controller.signal).then((result) => {
      if (controller.signal.aborted) return;
      setRecent(result.ok ? { data: result.data, deviceId, state: "ready" } : { deviceId, state: "unavailable" });
    });
    return () => controller.abort();
  }, [deviceId]);

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (busy || !device) return;
    const invalid = connectFolderError(cwd);
    setFolderError(invalid);
    if (invalid) return;
    setBusy(true);
    setError(null);
    const trimmedTitle = title.trim();
    const result = await createConnectSession(device.id, {
      cwd: cwd.trim(),
      program,
      ...(trimmedTitle ? { title: trimmedTitle } : {})
    });
    setBusy(false);
    if (result.ok) {
      onClose();
      router.push(connectSessionPath(device.id, result.data.sessionId));
      return;
    }
    if (result.code === "connect_disabled") return leave("disabled");
    if (result.code === "connect_unauthorized") return leave("signed_out");
    if (result.code === "connect_cwd_invalid") {
      setFolderError(`This folder does not exist on ${device.name}.`);
      return;
    }
    if (result.code === "connect_request_invalid") {
      setError("The session was not accepted. Check the folder and the title.");
      return;
    }
    setError(connectErrorMessage(result.code, result.retryAfterSeconds));
  }

  const recentDirs = recent?.deviceId === deviceId && recent.state === "ready" ? recent.data : null;
  const titleTooLong = [...title.trim()].length > CONNECT_MAX_TITLE_LENGTH;

  return (
    <UiV2Sheet
      closeBlocked={busy}
      footer={(
        <>
          <UiV2Button busy={busy} disabled={!device || titleTooLong} form={formId} tone="primary" type="submit">
            Start session
          </UiV2Button>
          <UiV2Button disabled={busy} onClick={onClose}>Cancel</UiV2Button>
        </>
      )}
      onClose={onClose}
      open
      testId="connect-new-session"
      title="New session"
    >
      {devices.length === 0 ? (
        <p className="text-sm leading-6 text-ink-secondary">
          No computer is online. Start aiqsa-connect on your computer, then try again.
        </p>
      ) : (
        <form className="flex flex-col gap-5" id={formId} noValidate onSubmit={(event) => void submit(event)}>
          {error ? <p className="v2-connect-alert" role="alert">{error}</p> : null}
          <label className="v2-connect-field">
            <span className="v2-connect-field-label">Computer</span>
            <select
              className="v2-connect-input"
              disabled={busy}
              onChange={(event) => {
                setDeviceId(event.target.value);
                setFolderError(null);
              }}
              value={deviceId}
            >
              {devices.map((candidate) => <option key={candidate.id} value={candidate.id}>{candidate.name}</option>)}
            </select>
          </label>

          <div className="v2-connect-field">
            <label className="v2-connect-field-label" htmlFor={`${formId}-cwd`}>Folder</label>
            <input
              aria-describedby={folderError ? `${formId}-cwd-error` : undefined}
              aria-invalid={folderError ? true : undefined}
              autoCapitalize="off"
              autoComplete="off"
              autoCorrect="off"
              className="v2-connect-input font-mono"
              disabled={busy}
              id={`${formId}-cwd`}
              maxLength={CONNECT_MAX_CWD_LENGTH}
              onChange={(event) => {
                setCwd(event.target.value);
                setFolderError(null);
              }}
              placeholder="~/projects/app"
              spellCheck={false}
              value={cwd}
            />
            {folderError ? (
              <p className="text-metadata text-critical" id={`${formId}-cwd-error`}>{folderError}</p>
            ) : null}
            {recent?.deviceId !== deviceId ? (
              <p className="text-metadata text-ink-muted" role="status">Loading recent folders…</p>
            ) : recent?.deviceId === deviceId && recent.state === "unavailable" ? (
              <p className="text-metadata text-ink-muted">Recent folders are unavailable. Type a path instead.</p>
            ) : recentDirs && recentDirs.dirs.length > 0 ? (
              <div aria-label="Recent folders" className="v2-connect-recent" role="group">
                {recentDirs.dirs.map((dir) => {
                  const shown = connectDisplayPath(dir, recentDirs.home);
                  return (
                    <button
                      aria-pressed={cwd.trim() === shown || cwd.trim() === dir}
                      className="v2-connect-recent-item v2-focusable"
                      disabled={busy}
                      key={dir}
                      onClick={() => {
                        setCwd(shown);
                        setFolderError(null);
                      }}
                      title={dir}
                      type="button"
                    >
                      {shown}
                    </button>
                  );
                })}
              </div>
            ) : null}
          </div>

          <div className="v2-connect-field">
            <span className="v2-connect-field-label" id={`${formId}-program`}>Program</span>
            <div aria-labelledby={`${formId}-program`} className="v2-connect-segmented" role="radiogroup">
              {CONNECT_PROGRAMS.map((value) => (
                <button
                  aria-checked={program === value}
                  className="v2-focusable"
                  disabled={busy}
                  key={value}
                  onClick={() => setProgram(value)}
                  role="radio"
                  type="button"
                >
                  {CONNECT_PROGRAM_LABELS[value]}
                </button>
              ))}
            </div>
          </div>

          <div className="v2-connect-field">
            <label className="v2-connect-field-label" htmlFor={`${formId}-title`}>
              Title <span className="font-normal text-ink-muted">(optional)</span>
            </label>
            <input
              aria-invalid={titleTooLong ? true : undefined}
              className="v2-connect-input"
              disabled={busy}
              id={`${formId}-title`}
              onChange={(event) => setTitle(event.target.value)}
              placeholder={connectDefaultSessionTitle(program, cwd)}
              value={title}
            />
            {titleTooLong ? (
              <p className="text-metadata text-critical">Use at most {CONNECT_MAX_TITLE_LENGTH} characters.</p>
            ) : null}
          </div>
        </form>
      )}
    </UiV2Sheet>
  );
}
