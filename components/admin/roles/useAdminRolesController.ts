import {
  activateAdminKnowledgeProfile,
  adminKnowledgeErrorMessage,
  getAdminKnowledgeSettings,
  rollbackAdminKnowledgeProfile
} from "@/components/admin/adminKnowledgeApi";
import {
  adminModelPolicyErrorMessage,
  getAdminModelPolicy,
  updateAdminModelPolicy,
  type AdminModelPolicyUpdateInput
} from "@/components/admin/adminModelPolicyApi";
import {
  adminSystemModelPolicyErrorMessage,
  getAdminSystemModelPolicy,
  updateAdminSystemModelPolicy,
  verifyAdminSystemModelRole
} from "@/components/admin/adminSystemModelPolicyApi";
import {
  knowledgeDocumentDestinations,
  knowledgeProcessingState,
  type KnowledgeModelMode
} from "@/components/admin/roles/rolesView";
import type { AdminFeedbackNoticeAction } from "@/components/admin/useAdminFeedback";
import type { AdminKnowledgePdfProcessingMode, AdminKnowledgeSettings } from "@/lib/contracts/adminKnowledge";
import type { AdminModelPolicyCatalog } from "@/lib/contracts/adminModelPolicy";
import type {
  AdminSystemModelEligibilityRole,
  AdminSystemModelPolicyCatalog
} from "@/lib/contracts/adminSystemModelPolicy";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

/** Fields of one immediate role save; absent fields preserve the other roles. */
export type AdminRolePatch = Readonly<{
  chatPdfPreparationAllowed?: boolean;
  chatPdfProviderModelId?: string | null;
  chatPdfReasoningEffort?: string | null;
  providerModelId?: string | null;
  reasoningEffort?: string | null;
  rerankerProviderModelId?: string | null;
}>;

export type AdminKnowledgeDraft = Readonly<{
  documentDeploymentId: string | null;
  embeddingDeploymentId: string;
  mode: AdminKnowledgePdfProcessingMode;
}>;

export type AdminRolesController = Readonly<{
  applyKnowledge(draft: AdminKnowledgeDraft): Promise<boolean>;
  /** Immediate apply for rows 1–3; `undo` reverts through the same PATCH. */
  assign(patch: AdminRolePatch, undo: AdminRolePatch | null): Promise<boolean>;
  busy: boolean;
  checkAndAssign(role: "memory" | "vision", id: string): Promise<boolean>;
  checkDocument(mode: KnowledgeModelMode, id: string): Promise<boolean>;
  checking: Readonly<{ id: string; role: AdminSystemModelEligibilityRole }> | null;
  error: string | null;
  knowledge: AdminKnowledgeSettings | null;
  knowledgeError: string | null;
  knowledgeLoading: boolean;
  loading: boolean;
  modelPolicy: AdminModelPolicyCatalog | null;
  modelPolicyError: string | null;
  policy: AdminSystemModelPolicyCatalog | null;
  refresh(): Promise<void>;
  restoreKnowledge(revisionId: string): Promise<boolean>;
  saveChatDefaults(input: Omit<AdminModelPolicyUpdateInput, "expectedVersion">): Promise<string | null>;
}>;

export type UseAdminRolesControllerOptions = Readonly<{
  onMutationCommitted?(): void | Promise<unknown>;
  reportError(message: string): void;
  reportNotice(message: string, action?: AdminFeedbackNoticeAction): void;
}>;

export const ADMIN_ROLE_SAVED_NOTICE = "Saved for future work";

/**
 * One state owner for the Defaults & roles page: the role catalog, the chat
 * defaults policy and the Knowledge profile, plus every mutation. Server
 * responses replace local state after each save; nothing is pre-selected
 * that the server did not report.
 */
export function useAdminRolesController({
  onMutationCommitted,
  reportError,
  reportNotice
}: UseAdminRolesControllerOptions): AdminRolesController {
  const [policy, setPolicyState] = useState<AdminSystemModelPolicyCatalog | null>(null);
  const [modelPolicy, setModelPolicyState] = useState<AdminModelPolicyCatalog | null>(null);
  const [knowledge, setKnowledgeState] = useState<AdminKnowledgeSettings | null>(null);
  const [loading, setLoading] = useState(false);
  const [knowledgeLoading, setKnowledgeLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [modelPolicyError, setModelPolicyError] = useState<string | null>(null);
  const [knowledgeError, setKnowledgeError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [checking, setChecking] = useState<AdminRolesController["checking"]>(null);
  const policyRef = useRef<AdminSystemModelPolicyCatalog | null>(null);
  const modelPolicyRef = useRef<AdminModelPolicyCatalog | null>(null);
  const knowledgeRef = useRef<AdminKnowledgeSettings | null>(null);
  const assignRef = useRef<AdminRolesController["assign"] | null>(null);
  const readEpoch = useRef(0);
  const readSequence = useRef({ knowledge: 0, model: 0, policy: 0 });
  const actionPending = useRef(false);
  const invalidateReads = useCallback(() => {
    readEpoch.current += 1;
    setLoading(false);
    setKnowledgeLoading(false);
  }, []);
  const setMutationBusy = useCallback((pending: boolean) => {
    invalidateReads();
    actionPending.current = pending;
    setBusy(pending);
  }, [invalidateReads]);

  const setPolicy = useCallback((next: AdminSystemModelPolicyCatalog) => {
    policyRef.current = next;
    setPolicyState(next);
  }, []);
  const setModelPolicy = useCallback((next: AdminModelPolicyCatalog) => {
    modelPolicyRef.current = next;
    setModelPolicyState(next);
  }, []);
  const setKnowledge = useCallback((next: AdminKnowledgeSettings) => {
    knowledgeRef.current = next;
    setKnowledgeState(next);
  }, []);
  const commit = useCallback(() => {
    void Promise.resolve(onMutationCommitted?.()).catch(() => undefined);
  }, [onMutationCommitted]);

  const refreshPolicy = useCallback(async () => {
    if (actionPending.current) return;
    const epoch = readEpoch.current;
    const sequence = ++readSequence.current.policy;
    const result = await getAdminSystemModelPolicy();
    if (epoch !== readEpoch.current || sequence !== readSequence.current.policy) return;
    if (result.ok) {
      setPolicy(result.data);
      setError(null);
    } else {
      setError(adminSystemModelPolicyErrorMessage(result.error));
    }
  }, [setPolicy]);
  const refreshModelPolicy = useCallback(async () => {
    if (actionPending.current) return;
    const epoch = readEpoch.current;
    const sequence = ++readSequence.current.model;
    const result = await getAdminModelPolicy();
    if (epoch !== readEpoch.current || sequence !== readSequence.current.model) return;
    if (result.ok) {
      setModelPolicy(result.data);
      setModelPolicyError(null);
    } else {
      setModelPolicyError(adminModelPolicyErrorMessage(result.error));
    }
  }, [setModelPolicy]);
  const refreshKnowledge = useCallback(async () => {
    if (actionPending.current) return;
    const epoch = readEpoch.current;
    const sequence = ++readSequence.current.knowledge;
    setKnowledgeLoading(true);
    const result = await getAdminKnowledgeSettings();
    if (epoch !== readEpoch.current || sequence !== readSequence.current.knowledge) return;
    setKnowledgeLoading(false);
    if (result.ok) {
      setKnowledge(result.data);
      setKnowledgeError(null);
    } else {
      setKnowledgeError(adminKnowledgeErrorMessage(result.error));
    }
  }, [setKnowledge]);
  const refresh = useCallback(async () => {
    if (actionPending.current) return;
    const epoch = readEpoch.current;
    setLoading(true);
    await Promise.all([refreshPolicy(), refreshModelPolicy(), refreshKnowledge()]);
    if (epoch === readEpoch.current) setLoading(false);
  }, [refreshKnowledge, refreshModelPolicy, refreshPolicy]);

  useEffect(() => {
    let disposed = false;
    queueMicrotask(() => {
      if (!disposed) void refresh();
    });
    const refreshVisible = () => {
      if (document.visibilityState === "visible") void refresh();
    };
    const timer = window.setInterval(refreshVisible, 30_000);
    window.addEventListener("focus", refreshVisible);
    document.addEventListener("visibilitychange", refreshVisible);
    return () => {
      disposed = true;
      readEpoch.current += 1;
      window.clearInterval(timer);
      window.removeEventListener("focus", refreshVisible);
      document.removeEventListener("visibilitychange", refreshVisible);
    };
  }, [refresh]);

  const assign = useCallback(async (patch: AdminRolePatch, undo: AdminRolePatch | null): Promise<boolean> => {
    const current = policyRef.current;
    if (!current) return false;
    setMutationBusy(true);
    const result = await updateAdminSystemModelPolicy({ expectedVersion: current.policy.version, ...patch });
    setMutationBusy(false);
    if (!result.ok) {
      reportError(adminSystemModelPolicyErrorMessage(result.error));
      if (result.error === "system_model_policy_stale") void refreshPolicy();
      return false;
    }
    setPolicy(result.data);
    if (undo) {
      reportNotice(ADMIN_ROLE_SAVED_NOTICE, {
        label: "Undo",
        onSelect: () => {
          void assignRef.current?.(undo, null);
        }
      });
    } else {
      reportNotice("Previous assignment restored for future work");
    }
    commit();
    return true;
  }, [commit, refreshPolicy, reportError, reportNotice, setMutationBusy, setPolicy]);
  useEffect(() => {
    assignRef.current = assign;
  }, [assign]);

  const check = useCallback(async (role: AdminSystemModelEligibilityRole, id: string): Promise<boolean> => {
    invalidateReads();
    actionPending.current = true;
    setChecking({ id, role });
    const result = await verifyAdminSystemModelRole(id, role);
    invalidateReads();
    actionPending.current = false;
    setChecking(null);
    if (!result.ok) {
      reportError(adminSystemModelPolicyErrorMessage(result.error));
      return false;
    }
    setPolicy(result.data);
    return true;
  }, [invalidateReads, reportError, setPolicy]);

  const checkAndAssign = useCallback(async (role: "memory" | "vision", id: string): Promise<boolean> => {
    const previous = policyRef.current?.policy;
    if (!previous || !await check(role, id)) return false;
    return role === "memory"
      ? assign(
          { providerModelId: id, reasoningEffort: null },
          { providerModelId: previous.systemModel?.id ?? null, reasoningEffort: previous.reasoningEffort }
        )
      : assign(
          { chatPdfProviderModelId: id, chatPdfReasoningEffort: null },
          {
            chatPdfProviderModelId: previous.chatPdfModel?.id ?? null,
            chatPdfReasoningEffort: previous.chatPdfReasoningEffort
          }
        );
  }, [assign, check]);

  const checkDocument = useCallback(async (mode: KnowledgeModelMode, id: string): Promise<boolean> => {
    if (!await check(mode === "system_model_vision" ? "vision" : "direct_pdf", id)) return false;
    await refreshKnowledge();
    const destinations = knowledgeRef.current?.profile.availablePdfDestinations ?? [];
    if (knowledgeDocumentDestinations(destinations, mode).some((item) => item.deploymentId === id)) {
      return true;
    }
    reportError("Checked, but Knowledge does not list this deployment yet. Try again in a moment.");
    return false;
  }, [check, refreshKnowledge, reportError]);

  const saveChatDefaults = useCallback(async (
    input: Omit<AdminModelPolicyUpdateInput, "expectedVersion">
  ): Promise<string | null> => {
    const current = modelPolicyRef.current;
    if (!current) return "Chat defaults are still loading.";
    setMutationBusy(true);
    const result = await updateAdminModelPolicy({ expectedVersion: current.policy.version, ...input });
    setMutationBusy(false);
    if (!result.ok) {
      if (result.error === "model_policy_stale") void refreshModelPolicy();
      return adminModelPolicyErrorMessage(result.error);
    }
    setModelPolicy(result.data);
    reportNotice("Chat defaults saved for new chats");
    commit();
    return null;
  }, [commit, refreshModelPolicy, reportNotice, setModelPolicy, setMutationBusy]);

  const settleKnowledge = useCallback((next: AdminKnowledgeSettings, verb: string) => {
    setKnowledge(next);
    reportNotice(`${verb}. ${knowledgeProcessingState(next.profile).label}`);
    commit();
  }, [commit, reportNotice, setKnowledge]);

  const applyKnowledge = useCallback(async (draft: AdminKnowledgeDraft): Promise<boolean> => {
    const current = knowledgeRef.current;
    if (!current) return false;
    setMutationBusy(true);
    const result = await activateAdminKnowledgeProfile({
      deploymentId: draft.embeddingDeploymentId,
      documentDeploymentId: draft.mode === "local" ? null : draft.documentDeploymentId,
      expectedVersion: current.profile.version,
      pdfProcessingMode: draft.mode
    });
    setMutationBusy(false);
    if (!result.ok) {
      reportError(adminKnowledgeErrorMessage(result.error));
      if (result.error === "knowledge_profile_stale") void refreshKnowledge();
      return false;
    }
    settleKnowledge(result.data, "Knowledge processing applied");
    return true;
  }, [refreshKnowledge, reportError, setMutationBusy, settleKnowledge]);

  const restoreKnowledge = useCallback(async (revisionId: string): Promise<boolean> => {
    const current = knowledgeRef.current;
    if (!current) return false;
    setMutationBusy(true);
    const result = await rollbackAdminKnowledgeProfile({ expectedVersion: current.profile.version, revisionId });
    setMutationBusy(false);
    if (!result.ok) {
      reportError(adminKnowledgeErrorMessage(result.error));
      if (result.error === "knowledge_profile_stale") void refreshKnowledge();
      return false;
    }
    settleKnowledge(result.data, "Earlier configuration restored");
    return true;
  }, [refreshKnowledge, reportError, setMutationBusy, settleKnowledge]);

  return useMemo(() => ({
    applyKnowledge,
    assign,
    busy,
    checkAndAssign,
    checkDocument,
    checking,
    error,
    knowledge,
    knowledgeError,
    knowledgeLoading,
    loading,
    modelPolicy,
    modelPolicyError,
    policy,
    refresh,
    restoreKnowledge,
    saveChatDefaults
  }), [
    applyKnowledge, assign, busy, checkAndAssign, checkDocument, checking, error, knowledge,
    knowledgeError, knowledgeLoading, loading, modelPolicy, modelPolicyError, policy, refresh,
    restoreKnowledge, saveChatDefaults
  ]);
}
