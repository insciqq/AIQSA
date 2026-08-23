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
  AdminProviderConnection,
  AdminProviderCredential,
  AdminProviderDraftCheck,
  AdminProviderModel,
  AdminProviderModelConfiguration,
  AdminProviderTestEvidence
} from "@/lib/contracts/adminProviders";
import { Check, TestTube2 } from "lucide-react";
import { useId, useState } from "react";

type ProviderCapabilityCheck = AdminProviderActiveCheck | AdminProviderDraftCheck;
type ProviderCapabilityTarget = "active" | "draft";

const structuredOutputAdapters = new Set<AdminProviderModelConfiguration["adapterKind"]>([
  "openai_responses_compatible",
  "openai_responses_native",
  "openrouter_chat_completions"
]);

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

function verifiedChip(label: string) {
  return (
    <span
      aria-label={`${label} verified`}
      className="inline-flex shrink-0 items-center gap-1 rounded-pill bg-positive/10 px-2 py-0.5 text-metadata font-medium text-positive"
    >
      <Check aria-hidden="true" className="size-3" />
      Verified
    </span>
  );
}

function capabilityRows(
  configuration: AdminProviderModelConfiguration,
  check: ProviderCapabilityCheck | null
) {
  const capabilities = configuration.capabilities;
  const evidence = matchingEvidence(check, configuration);
  const modelAvailable = check?.status === "available" && evidence?.detail === "ok";
  const structuredOutput = evidence?.structuredOutput;
  const pdfInput = evidence?.pdfInput;
  const rows: Array<Readonly<{
    description: string;
    key: string;
    label: string;
    verified: boolean;
  }>> = [{
    description: configuration.modelClass === "embedding"
      ? "The deployment accepts a bounded embedding request or appears in the selected account catalog."
      : "The selected credential can reach this exact deployment and route.",
    key: "model-access",
    label: configuration.modelClass === "embedding" ? "Embeddings" : "Model access",
    verified: modelAvailable
  }];

  if (configuration.modelClass === "embedding") {
    if (configuration.embedding) {
      rows.push({
        description: configuration.embedding.nativeDimension === configuration.embedding.targetDimension
          ? `${configuration.embedding.nativeDimension.toLocaleString()} provider dimensions are normalized locally.`
          : `${configuration.embedding.nativeDimension.toLocaleString()} provider dimensions are truncated to ${configuration.embedding.targetDimension.toLocaleString()} and normalized locally.`,
        key: "vector-dimensions",
        label: "Vector dimensions",
        verified: false
      });
      if (configuration.embedding.queryInstructionTemplate) {
        rows.push({
          description: "AIQSA applies the configured query instruction while keeping document inputs bare.",
          key: "query-instructions",
          label: "Query instructions",
          verified: false
        });
      }
    }
    if (capabilities.contextWindow) {
      rows.push({
        description: `${capabilities.contextWindow.toLocaleString()} configured context tokens.`,
        key: "context-window",
        label: "Context window",
        verified: false
      });
    }
    return rows;
  }

  if (structuredOutputAdapters.has(configuration.adapterKind)) {
    rows.push({
      description: "The deployment returned an object that passed AIQSA's strict JSON Schema probe.",
      key: "structured-output",
      label: "Structured output",
      verified: Boolean(
        structuredOutput?.verified === true &&
        structuredOutput.adapterKind === configuration.adapterKind &&
        structuredOutput.upstreamModelId === configuration.upstreamModelId
      )
    });
  }
  if (capabilities.nativePdfInput) {
    rows.push({
      description: "AIQSA sends the original PDF only after the image-only PDF probe succeeds. Otherwise it sends locally extracted text.",
      key: "direct-pdf",
      label: "Direct PDF",
      verified: Boolean(
        pdfInput?.verified === true &&
        pdfInput.adapterKind === configuration.adapterKind &&
        pdfInput.upstreamModelId === configuration.upstreamModelId
      )
    });
  }
  if (capabilities.pdf) {
    rows.push({
      description: "AIQSA can extract PDF text locally and include it in an ordinary model request.",
      key: "pdf-text",
      label: "PDF text",
      verified: false
    });
  }
  if (capabilities.reasoning) {
    rows.push({
      description: "The configured request contract exposes reasoning controls for this deployment.",
      key: "reasoning",
      label: "Reasoning",
      verified: false
    });
  }
  if (capabilities.vision) {
    rows.push({
      description: "The deployment accepts image content in conversation requests.",
      key: "vision",
      label: "Vision",
      verified: false
    });
  }
  if (capabilities.nativeSearch) {
    rows.push({
      description: "The provider's hosted search can be requested for this deployment.",
      key: "hosted-search",
      label: "Hosted search",
      verified: false
    });
  }
  if (capabilities.toolCalling) {
    rows.push({
      description: "AIQSA can expose approved tools to this deployment during a run.",
      key: "tool-calling",
      label: "Tool calling",
      verified: false
    });
  }
  if (capabilities.parallelToolCalls) {
    rows.push({
      description: "The request contract permits more than one tool call in the same model turn.",
      key: "parallel-tools",
      label: "Parallel tool calls",
      verified: false
    });
  }
  if (capabilities.streaming) {
    rows.push({
      description: "Answer tokens can be delivered incrementally while the model is running.",
      key: "streaming",
      label: "Streaming",
      verified: false
    });
  }
  if (capabilities.backgroundStreaming || capabilities.nativeBackground) {
    rows.push({
      description: "Long-running provider responses may continue through the configured background lifecycle.",
      key: "background",
      label: "Background responses",
      verified: false
    });
  }
  if (capabilities.streamUsage) {
    rows.push({
      description: "The compatible streaming endpoint is configured to return provider usage totals.",
      key: "stream-usage",
      label: "Streaming usage",
      verified: false
    });
  }
  if (capabilities.contextWindow) {
    rows.push({
      description: `${capabilities.contextWindow.toLocaleString()} configured context tokens.`,
      key: "context-window",
      label: "Context window",
      verified: false
    });
  }
  return rows;
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
  const paid = connection.family !== "openrouter" || !isEmbedding;

  const testCapabilities = async () => {
    if (!credential || testing) return;
    setTesting(true);
    setTestFailed(false);
    try {
      const ok = target === "active"
        ? await controller.actions.refreshActive(
            connection.id,
            model.id,
            credential.id,
            paid
          )
        : await controller.actions.testDraft(connection.id, model.id, {
            confirmPaidRequest: paid,
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
    if (!paid) {
      void testCapabilities();
      return;
    }
    requestConfirmation({
      body: isEmbedding
        ? "AIQSA will send one small embedding request. It may consume provider quota; the returned vector is discarded."
        : connection.family === "openrouter"
          ? "AIQSA will check the account catalog and configured route, then probe strict structured output and Direct PDF when enabled. This may make several catalog lookups and up to two small paid requests. Successful evidence applies automatically to this exact model and key."
          : "AIQSA will check model access and strict structured output, plus Direct PDF when it is enabled. The test may send up to three small provider requests. Successful evidence applies automatically to this exact model and key.",
      confirmLabel: "Run capability test",
      dialogLabel: `Test ${model.displayName} capabilities`,
      onConfirm: testCapabilities,
      testId: "admin-confirm-provider-capability-test",
      title: "Test capabilities?",
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
          <h4 className="text-sm font-semibold text-ink" id={headingId}>Capabilities &amp; verification</h4>
          <p className="mt-1 text-xs leading-5 text-ink-muted">
            One test records only capabilities proved for this exact model and credential. Capabilities without evidence remain unmarked.
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
              {testing ? "Testing…" : "Test capabilities"}
            </button>
          </div>
        ) : null}
      </div>

      {credential ? (
        <>
          <ul className="mt-4 divide-y divide-trace-subtle border-y border-trace-subtle" aria-label={`${model.displayName} capabilities`}>
            {rows.map((row) => (
              <li className="flex min-w-0 items-start justify-between gap-4 py-3" key={row.key}>
                <div className="min-w-0">
                  <p className="text-xs font-medium text-ink">{row.label}</p>
                  <p className="mt-0.5 max-w-3xl text-xs leading-5 text-ink-muted">{row.description}</p>
                </div>
                {row.verified ? verifiedChip(row.label) : null}
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
              The capability test could not be completed. Existing verified evidence was not changed.
            </p>
          ) : null}
          {!model.enabled ? (
            <p className="mt-3 text-xs text-ink-muted">Enable this model before testing its capabilities.</p>
          ) : null}
        </>
      ) : (
        <EmptyState
          detail="Add or restore one usable credential before testing this model."
          title="No credential available"
        />
      )}
    </section>
  );
}
