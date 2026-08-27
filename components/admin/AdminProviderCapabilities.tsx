"use client";

import {
  EmptyState,
  inputClass,
  primaryButton
} from "@/components/admin/adminPrimitives";
import { providerCredentialUsable } from "@/components/admin/providerAdvancedView";
import type { AdminConfirmationController } from "@/components/admin/useAdminConfirmationController";
import type { AdminProvidersController } from "@/components/admin/useAdminProvidersController";
import type {
  AdminProviderActiveCheck,
  AdminProviderCompatibilityStatus,
  AdminProviderConnection,
  AdminProviderCredential,
  AdminProviderDraftCheck,
  AdminProviderModel,
  AdminProviderModelConfiguration,
  AdminProviderTestEvidence
} from "@/lib/contracts/adminProviders";
import { Check, TestTube2, X } from "lucide-react";
import { useId, useState } from "react";

type ProviderCapabilityCheck = AdminProviderActiveCheck | AdminProviderDraftCheck;
type ProviderCapabilityTarget = "active" | "draft";

const fieldLabel = "mb-1 block text-xs font-medium text-ink-secondary";

function latestCheck<CheckType extends ProviderCapabilityCheck>(
  checks: readonly CheckType[]
): CheckType | null {
  return checks.reduce<CheckType | null>((latest, check) => (
    !latest || Date.parse(check.checkedAt) > Date.parse(latest.checkedAt) ? check : latest
  ), null);
}

export function providerCapabilityTarget(
  connection: AdminProviderConnection,
  model: AdminProviderModel,
  credential: AdminProviderCredential
): ProviderCapabilityTarget {
  const activeCredential = credential.activeVersion;
  return connection.activeConfig && connection.activeVersion === connection.draftVersion &&
    model.activeConfig && model.activeVersion === model.draftVersion &&
    !credential.draftSecretConfigured && activeCredential && !activeCredential.revokedAt
    ? "active"
    : "draft";
}

export function matchingProviderCapabilityCheck(input: Readonly<{
  connection: AdminProviderConnection;
  credential: AdminProviderCredential;
  model: AdminProviderModel;
  target: ProviderCapabilityTarget;
}>): ProviderCapabilityCheck | null {
  const { connection, credential, model, target } = input;
  if (target === "active") {
    const activeVersion = credential.activeVersion;
    if (!activeVersion || activeVersion.revokedAt) return null;
    return latestCheck(connection.activeChecks.filter((check) =>
      check.connectionVersion === connection.activeVersion &&
      check.modelVersion === model.activeVersion &&
      check.providerModelId === model.id &&
      check.credentialId === credential.id &&
      check.credentialVersionId === activeVersion.id
    ));
  }

  const sourceMatches = credential.draftSecretConfigured
    ? (check: AdminProviderDraftCheck) =>
        check.credentialDraftVersion === credential.draftVersion &&
        check.credentialVersionId === null
    : (check: AdminProviderDraftCheck) =>
        check.credentialDraftVersion === null &&
        check.credentialVersionId === credential.activeVersion?.id;
  return latestCheck(connection.draftChecks.filter((check) =>
    check.connectionDraftVersion === connection.draftVersion &&
    check.modelDraftVersion === model.draftVersion &&
    check.providerModelId === model.id &&
    check.credentialId === credential.id &&
    sourceMatches(check)
  ));
}

function matchingEvidence(
  check: ProviderCapabilityCheck | null,
  configuration: AdminProviderModelConfiguration
): AdminProviderTestEvidence | null {
  const evidence = check?.evidence ?? null;
  return evidence?.upstreamModelId === configuration.upstreamModelId ? evidence : null;
}

function statusChip(label: string, status: AdminProviderCompatibilityStatus) {
  const verified = status === "verified";
  return (
    <span
      aria-label={`${label} ${verified ? "verified" : "not supported"}`}
      className={verified
        ? "inline-flex shrink-0 items-center gap-1 rounded-pill bg-positive/10 px-2 py-0.5 text-metadata font-medium text-positive"
        : "inline-flex shrink-0 items-center gap-1 rounded-pill border border-trace-subtle bg-control-surface px-2 py-0.5 text-metadata font-medium text-ink-muted"}
    >
      {verified
        ? <Check aria-hidden="true" className="size-3" />
        : <X aria-hidden="true" className="size-3" />}
      {verified ? "Verified" : "Not supported"}
    </span>
  );
}

function capabilityRows(
  configuration: AdminProviderModelConfiguration,
  check: ProviderCapabilityCheck | null
) {
  const evidence = matchingEvidence(check, configuration);
  const compatibility = evidence?.compatibility;
  const legacyModelStatus: AdminProviderCompatibilityStatus | null = check?.status === "unavailable"
    ? "not_supported"
    : check?.status === "available" && evidence?.detail === "ok"
      ? "verified"
      : null;
  const structuredOutput = evidence?.structuredOutput;
  const pdfInput = evidence?.pdfInput;
  const rows: Array<Readonly<{
    description: string;
    key: string;
    label: string;
    status: AdminProviderCompatibilityStatus | null;
  }>> = [{
    description: configuration.modelClass === "embedding"
      ? "A bounded embedding request completed for this exact model and credential."
      : configuration.modelClass === "reranker"
        ? "A bounded two-document ranking request completed for this exact model and credential."
      : "A bounded generation request completed for this exact model and credential.",
    key: "model-access",
    label: "Model access",
    status: compatibility?.modelAccess ?? legacyModelStatus
  }, {
    description: "The response passed AIQSA's strict JSON Schema probe.",
    key: "structured-output",
    label: "Structured Output",
    status: compatibility?.structuredOutput ?? (
      structuredOutput?.verified === true &&
      structuredOutput.adapterKind === configuration.adapterKind &&
      structuredOutput.upstreamModelId === configuration.upstreamModelId
        ? "verified"
        : null
    )
  }, {
    description: "The model read a code from AIQSA's image-only PDF without a text layer.",
    key: "direct-pdf",
    label: "Direct PDF",
    status: compatibility?.directPdf ?? (
      pdfInput?.verified === true &&
      pdfInput.adapterKind === configuration.adapterKind &&
      pdfInput.upstreamModelId === configuration.upstreamModelId
        ? "verified"
        : null
    )
  }, {
    description: "A streamed response completed with the terminal events required by the configured adapter.",
    key: "streaming",
    label: "Streaming protocol",
    status: compatibility?.streaming ?? null
  }, {
    description: configuration.modelClass === "embedding"
      ? "The embedding response included provider token usage."
      : configuration.modelClass === "reranker"
        ? "The ranking response included provider token or search-unit usage."
      : "At least one compatibility response included provider token usage.",
    key: "usage",
    label: "Usage reporting",
    status: compatibility?.usage ?? null
  }];
  return configuration.modelClass === "answer"
    ? rows
    : rows.filter(({ key }) => key === "model-access" || key === "usage");
}

export function AdminProviderCapabilities({
  connection,
  controller,
  model,
  requestConfirmation
}: Readonly<{
  connection: AdminProviderConnection;
  controller: AdminProvidersController;
  model: AdminProviderModel;
  requestConfirmation: AdminConfirmationController["requestConfirmation"];
}>) {
  const headingId = useId();
  const usableCredentials = connection.credentials.filter(providerCredentialUsable);
  const [credentialId, setCredentialId] = useState(() => {
    const preferred = usableCredentials.find(({ id }) => id === connection.defaultCredentialId);
    return preferred?.id ?? usableCredentials[0]?.id ?? "";
  });
  const [testing, setTesting] = useState(false);
  const [testFailed, setTestFailed] = useState(false);
  const credential = usableCredentials.find(({ id }) => id === credentialId) ??
    usableCredentials[0] ?? null;
  const target = credential ? providerCapabilityTarget(connection, model, credential) : "draft";
  const check = credential
    ? matchingProviderCapabilityCheck({ connection, credential, model, target })
    : null;
  const configuration = target === "active" && model.activeConfig
    ? model.activeConfig
    : model.draftConfig;
  const rows = capabilityRows(configuration, check);
  const isEmbedding = configuration.modelClass === "embedding";
  const isReranker = configuration.modelClass === "reranker";

  const runCompatibilityChecks = async () => {
    if (!credential || testing) return;
    setTesting(true);
    setTestFailed(false);
    try {
      const ok = target === "active"
        ? await controller.actions.refreshActive(
            connection.id,
            model.id,
            credential.id,
            true
          )
        : await controller.actions.testDraft(connection.id, model.id, {
            confirmPaidRequest: true,
            credentialId: credential.id,
            mode: connection.family === "openrouter" ? "account_catalog" : "tiny_generation"
          });
      setTestFailed(!ok);
    } catch {
      setTestFailed(true);
    } finally {
      setTesting(false);
    }
  };

  const requestTest = () => {
    if (!credential) return;
    requestConfirmation({
      body: isEmbedding
        ? "AIQSA will send one small embedding request to verify model access and usage reporting. It may consume provider quota; the returned vector is discarded."
        : isReranker
          ? "AIQSA will check the OpenRouter account catalog and send one small two-document ranking request. It may consume provider quota; returned scores are discarded."
        : connection.family === "openrouter"
          ? "AIQSA will check the account catalog and configured route, then send up to four small requests for model access, Structured Output, Direct PDF, streaming, and usage reporting. Requests may consume provider quota."
          : "AIQSA will send up to four small requests for model access, Structured Output, Direct PDF, streaming, and usage reporting. Requests may consume provider quota.",
      confirmLabel: "Run checks",
      dialogLabel: `Run ${model.displayName} compatibility checks`,
      onConfirm: runCompatibilityChecks,
      testId: "admin-confirm-provider-capability-test",
      title: "Run compatibility checks?",
      tone: "warning"
    });
  };

  return (
    <section
      aria-labelledby={headingId}
      className="border-t border-trace-subtle bg-workspace-rail/25 px-4 py-4"
      data-testid={`provider-model-capabilities-${model.id}`}
    >
      <div className="flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
        <div className="max-w-3xl">
          <h4 className="text-sm font-semibold text-ink" id={headingId}>Compatibility checks</h4>
          <p className="mt-1 text-xs leading-5 text-ink-muted">
            {configuration.modelClass === "answer"
              ? "Five runtime contracts are checked for this exact model and credential."
              : "Model access and usage reporting are checked for this exact specialized deployment and credential."} Transient provider failures do not overwrite earlier evidence.
          </p>
        </div>
        {credential ? (
          <div className="flex min-w-0 flex-col gap-2 sm:flex-row sm:items-end">
            <label className="min-w-48 flex-1">
              <span className={fieldLabel}>Credential</span>
              <select
                className={inputClass}
                disabled={controller.state.busy || testing}
                onChange={(event) => {
                  setCredentialId(event.currentTarget.value);
                  setTestFailed(false);
                }}
                value={credential.id}
              >
                {usableCredentials.map((candidate) => (
                  <option key={candidate.id} value={candidate.id}>{candidate.label}</option>
                ))}
              </select>
            </label>
            <button
              className={primaryButton}
              disabled={controller.state.busy || testing || !model.enabled}
              onClick={requestTest}
              type="button"
            >
              <TestTube2 aria-hidden="true" className="size-3.5" />
              {testing ? "Checking…" : "Run compatibility checks"}
            </button>
          </div>
        ) : null}
      </div>

      {credential ? (
        <>
          <ul className="mt-4 divide-y divide-trace-subtle border-y border-trace-subtle" aria-label={`${model.displayName} compatibility checks`}>
            {rows.map((row) => (
              <li className="flex min-w-0 items-start justify-between gap-4 py-3" key={row.key}>
                <div className="min-w-0">
                  <p className="text-xs font-medium text-ink">{row.label}</p>
                  <p className="mt-0.5 max-w-3xl text-xs leading-5 text-ink-muted">{row.description}</p>
                </div>
                {row.status ? statusChip(row.label, row.status) : null}
              </li>
            ))}
          </ul>
          {check ? (
            <p className="mt-3 text-metadata text-ink-muted">
              Last tested <time dateTime={check.checkedAt}>{new Date(check.checkedAt).toLocaleString()}</time> with {credential.label}.
            </p>
          ) : null}
          {testFailed && controller.state.feedbackConnectionId === connection.id && controller.state.error ? (
            <p className="mt-3 rounded-control bg-critical/10 px-3 py-2 text-xs text-critical" role="alert">
              {controller.state.error}
            </p>
          ) : testFailed ? (
            <p className="mt-3 rounded-control bg-critical/10 px-3 py-2 text-xs text-critical" role="alert">
              The compatibility checks could not be completed. Existing evidence was not changed.
            </p>
          ) : null}
          {!model.enabled ? (
            <p className="mt-3 text-xs text-ink-muted">Enable this model before running compatibility checks.</p>
          ) : null}
        </>
      ) : (
        <EmptyState
          detail="Add or restore one usable credential before running compatibility checks."
          title="No credential available"
        />
      )}
    </section>
  );
}
