import { logEvent, type Subsystem } from "../observability";
import { databaseFailureCode } from "../observability/databaseFailure";
import type { ConnectorRunWait } from "./runAdmission";

/**
 * The sweep of a connector's deliveries a restart interrupted, or that this
 * process stopped following. They are found by the connector's run records
 * (`links`), each `pending` until one delivery claims it: the claim of a run
 * recorded before this process started that never settled may already have
 * reached the chat and settles `unknown`, never resent; a pending one is
 * followed for at most a minute per sweep and, once its run settled,
 * delivered once through the same claim the live path uses. A run this
 * process still follows (or has just admitted) is its observer's alone. A
 * record too old to matter settles `failed` without a message. The caller
 * runs one sweep at a time, so no claim of a delivery in progress here is
 * taken for an interrupted one.
 */

export const CONNECTOR_RECOVERY_BATCH = 500;
export const CONNECTOR_RECOVERY_CONCURRENCY = 4;
/** How often the deliveries left pending are swept again. */
export const CONNECTOR_RECOVERY_SWEEP_INTERVAL_MS = 60_000;
/** A sweep follows runs still going this long, then leaves them to the next sweep. */
export const CONNECTOR_RECOVERY_FOLLOW_MS = CONNECTOR_RECOVERY_SWEEP_INTERVAL_MS;
/** A run this process recorded stays its observer's at least this long, while its admission still hands it over. */
export const CONNECTOR_RECOVERY_GRACE_MS = CONNECTOR_RECOVERY_SWEEP_INTERVAL_MS;
/** An answer older than this is not delivered anymore; it stays in AIQSA. */
export const CONNECTOR_RECOVERY_MAX_AGE_MS = 24 * 3_600_000;

/** One run's delivery record, as much as the sweep reads of it. */
export type ConnectorRecoveryLink = Readonly<{ runId: string; userId: string; createdAt: Date }>;

export type ConnectorRecoveryDeps<Link extends ConnectorRecoveryLink> = Readonly<{
  /** Whether anything can be delivered now; while the connector is off the records wait for a later sweep. */
  available(): Promise<boolean>;
  links: Readonly<{
    /** Oldest records in one delivery state. */
    listByState(input: Readonly<{ limit: number; state: "pending" | "claimed" }>): Promise<readonly Link[]>;
    /** `pending` → `claimed`; true only for the one caller that may deliver. */
    claimDelivery(runId: string): Promise<boolean>;
    settle(input: Readonly<{ at: Date; runId: string; state: "failed" | "unknown" }>): Promise<void>;
  }>;
  waitForRun: ConnectorRunWait;
  /** Delivers a settled run once, through the live path's claim (and publishes that it did); `skipped` when another holds it. */
  deliver(link: Link): Promise<"delivered" | "failed" | "unknown" | "skipped">;
  /** Runs this process itself is following; recovery leaves them to it. */
  isLive(runId: string): boolean;
  now?: () => number;
  /** The connector's content-free log: its subsystem and codes (registered in `failureCodes.json`). */
  log: Readonly<{
    subsystem: Subsystem;
    /** A claimed delivery a restart interrupted, settled unknown. */
    unknown: string;
    /** A delivery that failed, or a record too old to deliver. */
    deliveryFailed: string;
    /** One record's recovery threw. */
    recoveryFailed: string;
  }>;
}>;

/** One sweep. */
export async function recoverConnectorDeliveries<Link extends ConnectorRecoveryLink>(
  deps: ConnectorRecoveryDeps<Link>, input: Readonly<{ startedAt: Date }>
): Promise<void> {
  const now = deps.now ?? Date.now;
  /** Content-free: run identity, stable codes and counts only. */
  const log = (fields: Readonly<{
    code?: string; count?: number; error?: unknown; outcome: "completed" | "failed" | "skipped" | "waiting"; runId?: string;
  }>) => logEvent("service_operation", {
    ...(fields.code ? { code: fields.code } : {}), ...(fields.count === undefined ? {} : { count: fields.count }),
    ...(fields.error ? { error: fields.error, prisma_code: databaseFailureCode(fields.error) } : {}),
    outcome: fields.outcome, ...(fields.runId ? { run_id: fields.runId } : {}), stage: "recovery", subsystem: deps.log.subsystem
  });
  // Nothing can be sent while the connector is off; the records wait for the sweep after it is back.
  if (!(await deps.available())) return;
  const startedAt = input.startedAt.getTime();
  const sweptAt = now();
  const before = (row: Link) => row.createdAt.getTime() < startedAt && !deps.isLive(row.runId);
  // Recorded here too: no longer followed by this process's observer (left pending, e.g. while the connector was off).
  const left = (row: Link) => !deps.isLive(row.runId) &&
    (row.createdAt.getTime() < startedAt || sweptAt - row.createdAt.getTime() >= CONNECTOR_RECOVERY_GRACE_MS);

  const claimed = (await deps.links.listByState({ limit: CONNECTOR_RECOVERY_BATCH, state: "claimed" })).filter(before);
  for (const row of claimed) {
    await deps.links.settle({ at: new Date(now()), runId: row.runId, state: "unknown" });
    log({ code: deps.log.unknown, outcome: "skipped", runId: row.runId });
  }

  const pending = (await deps.links.listByState({ limit: CONNECTOR_RECOVERY_BATCH, state: "pending" })).filter(left);
  if (pending.length > 0) log({ count: pending.length, outcome: "waiting" });
  const deadline = now() + CONNECTOR_RECOVERY_FOLLOW_MS;
  let next = 0;
  async function worker(): Promise<void> {
    while (next < pending.length) {
      const row = pending[next++]!;
      try {
        await recoverOne(row);
      } catch (error) {
        log({ code: deps.log.recoveryFailed, error, outcome: "failed", runId: row.runId });
      }
    }
  }

  async function recoverOne(row: Link): Promise<void> {
    if (now() - row.createdAt.getTime() > CONNECTOR_RECOVERY_MAX_AGE_MS) {
      if (await deps.links.claimDelivery(row.runId)) await deps.links.settle({ at: new Date(now()), runId: row.runId, state: "failed" });
      log({ code: deps.log.deliveryFailed, outcome: "skipped", runId: row.runId });
      return;
    }
    const settled = await deps.waitForRun({ deadline, runId: row.runId, userId: row.userId });
    if (!settled) {
      log({ outcome: "waiting", runId: row.runId });
      return;
    }
    const state = await deps.deliver(row);
    if (state !== "skipped") log({ code: state === "delivered" ? undefined : deps.log.deliveryFailed, outcome: "completed", runId: row.runId });
  }

  await Promise.all(Array.from({ length: Math.min(CONNECTOR_RECOVERY_CONCURRENCY, pending.length) }, () => worker()));
}
