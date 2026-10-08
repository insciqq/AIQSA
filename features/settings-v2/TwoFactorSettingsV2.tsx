"use client";

import {
  confirmTwoFactorSetup,
  disableTwoFactor,
  loadTwoFactorStatus,
  regenerateRecoveryCodes,
  startTwoFactorSetup,
  type TwoFactorCodesResult
} from "@/components/app-shell/accountApi";
import { errorMessage } from "@/components/app-shell/shellFormatting";
import { useBeforeUnloadGuard } from "@/components/app-shell/useBeforeUnloadGuard";
import { UiV2Button } from "@/components/ui-v2";
import type { TwoFactorProofWire, TwoFactorSetupWire, TwoFactorStatusWire } from "@/lib/contracts/twoFactor";
import { useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { encode } from "uqr";
import { SettingsRowV2 } from "./SettingsV2";

type Panel =
  | Readonly<{ kind: "closed" }>
  | Readonly<{ kind: "setup"; setup: TwoFactorSetupWire }>
  | Readonly<{ kind: "proof"; purpose: "disable" | "regenerate" }>
  | Readonly<{ codes: readonly string[]; kind: "codes" }>;

const messages: Record<string, string> = {
  invalid_code: "That code did not work. Use the current code from your authenticator app, or an unused recovery code.",
  rate_limited: "Too many attempts. Wait a bit before trying again.",
  two_factor_code_required: "Enter a current code from your authenticator app or a recovery code.",
  two_factor_not_available: "Two-factor sign-in is not available for this account.",
  two_factor_not_enabled: "Two-factor sign-in is already off.",
  two_factor_setup_required: "Setup timed out. Start again.",
  two_factor_unavailable: "Two-factor sign-in is unavailable on this server. Contact the operator."
};

function twoFactorErrorMessage(error: unknown): string {
  const code = error instanceof Error ? error.message : "";
  return messages[code] ? `${messages[code]} (${code})` : errorMessage(error);
}

/** The provisioning URI as a QR code: one path of dark modules on a light quiet zone. */
function TwoFactorQrCode({ value }: Readonly<{ value: string }>) {
  const { path, size } = useMemo(() => {
    const qr = encode(value, { border: 2, ecc: "M" });
    let d = "";
    qr.data.forEach((row, y) => row.forEach((dark, x) => {
      if (dark) d += `M${x},${y}h1v1h-1z`;
    }));
    return { path: d, size: qr.size };
  }, [value]);

  // Scanners need dark modules on a light background in every theme, so the colors are fixed.
  return (
    <svg
      aria-label="QR code for your authenticator app"
      className="v2-two-factor-qr"
      data-testid="settings-two-factor-qr"
      role="img"
      shapeRendering="crispEdges"
      viewBox={`0 0 ${size} ${size}`}
    >
      <rect fill="#ffffff" height={size} width={size} />
      <path d={path} fill="#000000" />
    </svg>
  );
}

function ProofField({ disabled, recovery, onToggle }: Readonly<{ disabled: boolean; onToggle(): void; recovery: boolean }>) {
  return (
    <>
      <label>
        <span>{recovery ? "Recovery code" : "Current code from your authenticator app"}</span>
        <input
          autoCapitalize={recovery ? "characters" : "none"}
          autoComplete={recovery ? "off" : "one-time-code"}
          autoFocus
          className="v2-settings-input"
          disabled={disabled}
          inputMode={recovery ? "text" : "numeric"}
          key={recovery ? "recovery" : "totp"}
          maxLength={recovery ? 16 : 9}
          name="code"
          required
          spellCheck={false}
          type="text"
        />
      </label>
      <button className="v2-two-factor-link v2-focusable" disabled={disabled} onClick={onToggle} type="button">
        {recovery ? "Use your authenticator app" : "Use a recovery code"}
      </button>
    </>
  );
}

function RecoveryCodes({ codes, onDone }: Readonly<{ codes: readonly string[]; onDone(): void }>) {
  const [copied, setCopied] = useState(false);
  const text = `AIQSA recovery codes\n\n${codes.join("\n")}\n\nEach code works once.\n`;

  const download = () => {
    const url = URL.createObjectURL(new Blob([text], { type: "text/plain;charset=utf-8" }));
    const link = document.createElement("a");
    link.href = url;
    link.download = "aiqsa-recovery-codes.txt";
    link.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div className="v2-settings-form" data-testid="settings-two-factor-codes">
      <p className="v2-two-factor-note" role="status">
        Save these recovery codes now. Each one signs you in once without your authenticator app, and they are not shown again.
      </p>
      <ol className="v2-two-factor-codes" aria-label="Recovery codes">
        {codes.map((code) => <li key={code}>{code}</li>)}
      </ol>
      <div className="v2-settings-form-actions">
        <UiV2Button icon="copy" onClick={() => {
          void navigator.clipboard?.writeText(text).then(() => setCopied(true), () => setCopied(false));
        }}>
          {copied ? "Copied" : "Copy codes"}
        </UiV2Button>
        <UiV2Button icon="download" onClick={download}>Download .txt</UiV2Button>
        <UiV2Button tone="primary" onClick={onDone}>I saved them</UiV2Button>
      </div>
    </div>
  );
}

/**
 * Account › Two-factor sign-in: turn on with an authenticator app (QR code or key, then a
 * code), recovery codes shown once, new codes and turning off with a current code. Accounts
 * that only sign in through an identity provider see that their provider handles it.
 */
export function TwoFactorSettingsV2() {
  const [status, setStatus] = useState<TwoFactorStatusWire | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [panel, setPanel] = useState<Panel>({ kind: "closed" });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [recovery, setRecovery] = useState(false);
  const [keyCopied, setKeyCopied] = useState(false);
  const active = useRef(true);
  useBeforeUnloadGuard(panel.kind === "codes" || panel.kind === "setup" || busy);

  useEffect(() => {
    active.current = true;
    void loadTwoFactorStatus().then(
      (loaded) => { if (active.current) setStatus(loaded); },
      (failure) => { if (active.current) setLoadError(errorMessage(failure)); }
    );
    return () => { active.current = false; };
  }, []);

  const open = (next: Panel) => {
    setError(null);
    setRecovery(false);
    setKeyCopied(false);
    setPanel(next);
  };

  const run = async (operation: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try {
      await operation();
    } catch (failure) {
      if (active.current) setError(twoFactorErrorMessage(failure));
    } finally {
      if (active.current) setBusy(false);
    }
  };

  const showCodes = (result: TwoFactorCodesResult) => {
    if (!active.current) return;
    if (result.status) setStatus(result.status);
    open({ codes: result.recoveryCodes, kind: "codes" });
  };

  const turnOn = () => void run(async () => {
    const setup = await startTwoFactorSetup();
    if (active.current) open({ kind: "setup", setup });
  });

  const submitConfirm = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const code = String(new FormData(event.currentTarget).get("code") ?? "").trim();
    void run(async () => showCodes(await confirmTwoFactorSetup(code)));
  };

  const submitProof = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (panel.kind !== "proof") return;
    const value = String(new FormData(event.currentTarget).get("code") ?? "").trim();
    const proof: TwoFactorProofWire = recovery ? { recoveryCode: value } : { code: value };
    const purpose = panel.purpose;
    void run(async () => {
      if (purpose === "regenerate") {
        showCodes(await regenerateRecoveryCodes(proof));
        return;
      }
      const next = await disableTwoFactor(proof);
      if (!active.current) return;
      setStatus(next ?? { available: true, enabled: false, recoveryCodesRemaining: 0 });
      open({ kind: "closed" });
    });
  };

  if (!status) {
    return loadError ? (
      <SettingsRowV2 description={loadError} testId="settings-two-factor" title="Two-factor sign-in" />
    ) : null;
  }

  if (!status.available) {
    return (
      <SettingsRowV2
        description="You sign in through an identity provider, which handles two-factor authentication for this account."
        testId="settings-two-factor"
        title="Two-factor sign-in"
      />
    );
  }

  const description = status.enabled
    ? `On. Sign-in asks for a code from your authenticator app. ${status.recoveryCodesRemaining} of 10 recovery codes left.`
    : "Off. Turn it on to ask for a code from an authenticator app after your password.";
  const closed = panel.kind === "closed";

  return (
    <>
      <SettingsRowV2 description={description} testId="settings-two-factor" title="Two-factor sign-in">
        {closed && !status.enabled ? (
          <UiV2Button busy={busy} onClick={turnOn}>Turn on…</UiV2Button>
        ) : null}
        {closed && status.enabled ? (
          <span className="v2-settings-inline-actions">
            <UiV2Button disabled={busy} onClick={() => open({ kind: "proof", purpose: "regenerate" })}>New recovery codes…</UiV2Button>
            <UiV2Button disabled={busy} tone="destructive" onClick={() => open({ kind: "proof", purpose: "disable" })}>Turn off…</UiV2Button>
          </span>
        ) : null}
      </SettingsRowV2>
      {closed && error ? <p className="v2-settings-error" role="alert">{error}</p> : null}

      {panel.kind === "setup" ? (
        <form className="v2-settings-form" data-testid="settings-two-factor-setup" onSubmit={submitConfirm}>
          <p className="v2-two-factor-note">
            Scan the QR code with an authenticator app, or enter the key by hand. Then type the 6-digit code it shows.
          </p>
          <div className="v2-two-factor-setup">
            <TwoFactorQrCode value={panel.setup.otpauthUri} />
            <div className="v2-two-factor-key">
              <span>Key</span>
              <code data-testid="settings-two-factor-key">{panel.setup.secret.match(/.{1,4}/gu)?.join(" ")}</code>
              <UiV2Button icon="copy" onClick={() => {
                void navigator.clipboard?.writeText(panel.setup.secret).then(() => setKeyCopied(true), () => setKeyCopied(false));
              }}>
                {keyCopied ? "Copied" : "Copy key"}
              </UiV2Button>
            </div>
          </div>
          <label>
            <span>Code from the app</span>
            <input
              autoComplete="one-time-code"
              className="v2-settings-input"
              disabled={busy}
              inputMode="numeric"
              maxLength={9}
              name="code"
              required
              spellCheck={false}
              type="text"
            />
          </label>
          {error ? <span className="v2-live-menu-error" role="alert">{error}</span> : null}
          <div className="v2-settings-form-actions">
            <UiV2Button disabled={busy} onClick={() => open({ kind: "closed" })}>Cancel</UiV2Button>
            <UiV2Button busy={busy} tone="primary" type="submit">Turn on</UiV2Button>
          </div>
        </form>
      ) : null}

      {panel.kind === "proof" ? (
        <form className="v2-settings-form" data-testid="settings-two-factor-proof" onSubmit={submitProof}>
          <p className="v2-two-factor-note">
            {panel.purpose === "disable"
              ? "Confirm with a current code to turn off two-factor sign-in. Your recovery codes stop working."
              : "Confirm with a current code to replace your recovery codes. The old codes stop working."}
          </p>
          <ProofField disabled={busy} onToggle={() => { setError(null); setRecovery((value) => !value); }} recovery={recovery} />
          {error ? <span className="v2-live-menu-error" role="alert">{error}</span> : null}
          <div className="v2-settings-form-actions">
            <UiV2Button disabled={busy} onClick={() => open({ kind: "closed" })}>Cancel</UiV2Button>
            <UiV2Button busy={busy} tone={panel.purpose === "disable" ? "destructive" : "primary"} type="submit">
              {panel.purpose === "disable" ? "Turn off" : "Create new codes"}
            </UiV2Button>
          </div>
        </form>
      ) : null}

      {panel.kind === "codes" ? <RecoveryCodes codes={panel.codes} onDone={() => open({ kind: "closed" })} /> : null}
    </>
  );
}
