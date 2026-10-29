import { prisma } from "../../prisma";
import { logEvent } from "../../observability";
import { registerSubagentCallbackFlushListener } from "../../push/runTerminalSignal";
import type { SubagentChatScope, SubagentRunner, WorkspaceAttachments } from "../../subagents/ports";
import { usageLimitsRepository } from "../../usageLimits/defaultRepository";
import { activeRunControllerRegistry } from "../activeRunControllerRegistry";
import type { RunHandlerDeps } from "../handlers";
import { createSubagentCallbacks, type SubagentCallbacks } from "./callbacks";
import { createSubagentBackgroundControl, type SubagentBackgroundOperations } from "./control";
import { reconcileSubagentRuns, type SubagentDeferredCallbacks } from "./recovery";
import { createPrismaSubagentBackgroundStore, type SubagentBackgroundStore } from "./store";
import { createSubagentWakeUpAdmitter, type SubagentWakeUpSend } from "./wakeUp";

/**
 * The installation's background sub-agents: one store, one callback sink
 * with its coalescing, the control the engine's `call_subagent` and
 * `stop_subagent` handlers use, and recovery (the routes build their views). Until
 * the integration wires the engine's runner (`configureSubagentBackground`),
 * background mode is unavailable (a visible refusal), while stops, recovery,
 * callbacks and views work. Process-global like the run registry, because
 * routes run in several bundles.
 */

/** The stale window of the main agent's recovery (`NATIVE_RUN_STALE_MS`), kept here so this module loads without the engine. */
const STALE_MS = 10 * 60_000;

type Composition = Readonly<{
  callbacks: SubagentCallbacks;
  control: SubagentBackgroundOperations;
  /** Ends this scope's orphaned background runs interrupted (`reconcileSubagentRuns`). */
  reconcile(input?: Readonly<{ chatId?: string; userId?: string }>): Promise<number>;
  /** Stops the background sub-agents under a message the caller owns, before its subtree is deleted. */
  stopUnderMessage(input: Readonly<{ messageId: string; userId: string }>): Promise<number>;
  store: SubagentBackgroundStore;
}>;

type Wiring = { runner: SubagentRunner | null; workspace?: WorkspaceAttachments };

const STATE = Symbol.for("aiqsa.subagent-background.v1");
type State = { composition: Composition | null; deferred: SubagentDeferredCallbacks; wiring: Wiring };
const globalState = globalThis as typeof globalThis & { [STATE]?: State };
const state = globalState[STATE] ??= { composition: null, deferred: new Map(), wiring: { runner: null } };

function processBootedAt(): Date {
  return new Date(Date.now() - Math.round(process.uptime() * 1_000));
}

let sendDeps: Omit<RunHandlerDeps, "resolveAuth" | "scheduledOccurrence"> | undefined;

/** The ordinary send handler as the wake-up turn's owner, imported on first use so recovery does not load the routes' defaults. */
const defaultWakeUpSend: SubagentWakeUpSend = async ({ body, chatId, resolveAuth, wakeUp }) => {
  const [{ createDefaultSendMessageDeps }, { createSendMessageHandler }] = await Promise.all([
    import("../defaultSendMessageDeps"), import("../handlers")
  ]);
  sendDeps ??= createDefaultSendMessageDeps();
  return createSendMessageHandler({ ...sendDeps, resolveAuth, subagentWakeUp: wakeUp })(
    new Request(`http://localhost/api/chats/${encodeURIComponent(chatId)}/messages`, {
      body: JSON.stringify(body), headers: { "content-type": "application/json" }, method: "POST"
    }), { params: { chatId } });
};

function compose(): Composition {
  const store = createPrismaSubagentBackgroundStore(prisma);
  const callbacks = createSubagentCallbacks({ admitWakeUp: createSubagentWakeUpAdmitter({ client: prisma, send: defaultWakeUpSend }),
    store });
  const control = createSubagentBackgroundControl({ callbacks: callbacks.sink, runner: state.wiring.runner, store,
    usageLimits: usageLimitsRepository, ...(state.wiring.workspace ? { workspace: state.wiring.workspace } : {}) });
  // A main-agent run that completed or failed, or was just admitted, delivers its chat's owed callbacks.
  registerSubagentCallbackFlushListener((runId) => {
    void store.mainRunScope(runId).then((scope: SubagentChatScope | null) => {
      if (scope) callbacks.mainRunEnded(scope);
    }).catch((error: unknown) => logEvent("run_recovery", { action: "retry", code: "subagent_callback_flush_failed", error,
      outcome: "failed", run_id: runId, stage: "recovery", subsystem: "run_recovery" }));
  });
  return Object.freeze({
    callbacks,
    control,
    reconcile: (input = {}) => reconcileSubagentRuns({ bootedAt: processBootedAt(), deferred: state.deferred, flush: callbacks.flush,
      liveRunIds: () => activeRunControllerRegistry.ids(), staleMs: STALE_MS, store,
      ...(state.wiring.workspace ? { workspace: state.wiring.workspace } : {}) }, input),
    async stopUnderMessage({ messageId, userId }) {
      const message = await prisma.message.findFirst({ select: { chatId: true }, where: { chat: { userId }, id: messageId } });
      return message ? control.stopUnderMessage({ chatId: message.chatId, messageId, userId }) : 0;
    },
    store
  });
}

export function getDefaultSubagentBackground(): Composition {
  return state.composition ??= compose();
}

/**
 * Wires the engine's sub-agent runner and the shared Workspace's attachments
 * (`20261029223932601-sub-agents-integration`); background mode opens with it.
 */
export function configureSubagentBackground(wiring: Readonly<{ runner: SubagentRunner; workspace?: WorkspaceAttachments }>): void {
  state.wiring = { runner: wiring.runner, ...(wiring.workspace ? { workspace: wiring.workspace } : {}) };
  state.composition = compose();
}
