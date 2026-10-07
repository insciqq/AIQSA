"use client";

import {
  adminSpeechToTextErrorMessage,
  clearAdminSpeechToText,
  discoverAdminSpeechToTextModels,
  getAdminSpeechToText,
  testAndSaveAdminSpeechToText
} from "@/components/admin/adminSpeechToTextApi";
import { RoleRow } from "@/components/admin/roles/AdminRoleRow";
import { compactInputClass, compactSelectClass } from "@/components/admin/roles/rolesControls";
import type { AdminConfirmationController } from "@/components/admin/useAdminConfirmationController";
import { UiV2Button } from "@/components/ui-v2";
import type { AdminSpeechToTextRole, AdminSpeechToTextUnavailableReason } from "@/lib/contracts/speechToText";
import { useCallback, useEffect, useId, useState } from "react";

const UNAVAILABLE: Record<AdminSpeechToTextUnavailableReason, string> = {
  connection_unavailable: "Unavailable · the provider is turned off or was removed. Choose another provider and test again.",
  credential_unavailable: "Unavailable · the provider's default key is missing, turned off or revoked.",
  verification_required: "Unavailable · the provider's default key changed. Test again to turn dictation back on."
};

type Candidates = Readonly<{ connectionId: string; models: readonly string[] | null }>;

/**
 * Speech to text: the model that transcribes composer dictation. The
 * administrator picks a provider, finds its speech-to-text models (or types
 * an id the list cannot show) and presses Test & save; only a passing Test
 * saves. Without the role nobody sees the microphone.
 */
export function AdminSpeechToTextRoleRow({ requestConfirmation }: Readonly<{
  requestConfirmation: AdminConfirmationController["requestConfirmation"];
}>) {
  const [role, setRole] = useState<AdminSpeechToTextRole | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [connectionId, setConnectionId] = useState("");
  const [modelId, setModelId] = useState("");
  const [candidates, setCandidates] = useState<Candidates | null>(null);
  const [busy, setBusy] = useState<"clear" | "discover" | "test" | null>(null);
  const [message, setMessage] = useState<Readonly<{ text: string; tone: "error" | "success" }> | null>(null);
  const ids = useId();

  const adopt = useCallback((next: AdminSpeechToTextRole) => {
    setRole(next);
    setConnectionId(next.assignment?.connectionId ?? next.connections.find((connection) => connection.ready)?.id ?? "");
    setModelId(next.assignment?.modelId ?? "");
  }, []);

  const settleLoad = useCallback((result: Awaited<ReturnType<typeof getAdminSpeechToText>>) => {
    if (result.ok) adopt(result.data);
    else setLoadError(adminSpeechToTextErrorMessage(result));
  }, [adopt]);

  useEffect(() => {
    let current = true;
    void getAdminSpeechToText().then((result) => { if (current) settleLoad(result); });
    return () => { current = false; };
  }, [settleLoad]);

  async function load() {
    setLoadError(null);
    settleLoad(await getAdminSpeechToText());
  }

  const assignment = role?.assignment ?? null;
  const status = assignment ? assignment.available ? "working" as const : "unavailable" as const : "not_assigned" as const;
  const statusLabel = assignment ? assignment.available ? "Ready" : "Unavailable" : "Not assigned";
  const listed = candidates?.connectionId === connectionId ? candidates.models : null;

  async function discover() {
    if (!connectionId) return;
    setBusy("discover");
    setMessage(null);
    const result = await discoverAdminSpeechToTextModels(connectionId);
    setBusy(null);
    if (!result.ok) {
      setCandidates({ connectionId, models: null });
      setMessage({ text: adminSpeechToTextErrorMessage(result), tone: "error" });
      return;
    }
    setCandidates({ connectionId, models: result.data });
    if (result.data.length && !result.data.includes(modelId)) setModelId(result.data[0]!);
    if (!result.data.length) setMessage({ text: "This provider lists no speech-to-text models. Enter the model id instead.", tone: "error" });
  }

  async function testAndSave() {
    if (!role || !connectionId || !modelId.trim()) return;
    setBusy("test");
    setMessage(null);
    const result = await testAndSaveAdminSpeechToText({ connectionId, expectedConfiguredAt: role.configuredAt, modelId: modelId.trim() });
    setBusy(null);
    if (!result.ok) {
      setMessage({ text: adminSpeechToTextErrorMessage(result), tone: "error" });
      return;
    }
    adopt(result.data);
    setMessage({ text: "Test passed. People now see the microphone in the composer.", tone: "success" });
  }

  function clear() {
    if (!role?.assignment) return;
    const expected = role.configuredAt;
    requestConfirmation({
      body: "Dictation turns off for everyone. Text already dictated stays in drafts and messages.",
      confirmLabel: "Clear role", dialogLabel: "Clear Speech to text", title: "Clear Speech to text?",
      testId: "admin-speech-to-text-clear-confirm", tone: "warning", icon: "x",
      onConfirm: async () => {
        setBusy("clear");
        setMessage(null);
        const result = await clearAdminSpeechToText(expected);
        setBusy(null);
        if (result.ok) adopt(result.data);
        else setMessage({ text: adminSpeechToTextErrorMessage(result), tone: "error" });
      }
    });
  }

  const description = "Transcribes dictation from the composer microphone. Recordings go to this provider and are never stored; transcriptions count toward each person's budget.";
  if (!role) {
    return <RoleRow title="Speech to text" testId="admin-role-speech-to-text" status="not_assigned" statusLabel={loadError ? "Unavailable" : "Loading"}
      description={description} menu={[]}>
      {loadError ? <div className="flex flex-wrap items-center gap-2" role="alert">
        <p className="text-xs text-ink-muted">{loadError}</p>
        <UiV2Button onClick={() => void load()} tone="ghost" type="button">Try again</UiV2Button>
      </div> : <p className="text-xs text-ink-muted" role="status">Loading…</p>}
    </RoleRow>;
  }

  const locked = busy !== null;
  return (
    <RoleRow title="Speech to text" testId="admin-role-speech-to-text" status={status} statusLabel={statusLabel} description={description}
      menu={[{ disabled: !assignment || locked, label: "Clear role", onSelect: clear }]}>
      {assignment ? <p className="text-xs text-ink" data-testid="admin-speech-to-text-assignment">
        {assignment.modelId} · {assignment.connectionDisplayName ?? "Removed provider"}
      </p> : null}
      {assignment?.unavailableReason ? <p className="text-xs leading-5 text-ink-muted" role="status">{UNAVAILABLE[assignment.unavailableReason]}</p> : null}
      {role.connections.length ? <>
        <label className="grid gap-1.5 text-xs text-ink-muted" htmlFor={`${ids}-connection`}>
          <span>Provider</span>
          <select className={compactSelectClass} disabled={locked} id={`${ids}-connection`} value={connectionId}
            data-testid="admin-speech-to-text-connection"
            onChange={(event) => { setConnectionId(event.target.value); setMessage(null); }}>
            {connectionId ? null : <option value="">Choose a provider</option>}
            {role.connections.map((connection) => <option key={connection.id} value={connection.id} disabled={!connection.ready}>
              {connection.displayName}{connection.ready ? "" : " · no usable default key"}
            </option>)}
          </select>
        </label>
        <div className="grid gap-1.5 text-xs text-ink-muted">
          <label htmlFor={`${ids}-model`}>Model</label>
          {listed && listed.length ? (
            <select className={compactSelectClass} disabled={locked} id={`${ids}-model`} value={modelId}
              data-testid="admin-speech-to-text-model" onChange={(event) => setModelId(event.target.value)}>
              {listed.map((id) => <option key={id} value={id}>{id}</option>)}
            </select>
          ) : (
            <input className={compactInputClass} disabled={locked} id={`${ids}-model`} value={modelId} maxLength={256}
              autoComplete="off" spellCheck={false} placeholder="openai/whisper-1" data-testid="admin-speech-to-text-model"
              onChange={(event) => setModelId(event.target.value)} />
          )}
        </div>
        <div className="flex flex-wrap gap-2">
          <UiV2Button busy={busy === "discover"} disabled={locked || !connectionId} onClick={() => void discover()} type="button">
            Find models
          </UiV2Button>
          <UiV2Button busy={busy === "test"} disabled={locked || !connectionId || !modelId.trim()} onClick={() => void testAndSave()}
            tone="primary" type="button" data-testid="admin-speech-to-text-save">
            Test &amp; save
          </UiV2Button>
        </div>
        <p className="text-xs leading-5 text-ink-muted">Test sends a short synthetic recording to the provider and is billed as a model check.</p>
      </> : <p className="text-xs leading-5 text-ink-muted">Add an OpenRouter, OpenAI or OpenAI-compatible provider in Providers to choose a speech-to-text model.</p>}
      {message ? <p className={`text-xs leading-5 ${message.tone === "error" ? "text-critical" : "text-positive"}`}
        role={message.tone === "error" ? "alert" : "status"} data-testid="admin-speech-to-text-message">{message.text}</p> : null}
    </RoleRow>
  );
}
