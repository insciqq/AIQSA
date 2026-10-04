import {
  SCHEDULED_TASK_SOURCE_NAME_MAX_LENGTH,
  SCHEDULED_TASK_SOURCE_REASONS,
  SCHEDULED_TASK_UNAVAILABLE_SOURCES_LIMIT,
  type ScheduledTaskUnavailableSource
} from "../../contracts/scheduledTasks";
import type { McpCatalogOmission } from "../mcp/runPlan";
import type { ScheduledUnavailableSource } from "../runs/runRepositoryContract";

/**
 * Source health of scheduled runs, free of I/O. A run is incomplete when its
 * Auto plan left out a personal MCP server the task relies on: one its
 * previous shown result called, or any server before a first result. An
 * incomplete result cannot call the missing server, so a server the previous
 * result relied on but missed stays relevant while it is missing; a server
 * counted only because there was no previous result is not carried, so an
 * unrelated unavailable server degrades at most a task's first result. The
 * fact is frozen at admission on the run's occurrence; the run itself still
 * answers, told which source is missing.
 */

const SOURCE_REASONS: readonly unknown[] = SCHEDULED_TASK_SOURCE_REASONS;
const ID = /^[A-Za-z0-9_-]{1,128}$/u;

/** A display name as recorded: control characters become spaces, the result is trimmed and bounded. */
export function scheduledSourceName(value: string): string {
  const name = value.replace(/[\u0000-\u001f\u007f]+/gu, " ").replace(/\s+/gu, " ").trim();
  const characters = [...name];
  if (characters.length === 0) return "MCP server";
  return characters.length > SCHEDULED_TASK_SOURCE_NAME_MAX_LENGTH
    ? `${characters.slice(0, SCHEDULED_TASK_SOURCE_NAME_MAX_LENGTH - 1).join("")}…`
    : name;
}

/** The omitted servers this run depends on; null relevance means every one (no previous result). */
export function scheduledUnavailableSources(
  omitted: readonly McpCatalogOmission[],
  relevantServerIds: readonly string[] | null
): ScheduledUnavailableSource[] {
  const relevant = relevantServerIds ? new Set(relevantServerIds) : null;
  return omitted
    .filter((omission) => !relevant || relevant.has(omission.serverId))
    .slice(0, SCHEDULED_TASK_UNAVAILABLE_SOURCES_LIMIT)
    .map((omission) => ({
      name: scheduledSourceName(omission.serverName), reason: omission.reason, relied: relevant !== null, serverId: omission.serverId
    }));
}

/**
 * The run instruction that names the missing sources, so the answer neither
 * guesses their data nor hides the gap. Names are the owner's display names,
 * quoted as data.
 */
export function scheduledUnavailableSourcesNotice(sources: readonly ScheduledUnavailableSource[]): string | null {
  if (sources.length === 0) return null;
  const listed = sources.map((source) => `${JSON.stringify(source.name)} (${source.reason === "mcp_reauthorization_required"
    ? "needs the user to sign in again" : "unavailable"})`).join(", ");
  return `This scheduled run cannot use some of the user's tool sources, so their tools are missing: ${listed}. ` +
    "Do not guess what those tools would return. Answer with what you can check, and say briefly which parts could not be " +
    "checked because a source was unavailable.";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** The occurrence column as stored; anything malformed reads as no recorded gap. */
export function decodeStoredUnavailableSources(value: unknown): ScheduledUnavailableSource[] {
  if (!Array.isArray(value) || value.length > SCHEDULED_TASK_UNAVAILABLE_SOURCES_LIMIT) return [];
  return value.flatMap((entry) => isRecord(entry) && typeof entry.name === "string" && SOURCE_REASONS.includes(entry.reason) &&
    typeof entry.serverId === "string" && ID.test(entry.serverId) && typeof entry.relied === "boolean"
    ? [{
      name: scheduledSourceName(entry.name), reason: entry.reason as ScheduledUnavailableSource["reason"], relied: entry.relied,
      serverId: entry.serverId
    }]
    : []);
}

/** What the owner sees: names and reasons, never server identifiers. */
export function unavailableSourcesWire(value: unknown): ScheduledTaskUnavailableSource[] {
  return decodeStoredUnavailableSources(value).map(({ name, reason }) => ({ name, reason }));
}

/** A settled run is incomplete when its admission recorded a missing relevant source. */
export function occurrenceSourcesIncomplete(unavailableSources: unknown): boolean {
  return decodeStoredUnavailableSources(unavailableSources).length > 0;
}

/**
 * A settled monitoring check could not check: its admission missed a source
 * the previous shown result relied on. Sources recorded only because there was
 * no previous result to judge by still make the run incomplete, but not the
 * check: such a check can become the first result that relevance is judged by,
 * so an unrelated unavailable server never keeps a monitoring task from its
 * baseline, nor pauses it.
 */
export function occurrenceCheckSourcesMissing(unavailableSources: unknown): boolean {
  return decodeStoredUnavailableSources(unavailableSources).some((source) => source.relied);
}
