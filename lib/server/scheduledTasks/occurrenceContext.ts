import { SCHEDULED_TASK_TITLE_MAX_LENGTH } from "../../contracts/scheduledTasks";
import type { ScheduledOccurrenceFacts } from "../runs/runRepositoryContract";

/**
 * The turn context of a scheduled, manual or webhook occurrence: server facts
 * frozen at admission (`prompt.turnGuidance`), free of I/O. A saved prompt
 * often names its own schedule ("every weekday at 08:55, …"), and a run that
 * did not know it already is that automation told the owner to set one up; a
 * run that did not know when its previous result was made re-read a whole
 * mailbox every hour and repeated what it had already reported (production
 * audit 2026-11-11). The title is the owner's text, quoted as data and
 * bounded; the schedule words are the server's.
 */

const SCHEDULE_MAX_CHARACTERS = 200;

/** One line, control characters removed, at most `max` characters. */
function bounded(value: string, max: number): string {
  const line = value.replace(/[\u0000-\u001f\u007f]+/gu, " ").replace(/\s+/gu, " ").trim();
  const characters = Array.from(line);
  return characters.length > max ? `${characters.slice(0, max - 1).join("").trimEnd()}…` : line;
}

/** "Tuesday 2026-11-10 08:55 (Europe/Moscow)"; an instant the zone cannot read stays in UTC. */
export function scheduledOccurrenceTime(iso: string, timeZone: string): string | null {
  const instant = new Date(iso);
  if (Number.isNaN(instant.getTime())) return null;
  const render = (zone: string) => {
    const parts = Object.fromEntries(new Intl.DateTimeFormat("en-US", {
      day: "2-digit", hour: "2-digit", hourCycle: "h23", minute: "2-digit", month: "2-digit", timeZone: zone, weekday: "long",
      year: "numeric"
    }).formatToParts(instant).map((part) => [part.type, part.value]));
    return `${parts.weekday} ${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute} (${zone})`;
  };
  try {
    return render(timeZone);
  } catch {
    return render("UTC");
  }
}

const STARTED_BY: Readonly<Record<ScheduledOccurrenceFacts["trigger"], string>> = {
  manual: "by the user with Run now",
  schedule: "by its schedule",
  webhook: "by an event its webhook received, which follows the instruction as incoming data"
};

/** The occurrence's facts as its run reads them; null without facts (an interactive turn never has them). */
export function scheduledOccurrenceContext(
  facts: ScheduledOccurrenceFacts | undefined,
  options: Readonly<{ previousResultInContext: boolean }>
): string | null {
  if (!facts) return null;
  const zone = bounded(facts.timeZone, 64) || "UTC";
  const schedule = facts.schedule === null
    ? "It has no schedule and runs only on its webhook."
    : `Its schedule: ${bounded(facts.schedule, SCHEDULE_MAX_CHARACTERS)}, time zone ${zone}.`;
  const lines = [
    `This turn is a run of the user's automation ${JSON.stringify(bounded(facts.title, SCHEDULED_TASK_TITLE_MAX_LENGTH))}, ` +
      `started ${STARTED_BY[facts.trigger]}. ${schedule} The automation and its schedule already exist, and this run cannot ` +
      "create, change or pause them: never tell the user to set up a schedule or an automation for this instruction; the user " +
      "manages it in Automations."
  ];
  const previous = facts.previousResultAt === null ? null : scheduledOccurrenceTime(facts.previousResultAt, zone);
  if (previous === null) {
    lines.push("There is no earlier result of this automation to compare with.");
  } else {
    lines.push(`The previous result of this automation the user saw came from its run started ${previous}` +
      `${options.previousResultInContext ? "; it is the answer above" : ""}. Unless the instruction asks for a full report ` +
      "every time, look in sources that keep growing (mail, trackers, feeds) only at what arrived or changed since then, " +
      "and report only what is new.");
  }
  return lines.join("\n");
}
