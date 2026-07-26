"use client";

import {
  AdminAvailabilityStatus,
  EmptyState,
  dangerButton,
  enableButton,
  inputClass,
  primaryButton,
  quietButton
} from "@/components/admin/adminPrimitives";
import { presentProviderCredential } from "@/components/admin/providerAdvancedView";
import type { AdminConfirmationController } from "@/components/admin/useAdminConfirmationController";
import type { AdminProvidersController } from "@/components/admin/useAdminProvidersController";
import type { AdminProviderConnection } from "@/lib/contracts/adminProviders";
import { KeyRound, MoreHorizontal, Plus, TestTube2, Trash2 } from "lucide-react";
import { useState } from "react";

const fieldLabel = "mb-1 block text-xs font-medium text-ink-secondary";

function StateText({ children, tone = "neutral" }: Readonly<{
  children: string;
  tone?: "critical" | "neutral" | "positive" | "warning";
}>) {
  const toneClass = tone === "critical"
    ? "text-critical"
    : tone === "positive"
      ? "text-positive"
      : tone === "warning"
        ? "text-caution"
        : "text-ink-muted";
  return <span className={`text-xs font-medium ${toneClass}`}>{children}</span>;
}

export function AdminProviderCredentialsTask({
  connection,
  controller,
  requestConfirmation
}: Readonly<{
  connection: AdminProviderConnection;
  controller: AdminProvidersController;
  requestConfirmation: AdminConfirmationController["requestConfirmation"];
}>) {
  const [addOpen, setAddOpen] = useState(connection.credentials.length === 0);
  const [label, setLabel] = useState("Primary");
  const [secret, setSecret] = useState("");
  const [testedSecret, setTestedSecret] = useState<{
    connectionDraftVersion: number;
    value: string;
  } | null>(null);
  const [renameId, setRenameId] = useState<string | null>(null);
  const [renamedLabel, setRenamedLabel] = useState("");
  const [rotateTarget, setRotateTarget] = useState<{
    credentialId: string;
    expectedDraftVersion: number;
  } | null>(null);
  const [rotatedSecret, setRotatedSecret] = useState("");
  const [testedRotatedSecret, setTestedRotatedSecret] = useState<{
    connectionDraftVersion: number;
    value: string;
  } | null>(null);

  const secretIsTested = testedSecret?.connectionDraftVersion === connection.draftVersion &&
    testedSecret.value === secret;
  const rotatedSecretIsTested =
    testedRotatedSecret?.connectionDraftVersion === connection.draftVersion &&
    testedRotatedSecret.value === rotatedSecret;

  const closeAddForm = () => {
    setAddOpen(false);
    setSecret("");
    setTestedSecret(null);
  };

  return (
    <section
      className="min-w-0 bg-workspace-rail/45 px-4 py-4 sm:px-6"
      data-testid="provider-task-credentials"
    >
      <div className="min-w-0 rounded-panel border border-trace-subtle bg-answer-paper">
        <div className="flex flex-col gap-3 rounded-t-panel border-b border-trace-subtle bg-control-surface/60 px-4 py-3.5 sm:flex-row sm:items-start sm:justify-between">
          <div className="max-w-3xl">
            <h3 className="text-base font-semibold text-ink">Credentials</h3>
            <p className="mt-1 text-sm leading-6 text-ink-muted">
              Keys are write-only. Test checks the exact current field, while activation remains the authority for every referenced account.
            </p>
          </div>
          <button
            aria-expanded={addOpen}
            className={quietButton}
            data-provider-action="add-key"
            disabled={controller.state.busy}
            onClick={() => {
              if (addOpen) closeAddForm();
              else setAddOpen(true);
            }}
            type="button"
          >
            <Plus aria-hidden="true" className="size-3.5" />
            {addOpen ? "Close key form" : "Add key"}
          </button>
        </div>

        {addOpen ? (
          <form
            className="grid gap-3 border-b border-trace-subtle bg-answer-paper px-4 py-4 md:grid-cols-[minmax(10rem,.35fr)_minmax(14rem,1fr)_auto] md:items-end"
            onSubmit={(event) => {
              event.preventDefault();
              void controller.actions.createCredential(connection.id, { label, secret }).then((ok) => {
                if (ok) closeAddForm();
              });
            }}
          >
            <label>
              <span className={fieldLabel}>Key label</span>
              <input
                className={inputClass}
                disabled={controller.state.busy}
                maxLength={160}
                onChange={(event) => setLabel(event.currentTarget.value)}
                required
                value={label}
              />
            </label>
            <label>
              <span className={fieldLabel}>API key</span>
              <input
                autoComplete="new-password"
                className={`${inputClass} font-mono`}
                disabled={controller.state.busy}
                onChange={(event) => {
                  setSecret(event.currentTarget.value);
                  setTestedSecret(null);
                }}
                required
                type="password"
                value={secret}
              />
            </label>
            <div className="flex flex-wrap gap-2">
              <button
                className={quietButton}
                disabled={controller.state.busy || !secret.trim()}
                onClick={() => {
                  const candidate = {
                    connectionDraftVersion: connection.draftVersion,
                    value: secret
                  };
                  void controller.actions.testCredential(connection.id, {
                    expectedConnectionDraftVersion: candidate.connectionDraftVersion,
                    secret: candidate.value
                  }).then((ok) => {
                    if (ok) setTestedSecret(candidate);
                  });
                }}
                type="button"
              >
                <TestTube2 aria-hidden="true" className="size-3.5" />
                Test new key
              </button>
              <button
                className={primaryButton}
                disabled={controller.state.busy || !secret.trim() || !secretIsTested}
                type="submit"
              >
                <KeyRound aria-hidden="true" className="size-3.5" />
                Save key
              </button>
            </div>
          </form>
        ) : null}

        {connection.credentials.length ? (
          <div aria-label="Provider credentials" className="divide-y divide-trace-subtle" role="list">
            {connection.credentials.map((credential) => {
              const presentation = presentProviderCredential(credential);
              const publicationTone = presentation.publication === "active"
                ? "positive"
                : presentation.publication === "revoked"
                  ? "critical"
                  : presentation.publication === "draft" || presentation.publication === "replacement"
                    ? "warning"
                    : "neutral";
              return (
                <div className="px-4 py-4" key={credential.id} role="listitem">
                  <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                    <div className="min-w-0">
                      <p className="break-words text-sm font-medium text-ink">{credential.label}</p>
                      <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1">
                        <AdminAvailabilityStatus enabled={credential.enabled} />
                        <StateText tone={publicationTone}>{presentation.publicationLabel}</StateText>
                      </div>
                      <p className="mt-1 text-xs leading-5 text-ink-muted">{presentation.detail}</p>
                    </div>
                    <div className="flex flex-wrap items-center gap-1">
                      <button
                        aria-label={`Rename ${credential.label} credential`}
                        className={quietButton}
                        disabled={controller.state.busy}
                        onClick={() => {
                          setRenameId(credential.id);
                          setRotateTarget(null);
                          setRenamedLabel(credential.label);
                        }}
                        type="button"
                      >
                        Rename
                      </button>
                      <button
                        aria-label={`Rotate ${credential.label} credential`}
                        className={quietButton}
                        disabled={controller.state.busy}
                        onClick={() => {
                          setRotateTarget({
                            credentialId: credential.id,
                            expectedDraftVersion: credential.draftVersion
                          });
                          setRenameId(null);
                          setRotatedSecret("");
                          setTestedRotatedSecret(null);
                        }}
                        type="button"
                      >
                        Rotate
                      </button>
                      <button
                        aria-label={`${credential.enabled ? "Disable" : "Enable"} ${credential.label} credential`}
                        className={credential.enabled ? quietButton : enableButton}
                        disabled={controller.state.busy}
                        onClick={() => void controller.actions.updateCredential(
                          connection.id,
                          credential.id,
                          { action: credential.enabled ? "disable" : "enable" },
                          credential.enabled
                            ? "Credential disabled for new runs."
                            : "Credential enabled; activation will validate it before use."
                        )}
                        type="button"
                      >
                        {credential.enabled ? "Disable" : "Enable"}
                      </button>
                      <details className="relative">
                        <summary
                          aria-label={`More actions for ${credential.label} credential`}
                          className={`${quietButton} cursor-pointer list-none`}
                        >
                          <MoreHorizontal aria-hidden="true" className="size-3.5" />
                          More
                        </summary>
                        <div className="absolute right-0 top-full z-20 mt-1 grid min-w-52 gap-1 rounded-panel border border-trace-subtle bg-overlay-surface p-2 shadow-overlay">
                          {credential.draftSecretConfigured ? (
                            <button
                              aria-label={`Clear ${credential.label} key draft`}
                              className={dangerButton}
                              disabled={controller.state.busy}
                              onClick={() => requestConfirmation({
                                body: "The unactivated key draft will be removed. Any active key version remains unchanged.",
                                confirmLabel: "Clear key draft",
                                dialogLabel: `Clear ${credential.label} key draft`,
                                icon: "x",
                                onConfirm: async () => {
                                  await controller.actions.updateCredential(
                                    connection.id,
                                    credential.id,
                                    {
                                      action: "clear_draft",
                                      confirmed: true,
                                      expectedDraftVersion: credential.draftVersion
                                    },
                                    "Credential draft cleared."
                                  );
                                },
                                testId: "admin-confirm-clear-provider-key-draft",
                                title: "Clear this key draft?",
                                tone: "warning"
                              })}
                              type="button"
                            >
                              Clear key draft
                            </button>
                          ) : null}
                          {credential.activeVersion && !credential.activeVersion.revokedAt ? (
                            <button
                              aria-label={`Revoke ${credential.label} active key`}
                              className={dangerButton}
                              disabled={controller.state.busy}
                              onClick={() => requestConfirmation({
                                body: "This immediately revokes the active encrypted key for future provider calls. Calls that already loaded it cannot be recalled.",
                                confirmLabel: "Revoke active key",
                                dialogLabel: `Revoke ${credential.label} active key`,
                                icon: "x",
                                onConfirm: async () => {
                                  await controller.actions.updateCredential(
                                    connection.id,
                                    credential.id,
                                    {
                                      action: "revoke_active_version",
                                      clearSecret: true,
                                      confirmed: true,
                                      versionId: credential.activeVersion!.id
                                    },
                                    "Active credential version revoked."
                                  );
                                },
                                testId: "admin-confirm-revoke-provider-key",
                                title: "Emergency-revoke this key?",
                                tone: "destructive"
                              })}
                              type="button"
                            >
                              Revoke active key
                            </button>
                          ) : null}
                          <button
                            aria-label={`Delete ${credential.label} credential`}
                            className={dangerButton}
                            disabled={controller.state.busy}
                            onClick={() => requestConfirmation({
                              body: "The credential can be deleted only after every default, group assignment, and live run reference is removed.",
                              confirmLabel: "Delete credential",
                              dialogLabel: `Delete ${credential.label} credential`,
                              icon: "trash",
                              onConfirm: async () => {
                                await controller.actions.deleteCredential(connection.id, credential.id);
                              },
                              testId: "admin-confirm-delete-provider-credential",
                              title: `Delete “${credential.label}”?`,
                              tone: "destructive"
                            })}
                            type="button"
                          >
                            <Trash2 aria-hidden="true" className="size-3.5" />
                            Delete credential
                          </button>
                        </div>
                      </details>
                    </div>
                  </div>

                  {renameId === credential.id ? (
                    <form
                      className="mt-4 flex flex-col gap-2 border-t border-trace-subtle pt-4 sm:flex-row"
                      onSubmit={(event) => {
                        event.preventDefault();
                        void controller.actions.updateCredential(
                          connection.id,
                          credential.id,
                          { action: "rename", label: renamedLabel },
                          "Credential renamed."
                        ).then((ok) => {
                          if (ok) setRenameId(null);
                        });
                      }}
                    >
                      <label className="min-w-0 flex-1">
                        <span className="sr-only">New label for {credential.label}</span>
                        <input
                          className={inputClass}
                          disabled={controller.state.busy}
                          maxLength={160}
                          onChange={(event) => setRenamedLabel(event.currentTarget.value)}
                          required
                          value={renamedLabel}
                        />
                      </label>
                      <button className={primaryButton} disabled={controller.state.busy || !renamedLabel.trim()} type="submit">
                        Save label
                      </button>
                      <button className={quietButton} disabled={controller.state.busy} onClick={() => setRenameId(null)} type="button">
                        Cancel
                      </button>
                    </form>
                  ) : null}

                  {rotateTarget?.credentialId === credential.id ? (
                    <form
                      className="mt-4 grid gap-2 border-t border-trace-subtle pt-4 sm:grid-cols-[minmax(14rem,1fr)_auto_auto_auto] sm:items-end"
                      onSubmit={(event) => {
                        event.preventDefault();
                        void controller.actions.updateCredential(
                          connection.id,
                          credential.id,
                          {
                            action: "rotate",
                            expectedDraftVersion: rotateTarget.expectedDraftVersion,
                            secret: rotatedSecret
                          },
                          "Verified replacement key draft saved. Activate it before use."
                        ).then((ok) => {
                          if (ok) {
                            setRotateTarget(null);
                            setRotatedSecret("");
                            setTestedRotatedSecret(null);
                          }
                        });
                      }}
                    >
                      <label>
                        <span className={fieldLabel}>Replacement API key</span>
                        <input
                          autoComplete="new-password"
                          className={`${inputClass} font-mono`}
                          disabled={controller.state.busy}
                          onChange={(event) => {
                            setRotatedSecret(event.currentTarget.value);
                            setTestedRotatedSecret(null);
                          }}
                          placeholder="Replacement API key"
                          required
                          type="password"
                          value={rotatedSecret}
                        />
                      </label>
                      <button
                        className={quietButton}
                        disabled={controller.state.busy || !rotatedSecret.trim()}
                        onClick={() => {
                          const candidate = {
                            connectionDraftVersion: connection.draftVersion,
                            value: rotatedSecret
                          };
                          void controller.actions.testCredential(connection.id, {
                            expectedConnectionDraftVersion: candidate.connectionDraftVersion,
                            secret: candidate.value
                          }).then((ok) => {
                            if (ok) setTestedRotatedSecret(candidate);
                          });
                        }}
                        type="button"
                      >
                        Test replacement
                      </button>
                      <button
                        className={primaryButton}
                        disabled={controller.state.busy || !rotatedSecret.trim() || !rotatedSecretIsTested}
                        type="submit"
                      >
                        Save replacement
                      </button>
                      <button
                        className={quietButton}
                        disabled={controller.state.busy}
                        onClick={() => {
                          setRotateTarget(null);
                          setRotatedSecret("");
                          setTestedRotatedSecret(null);
                        }}
                        type="button"
                      >
                        Cancel
                      </button>
                    </form>
                  ) : null}
                </div>
              );
            })}
          </div>
        ) : (
          <EmptyState
            detail="Add one administrator-owned key before discovering or testing models."
            title="No credentials yet"
          />
        )}
      </div>
    </section>
  );
}
