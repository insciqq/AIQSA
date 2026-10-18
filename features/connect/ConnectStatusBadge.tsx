import type { ConnectSessionStatus } from "@/lib/contracts/connect";
import { CONNECT_STATUS_LABELS } from "./connectText";

/** A session's status; only "Needs approval" carries the accent. */
export function ConnectStatusBadge({ status }: Readonly<{ status: ConnectSessionStatus }>) {
  return (
    <span className="v2-connect-status" data-status={status} data-testid="connect-status-badge">
      {CONNECT_STATUS_LABELS[status]}
    </span>
  );
}
