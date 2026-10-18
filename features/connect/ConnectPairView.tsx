"use client";

import { UiV2Button } from "@/components/ui-v2";
import {
  CONNECT_PAGE_PATH,
  connectPairPagePath,
  normalizeConnectUserCode,
  type ConnectPairingDecision,
  type ConnectPairingLookupResponse
} from "@/lib/contracts/connect";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useId, useState, type FormEvent } from "react";
import { decideConnectPairing, lookupConnectPairing, type ConnectFailureCode } from "./connectApi";
import { ConnectPageHeader } from "./ConnectHomeView";
import { useConnectShell } from "./connectShellContext";
import { connectErrorMessage, connectPlatformLabel } from "./connectText";

type PairState =
  | Readonly<{ kind: "loading" }>
  | Readonly<{ kind: "ready"; pairing: ConnectPairingLookupResponse["pairing"] }>
  | Readonly<{ code: ConnectFailureCode; kind: "failed"; retryAfterSeconds?: number }>
  | Readonly<{ kind: "approved" }>
  | Readonly<{ kind: "denied" }>;

const NEUTRAL_CODES: readonly ConnectFailureCode[] = [
  "connect_pairing_expired",
  "connect_not_found",
  "connect_request_invalid"
];

/** One neutral answer for unknown, expired, used and already decided codes. */
function pairFailureMessage(code: ConnectFailureCode, retryAfterSeconds?: number): string {
  return NEUTRAL_CODES.includes(code)
    ? connectErrorMessage("connect_pairing_expired")
    : connectErrorMessage(code, retryAfterSeconds);
}

function CodeForm({ initial }: Readonly<{ initial: string }>) {
  const router = useRouter();
  const id = useId();
  const [value, setValue] = useState(initial);
  const [invalid, setInvalid] = useState(false);
  function submit(event: FormEvent) {
    event.preventDefault();
    const code = normalizeConnectUserCode(value);
    setInvalid(!code);
    if (code) router.push(connectPairPagePath(code));
  }
  return (
    <form className="mt-5 flex flex-col gap-2" noValidate onSubmit={submit}>
      <label className="v2-connect-field-label" htmlFor={id}>Code from the terminal</label>
      <div className="flex flex-wrap gap-2">
        <input
          aria-describedby={invalid ? `${id}-error` : undefined}
          aria-invalid={invalid || undefined}
          autoCapitalize="characters"
          autoComplete="off"
          className="v2-connect-input w-44 font-mono uppercase tracking-[0.12em]"
          id={id}
          maxLength={12}
          onChange={(event) => setValue(event.target.value)}
          placeholder="ABCD-EFGH"
          spellCheck={false}
          value={value}
        />
        <UiV2Button tone="primary" type="submit">Continue</UiV2Button>
      </div>
      {invalid ? <p className="text-metadata text-critical" id={`${id}-error`}>Enter the eight-character code, like ABCD-EFGH.</p> : null}
    </form>
  );
}

/** `/connect/pair?code=`: the user approves or denies a computer that ran `aiqsa-connect login`. */
export function ConnectPairView({ code: rawCode }: Readonly<{ code: string | null }>) {
  const { leave } = useConnectShell();
  const code = rawCode ? normalizeConnectUserCode(rawCode) : null;
  const [busy, setBusy] = useState<ConnectPairingDecision | null>(null);
  const [decisionError, setDecisionError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  // Each lookup owns its answer: a new code or a retry starts as loading.
  const lookupKey = `${code ?? ""}:${attempt}`;
  const [answer, setAnswer] = useState<Readonly<{ key: string; state: PairState }> | null>(null);
  const state: PairState = answer?.key === lookupKey ? answer.state : { kind: "loading" };
  const setState = (next: PairState) => setAnswer({ key: lookupKey, state: next });

  useEffect(() => {
    if (!code) return;
    const controller = new AbortController();
    const settle = (next: PairState) => setAnswer({ key: lookupKey, state: next });
    void lookupConnectPairing(code, controller.signal).then((result) => {
      if (controller.signal.aborted) return;
      if (result.ok) settle({ kind: "ready", pairing: result.data.pairing });
      else if (result.code === "connect_disabled") leave("disabled");
      else if (result.code === "connect_unauthorized") leave("signed_out");
      else settle({ code: result.code, kind: "failed", retryAfterSeconds: result.retryAfterSeconds });
    });
    return () => controller.abort();
  }, [code, leave, lookupKey]);

  async function decide(decision: ConnectPairingDecision) {
    if (!code || busy) return;
    setBusy(decision);
    setDecisionError(null);
    const result = await decideConnectPairing(code, decision);
    setBusy(null);
    if (result.ok) {
      setState({ kind: result.data.status === "approved" ? "approved" : "denied" });
      return;
    }
    if (result.code === "connect_disabled") return leave("disabled");
    if (result.code === "connect_unauthorized") return leave("signed_out");
    if (NEUTRAL_CODES.includes(result.code)) {
      setState({ code: result.code, kind: "failed" });
      return;
    }
    setDecisionError(connectErrorMessage(result.code, result.retryAfterSeconds));
  }

  let body: React.ReactNode;
  if (!code) {
    body = (
      <>
        <h2 className="text-lg font-semibold text-ink">Connect a computer</h2>
        <p className="mt-2 text-sm leading-6 text-ink-secondary">
          {rawCode
            ? connectErrorMessage("connect_pairing_expired")
            : "Run aiqsa-connect login on your computer and open the link it shows, or enter its code here."}
        </p>
        <CodeForm initial="" />
      </>
    );
  } else if (state.kind === "loading") {
    body = <p className="text-sm text-ink-muted" role="status">Checking the code…</p>;
  } else if (state.kind === "failed") {
    const neutral = NEUTRAL_CODES.includes(state.code);
    body = (
      <>
        <h2 className="text-lg font-semibold text-ink">{neutral ? "This code cannot be used" : "The code could not be checked"}</h2>
        <p className="mt-2 text-sm leading-6 text-ink-secondary" role="alert">
          {pairFailureMessage(state.code, state.retryAfterSeconds)}
        </p>
        {neutral ? <CodeForm initial="" /> : (
          <UiV2Button className="mt-4" onClick={() => setAttempt((value) => value + 1)}>Try again</UiV2Button>
        )}
      </>
    );
  } else if (state.kind === "approved") {
    body = (
      <div data-testid="connect-pair-approved">
        <h2 className="text-lg font-semibold text-ink">Computer connected</h2>
        <p className="mt-2 text-sm leading-6 text-ink-secondary">
          Return to the terminal to finish. On a new computer, run aiqsa-connect setup and then
          aiqsa-connect service install there.
        </p>
        <Link className="v2-connect-link v2-focusable mt-4 inline-block text-sm" href={CONNECT_PAGE_PATH}>Open AIQSA Connect</Link>
      </div>
    );
  } else if (state.kind === "denied") {
    body = (
      <div data-testid="connect-pair-denied">
        <h2 className="text-lg font-semibold text-ink">Request denied</h2>
        <p className="mt-2 text-sm leading-6 text-ink-secondary">
          The computer was not connected and cannot reach AIQSA. You can close this page.
        </p>
      </div>
    );
  } else {
    const { pairing } = state;
    body = (
      <>
        <h2 className="text-lg font-semibold text-ink">Connect this computer to your AIQSA?</h2>
        <p className="mt-2 text-sm leading-6 text-ink-secondary">
          Approve only a computer where you just ran aiqsa-connect login. Its terminals can then be opened from
          any browser signed in to your account.
        </p>
        <dl className="v2-connect-facts mt-5" data-testid="connect-pair-facts">
          <div><dt>Name</dt><dd>{pairing.name}</dd></div>
          <div><dt>Hostname</dt><dd className="font-mono">{pairing.hostname}</dd></div>
          <div><dt>System</dt><dd>{connectPlatformLabel(pairing.os, pairing.arch)}</dd></div>
          <div><dt>Client version</dt><dd className="font-mono">{pairing.clientVersion}</dd></div>
          <div><dt>Code</dt><dd className="font-mono">{code}</dd></div>
        </dl>
        {decisionError ? <p className="v2-connect-alert mt-4" role="alert">{decisionError}</p> : null}
        <div className="mt-5 flex flex-wrap gap-2">
          <UiV2Button busy={busy === "approve"} disabled={busy !== null} onClick={() => void decide("approve")} tone="primary">
            Approve
          </UiV2Button>
          <UiV2Button busy={busy === "deny"} disabled={busy !== null} onClick={() => void decide("deny")}>
            Deny
          </UiV2Button>
        </div>
      </>
    );
  }

  return (
    <>
      <ConnectPageHeader title="Connect a computer" />
      <div className="min-h-0 flex-1 overflow-y-auto px-4 py-8 sm:px-8">
        <section className="v2-connect-pair mx-auto max-w-xl" data-testid="connect-pair">{body}</section>
      </div>
    </>
  );
}
