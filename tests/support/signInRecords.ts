import { captureRunObservation } from "./runObservation";

/** The sign-in fields of one record, for exact comparisons. */
export type SignInRecordSummary = {
  code: unknown;
  level: unknown;
  outcome: unknown;
  sign_in_method?: unknown;
  step: unknown;
};

/** The validated `sign_in` records `run` wrote, exactly as their log lines carry them. */
export async function captureSignInRecords(run: () => Promise<unknown>): Promise<Record<string, unknown>[]> {
  const observed = await captureRunObservation();
  try {
    await run();
    // Read before restoring: restoring the spy forgets its calls.
    return observed.records().filter((record) => record.event === "sign_in");
  } finally {
    observed.restore();
  }
}

/** Method, step, outcome, code and level of each `sign_in` record `run` wrote. */
export async function captureSignIns(run: () => Promise<unknown>): Promise<SignInRecordSummary[]> {
  return (await captureSignInRecords(run)).map((record) => ({
    code: record.code,
    level: record.level,
    outcome: record.outcome,
    ...(record.sign_in_method === undefined ? {} : { sign_in_method: record.sign_in_method }),
    step: record.step
  }));
}
