import type { AdminAttentionItem } from "../../../contracts/adminAttention";
import { adminHealthQueueCopy } from "../../../contracts/adminHealthQueues";
import type { AdminHealthQueueFinding } from "../health/queues";

function plural(count: number, singular: string, pluralForm = `${singular}s`): string {
  return `${count} ${count === 1 ? singular : pluralForm}`;
}

/** A coarse human age: minutes under two hours, hours under two days, then days. */
export function queueAgeCopy(seconds: number): string {
  const minutes = Math.floor(seconds / 60);
  if (minutes < 120) return plural(Math.max(1, minutes), "minute");
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return plural(hours, "hour");
  return plural(Math.floor(hours / 24), "day");
}

/** One warning per stalled background queue that no other alert watches; it clears once the queue moves again. */
export function queueAttentionItems(findings: readonly AdminHealthQueueFinding[]): AdminAttentionItem[] {
  return findings.map((finding) => {
    const unfinished = finding.waiting + finding.running;
    return {
      action: "Open Health",
      code: "queue_stalled",
      count: unfinished,
      detail: `${adminHealthQueueCopy[finding.queue].label} · ${plural(unfinished, "job")} not finished, the oldest due ${queueAgeCopy(finding.oldestSeconds)} ago — check that its worker is running`,
      id: `queue_stalled:${finding.queue}`,
      severity: "warn",
      target: { section: "health" },
      title: "A background queue is stalled"
    };
  });
}
