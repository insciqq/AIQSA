/** Staged local writes must settle within this lease. Expired writers cannot
 * become canonical; retention may then collect their objects after a crash. */
export const ARTIFACT_WRITE_LEASE_MS = 15 * 60 * 1000;
