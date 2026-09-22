import { Fragment } from "react";
import type { RunFollowup } from "@/lib/contracts/runFollowups";
import { ConversationTurnV2 } from "./ConversationV2";

export function RunFollowupHistoryV2({ entries, waitingForStep }: Readonly<{
  entries: readonly RunFollowup[];
  waitingForStep?: boolean;
}>) {
  if (!entries.length) return null;
  return <div className="v2-followup-history" aria-label="Follow-ups">
    {entries.map(entry => <Fragment key={entry.id}>
      {entry.precedingText ? <ConversationTurnV2 role="assistant" content={entry.precedingText}
        beforeContent={<p className="v2-followup-label">Partial answer before follow-up</p>} /> : null}
      <ConversationTurnV2 role="user" content={entry.text} anchorId={`followup-${entry.id}`}
        beforeContent={<p className="v2-followup-label">{entry.author ? `${entry.author} · ` : ""}Follow-up {entry.ordinal}</p>}
        afterContent={<p className="v2-followup-label" role="status" title={entry.delivery === "delivered"
          ? "Passed to the running task. The answer may still need checking." : undefined}>
          {entry.delivery === "delivered" ? "Delivered to the task" : entry.delivery === "accepted"
            ? waitingForStep ? "Accepted · waiting for the current step" : "Accepted · waiting for delivery"
            : "Not delivered · task ended"}
        </p>} />
    </Fragment>)}
  </div>;
}
