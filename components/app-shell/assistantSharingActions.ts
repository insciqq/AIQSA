import {
  fetchAssistantDetail,
  publishAssistant,
  requestAssistantListing,
  revokeAssistantPublication,
  setAssistantFeaturedOrder,
  withdrawAssistantListingRequest,
  type AssistantApiResult
} from "@/components/assistants/assistantsApi";
import type {
  AssistantResourceNames,
  AssistantSharingDraft,
  AssistantSharingFailure,
  AssistantSharingFailureTarget,
  AssistantSharingSheetView
} from "@/components/assistants/libraryViewContracts";
import { copyAssistantLink } from "@/components/app-shell/assistantGalleryActions";
import {
  nextAssistantSheetRequestId,
  useAssistantLibraryStore,
  type AssistantLibrarySnapshot,
  type AssistantSharingState
} from "@/components/app-shell/assistantLibraryStore";
import {
  assistantErrorText,
  draftBaseline,
  sharingDirty,
  type AssistantLibraryControllerInput,
  type AssistantLibraryCore
} from "@/components/app-shell/assistantLibraryCore";
import type { AssistantDetail } from "@/lib/contracts/assistants";

const store = () => useAssistantLibraryStore.getState();

function featuredCount(snapshot: AssistantLibrarySnapshot, assistantId: string): number {
  return (snapshot.data?.assistants ?? [])
    .filter((assistant) => assistant.featured && assistant.id !== assistantId).length;
}

function savedGroupIds(detail: AssistantDetail): string[] {
  return (detail.publications ?? [])
    .filter((publication) => publication.scope === "group" && publication.groupId)
    .map((publication) => publication.groupId!);
}

/** The audience the saved publications and listing request express. */
export function sharingDraftFromDetail(detail: AssistantDetail, otherFeatured: number): AssistantSharingDraft {
  const publications = detail.publications ?? [];
  const groupIds = savedGroupIds(detail);
  const request = detail.listingRequest?.request;
  const everyone = publications.some((publication) => publication.scope === "installation") ||
    detail.listingRequest?.listed === true ||
    (request?.state === "pending" && !request.outdated);
  return {
    audience: everyone ? "everyone" : groupIds.length > 0 ? "groups" : "owner",
    featured: detail.featured,
    featuredOrder: detail.featuredOrder ?? otherFeatured,
    groupIds
  };
}

function readyState(
  current: AssistantSharingState,
  detail: AssistantDetail,
  keepDraft: boolean
): AssistantSharingState {
  const baseline = sharingDraftFromDetail(detail, featuredCount(store(), detail.id));
  return {
    ...current,
    baseline: draftBaseline(baseline),
    detail,
    draft: keepDraft ? current.draft : baseline,
    error: null,
    state: "ready"
  };
}

async function loadSharing(assistantId: string) {
  const requestId = nextAssistantSheetRequestId();
  store().patch({
    sharing: {
      assistantId,
      baseline: "",
      detail: null,
      draft: { audience: "owner", featured: false, featuredOrder: 0, groupIds: [] },
      error: null,
      failures: [],
      requestId,
      saving: false,
      state: "loading",
      withdrawing: false
    }
  });
  const result = await fetchAssistantDetail(assistantId);
  const current = store().sharing;
  if (current?.requestId !== requestId) return;
  if (!result.ok || !result.data.owned) {
    store().patch({
      sharing: {
        ...current,
        error: result.ok ? "Only the owner can share this assistant." : result.message,
        state: "error"
      }
    });
    return;
  }
  store().patch({ sharing: readyState(current, result.data, false) });
}

type Step = {
  /** Gives access or sends a request; the others take access away. */
  gives: boolean;
  run(): Promise<AssistantApiResult<unknown>>;
  target: AssistantSharingFailureTarget;
};

function failureOf(
  target: AssistantSharingFailureTarget,
  result: Extract<AssistantApiResult<unknown>, { ok: false }>
): AssistantSharingFailure {
  return {
    code: result.code,
    skills: result.skills ?? [],
    target,
    text: assistantErrorText(result.code, result.message)
  };
}

export function createAssistantSharingActions(core: AssistantLibraryCore) {
  function openSharing(assistantId: string) {
    const sharing = store().sharing;
    if (sharing?.saving || sharing?.withdrawing) return;
    void loadSharing(assistantId);
  }

  function closeSharing() {
    const sharing = store().sharing;
    if (sharing?.saving || sharing?.withdrawing) return;
    store().patch({ sharing: null });
  }

  function retrySharing() {
    const sharing = store().sharing;
    if (sharing && !sharing.saving) void loadSharing(sharing.assistantId);
  }

  function changeSharing(update: Partial<AssistantSharingDraft>) {
    const sharing = store().sharing;
    if (!sharing || sharing.state !== "ready" || sharing.saving || sharing.withdrawing || !sharing.detail) return;
    // Group publications stay while listed for everyone; Only me revokes them all.
    const groups = update.audience === "everyone"
      ? { groupIds: savedGroupIds(sharing.detail) }
      : update.audience === "owner" ? { groupIds: [] } : {};
    store().patch({ sharing: { ...sharing, draft: { ...sharing.draft, ...update, ...groups }, failures: [] } });
  }

  /**
   * The calls that turn the saved audience into the draft: first every call
   * that gives access or sends a request, then every call that takes access
   * away. Group publications stay while the Assistant is listed for
   * everyone; leaving Everyone revokes the installation publication and
   * withdraws a pending request. Featured is set after listing, by
   * administrators only.
   */
  function sharingSteps(detail: AssistantDetail, draft: AssistantSharingDraft, isAdministrator: boolean): Step[] {
    const assistantId = detail.id;
    const publications = detail.publications ?? [];
    const installation = publications.find((publication) => publication.scope === "installation");
    const groupPublications = publications.filter((publication) => publication.scope === "group");
    const wanted = new Set(
      draft.audience === "groups"
        ? draft.groupIds
        : draft.audience === "everyone"
          ? groupPublications.map((publication) => publication.groupId!)
          : []
    );
    const giving: Step[] = [];
    const taking: Step[] = [];
    for (const groupId of wanted) {
      if (!groupPublications.some((publication) => publication.groupId === groupId)) {
        giving.push({
          gives: true,
          run: () => publishAssistant(assistantId, { groupId, scope: "group" }),
          target: { groupId, kind: "group" }
        });
      }
    }
    for (const publication of groupPublications) {
      if (!wanted.has(publication.groupId!)) {
        taking.push({
          gives: false,
          run: () => revokeAssistantPublication(assistantId, publication.id),
          target: { groupId: publication.groupId!, kind: "group" }
        });
      }
    }
    const listing = detail.listingRequest ?? null;
    const request = listing?.request ?? null;
    const pending = request?.state === "pending";
    if (draft.audience === "everyone") {
      if (!installation && isAdministrator) {
        giving.push({
          gives: true,
          run: () => publishAssistant(assistantId, { scope: "installation" }),
          target: { kind: "everyone" }
        });
      } else if (
        !installation && listing && !listing.listed && listing.canRequest &&
        !(pending && !request?.outdated) && detail.version !== undefined
      ) {
        const version = detail.version;
        giving.push({ gives: true, run: () => requestAssistantListing(assistantId, version), target: { kind: "everyone" } });
      }
      if (isAdministrator) {
        const wantedOrder = draft.featured ? draft.featuredOrder : null;
        const savedOrder = detail.featured ? detail.featuredOrder ?? null : null;
        if (wantedOrder !== savedOrder) {
          // Turning Featured off takes; turning it on or moving it takes nothing away.
          (wantedOrder === null ? taking : giving).push({
            gives: wantedOrder !== null,
            run: () => setAssistantFeaturedOrder(assistantId, wantedOrder),
            target: { kind: "featured" }
          });
        }
      }
    } else {
      if (installation) {
        taking.push({
          gives: false,
          run: () => revokeAssistantPublication(assistantId, installation.id),
          target: { kind: "everyone" }
        });
      }
      // Only a request the saved audience expresses: an outdated one stays until withdrawn.
      if (request?.state === "pending" && !request.outdated && listing?.canWithdraw) {
        taking.push({
          gives: false,
          run: () => withdrawAssistantListingRequest(assistantId, request.id),
          target: { kind: "everyone" }
        });
      }
    }
    return [...giving, ...taking];
  }

  /**
   * Applies every change as one user action. Nothing is taken away unless
   * everything given succeeded, so a failed replacement never leaves people
   * without the access it was meant to replace. Applied changes stay
   * applied; what failed is reported at the group or option that caused it,
   * with the names of blocking Skills, and the sheet stays open.
   */
  async function saveSharing(): Promise<boolean> {
    const sharing = store().sharing;
    if (!sharing || sharing.state !== "ready" || sharing.saving || !sharing.detail) return false;
    const requestId = nextAssistantSheetRequestId();
    store().patch({ sharing: { ...sharing, error: null, failures: [], requestId, saving: true } });
    const isAdministrator = store().data?.viewer.canPublishInstallation ?? false;
    const failures: AssistantSharingFailure[] = [];
    let givingFailed = false;
    for (const step of sharingSteps(sharing.detail, sharing.draft, isAdministrator)) {
      if (!step.gives && givingFailed) break;
      // Featured needs the listing: after a failed listing it stays unapplied, reported at Everyone.
      if (step.target.kind === "featured" && failures.some((failure) => failure.target.kind === "everyone")) continue;
      const result = await step.run();
      if (store().sharing?.requestId !== requestId) return false;
      if (!result.ok) {
        failures.push(failureOf(step.target, result));
        if (step.gives) givingFailed = true;
      }
    }
    // The list is current before the sheet closes, so a card that moved to
    // another group is already rendered anew when focus returns to it.
    const [detail] = await Promise.all([fetchAssistantDetail(sharing.assistantId), core.refreshList()]);
    const current = store().sharing;
    if (current?.requestId !== requestId) return false;
    // The detail sheet under the Sharing sheet shows the new audience too.
    const detailSheet = store().detail;
    if (detail.ok && detail.data.owned && detailSheet?.assistantId === sharing.assistantId && detailSheet.detail) {
      store().patch({ detail: { ...detailSheet, detail: detail.data } });
    }
    if (failures.length === 0 && detail.ok) {
      store().patch({ notice: { kind: "success", text: "Sharing updated." }, sharing: null });
      return true;
    }
    store().patch({
      sharing: detail.ok && detail.data.owned
        ? { ...readyState(current, detail.data, true), failures, saving: false }
        : { ...current, error: detail.ok ? null : detail.message, failures, saving: false }
    });
    return false;
  }

  async function withdrawListingRequest() {
    const sharing = store().sharing;
    const request = sharing?.detail?.listingRequest?.request;
    if (!sharing?.detail || sharing.saving || sharing.withdrawing || !request ||
      !sharing.detail.listingRequest?.canWithdraw) return;
    const requestId = nextAssistantSheetRequestId();
    store().patch({ sharing: { ...sharing, error: null, failures: [], requestId, withdrawing: true } });
    const result = await withdrawAssistantListingRequest(sharing.assistantId, request.id);
    const current = store().sharing;
    if (current?.requestId !== requestId || !current.detail) return;
    if (!result.ok) {
      // Reported at the Everyone option, where Withdraw is.
      store().patch({
        sharing: { ...current, failures: [failureOf({ kind: "everyone" }, result)], withdrawing: false }
      });
      return;
    }
    const wasClean = !sharingDirty(store());
    const next = readyState(current, { ...current.detail, listingRequest: result.data }, !wasClean);
    store().patch({ sharing: { ...next, withdrawing: false } });
    void core.refreshList();
  }

  return {
    changeSharing,
    closeSharing,
    openSharing,
    retrySharing,
    saveSharing,
    withdrawListingRequest
  };
}

export type AssistantSharingActions = ReturnType<typeof createAssistantSharingActions>;

/** The owner's own catalogs: an id outside them is counted, never named. */
function ownerResourceNames(
  input: Pick<AssistantLibraryControllerInput, "catalog" | "knowledgeBases" | "knowledgeSources">,
  snapshot: AssistantLibrarySnapshot
): AssistantResourceNames {
  return {
    knowledgeBases: input.knowledgeBases,
    knowledgeSources: input.knowledgeSources,
    mcpServers: snapshot.mcpOptions,
    models: (input.catalog?.models ?? []).map((model) => ({ id: model.modelId, label: model.displayName })),
    searchOptions: (input.catalog?.searchStrategies ?? [])
      .filter((strategy) => strategy.kind !== "none")
      .map((strategy) => ({ id: strategy.strategyId, label: strategy.displayName }))
  };
}

export function buildAssistantSharingSheetView(
  input: Pick<AssistantLibraryControllerInput, "catalog" | "knowledgeBases" | "knowledgeSources">,
  actions: AssistantSharingActions,
  snapshot: AssistantLibrarySnapshot
): AssistantSharingSheetView | null {
  const sharing = snapshot.sharing;
  if (!sharing) return null;
  const assistantId = sharing.assistantId;
  return {
    assistantId,
    detail: sharing.detail,
    dirty: sharingDirty(snapshot),
    draft: sharing.draft,
    error: sharing.error,
    failures: sharing.failures,
    featuredCount: featuredCount(snapshot, assistantId),
    groups: snapshot.data?.publishableGroups ?? [],
    isAdministrator: snapshot.data?.viewer.canPublishInstallation ?? false,
    listing: sharing.detail?.listingRequest ?? null,
    name: sharing.detail?.content.name ??
      snapshot.data?.assistants.find((assistant) => assistant.id === assistantId)?.name ?? null,
    names: ownerResourceNames(input, snapshot),
    onChange: actions.changeSharing,
    onClose: actions.closeSharing,
    onCopyLink: () => copyAssistantLink(assistantId),
    onRetry: actions.retrySharing,
    onSave: actions.saveSharing,
    onWithdrawRequest() {
      void actions.withdrawListingRequest();
    },
    saving: sharing.saving,
    state: sharing.state,
    withdrawing: sharing.withdrawing
  };
}
