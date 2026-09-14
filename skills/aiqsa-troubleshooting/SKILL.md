---
name: aiqsa-troubleshooting
description: Diagnose an AIQSA installation using bounded application logs and process state. Use for failed or stuck runs, Stop and timeout questions, provider/tool errors, background jobs, startup failures, and preparing a sanitized bug report. Collect existing evidence without changing the installation.
---

# AIQSA troubleshooting

Read this file directly in Claude Code or Codex; it needs no plugin, registration, or helper service.

## Establish the incident

Identify the AIQSA version, affected role/service, deployment type, failure time and time zone, and any available `trace_id`, `run_id`, or `job_id`. A failure before admission may have no run ID. Use the release/image tag or `app_version` in logs; do not request credentials or `.env`.

Work from the installation directory with its existing Compose project, files, and profiles. Ordinary `docker compose` preserves its configured selection. An explicit `-f` replaces that file selection: use `docker compose -f docker-compose.dev.yml ...` only for an installation actually using that development topology. For custom deployments, retain all of the operator's selected flags. Do not print resolved Compose configuration or environment snapshots.

## Collect a bounded window

Choose the affected service; `app` is the starting point for HTTP/run incidents. Check `docker compose logs --help` if the installed CLI does not recognize a flag. Capture both stdout and stderr, including process startup and lines before the failure:

```sh
umask 077
aiqsa_diag_log=$(mktemp "${TMPDIR:-/tmp}/aiqsa-diagnostics.XXXXXX")
docker compose logs --since 30m --tail 2000 --no-color --no-log-prefix app >"$aiqsa_diag_log" 2>&1
```

Adjust the time window to the incident; add `--until` for a closed historical window. Fetch another relevant worker's bounded window when a job crosses services. Rotation, the tail limit, or container replacement can leave gaps; log volume does not promise a number of retained days. Keep captures private and review them before quoting or attaching anything.

First inspect startup/restart and process failures in the whole captured window. They can lack `trace_id`. Next/npm/crash lines are mixed with JSON and may carry the only process evidence. Do not discard them because JSON parsing fails.

For an exact available ID, use literal text search; `jq` is optional:

```sh
aiqsa_diag_id='replace-with-an-available-trace-run-or-job-id'
grep -F -- "$aiqsa_diag_id" "$aiqsa_diag_log"
```

For a compact JSON overview, parse individual lines and select objects and fields:

```sh
jq -R 'fromjson? | select(type == "object") | select(.event | type == "string")
  | {timestamp, level, event, app_version, role, instance_id,
     trace_id, run_id, job_id, tool_call_id, execution_index,
     subsystem, stage, outcome, status, httpStatus, code, prisma_code,
     abort_source, effective_timeout_ms, bytes, chunks, action, retry_at, repeat_count}
  | with_entries(select(.value != null))' "$aiqsa_diag_log"
```

This overview omits fields and non-JSON lines; keep the original window for investigation. Inspect the selected original records for other deadlines, transport progress, provider identity, and tool/attempt ordinals. Field selection does not sanitize arbitrary third-party values. Never assume every JSON line is an AIQSA event; use the installed version's [event definitions](../../lib/server/observability/events.ts) when interpreting unfamiliar fields.

## Reconstruct what happened

Follow HTTP → accepted run/job → tool/provider or processing stages → operation outcome → persistence. State the outcome of each layer separately:

- `trace_id` groups one context. Follow server-owned `run_id` or `job_id` across requests, claims and restarts. A Stop request has its own trace; nested abort observations retain the cancelled call's context. Restart/recovery can have a new `instance_id` and trace for the same job. Use tool-call IDs, execution/engine/operation ordinals and attempts when calls overlap.
- `process.started` is a process summary, not readiness. `starting`, `unknown`, `disabled`, and `failed` are different states. Read `readiness.changed` separately. `process.failure` with `framework_managed` does not prove process exit; inspect container state when needed.
- HTTP 200, successful headers, or absence of ERROR does not prove a successful run. Compare operation/result codes with `run_execution`, tool/job outcomes and the relevant persistence event. A transport stream marked `cancelled` can mean the consumer closed its reader after a terminal provider frame; check the run's outcome before calling it a failed answer.
- For cancellation, identify the first observed `nested_abort` source at the relevant layer and the deadlines that actually applied there. A configured deadline is not proof that it fired. `parent_signal` alone does not identify Stop; correlate its run with Stop admission/delivery. A pre-aborted signal with `unknown` source supplies neither a cause nor an elapsed duration. A later timer must not replace earlier cancellation evidence.
- Separate failures before headers, HTTP rejection, body/stream read failure and parse failure. Use observed status, bytes/chunks and progress only when present. Missing status or counters mean unavailable evidence, not zero bytes or proof of an upstream outage. Use the recorded provider identity rather than guessing from an error label.
- Read retry/degradation decisions separately from processing failure. Only `confirmed` persistence proves that specific guarded write; `not_applied` and `unconfirmed` do not. A retry decision without confirmed scheduling and `retry_at` does not establish when it will run. `prepare`/enqueue confirmation is not completion of cleanup or processing.
- Repeated subsystem failures may be suppressed; read `repeat_count` and `subsystem.recovered`. Recovery does not establish completion of every job or health of other processes. Idle polls and healthy heartbeats intentionally stay quiet. `logging.dropped_records` reports lost output; its absence does not prove the capture is complete.

## If there is no terminal record

SIGKILL/OOM can prevent application failure or terminal logs. Include stopped containers and inspect only selected state fields, using the same Compose selection and affected service:

```sh
for aiqsa_diag_container in $(docker compose ps -a -q app); do
  docker inspect --format 'status={{.State.Status}} oom_killed={{.State.OOMKilled}} exit_code={{.State.ExitCode}} restarts={{.RestartCount}} started_at={{.State.StartedAt}} finished_at={{.State.FinishedAt}}' "$aiqsa_diag_container"
done
```

Do not request full `docker inspect`: it contains `Config.Env`. `OOMKilled`, exit status and restart count describe available container state, not complete history after recreation. Exit 137 alone does not prove OOM; a false OOM flag or zero restarts does not rule out an external kill. With missing history, report the cause and persistence outcome as unconfirmed.

## Bound the investigation and report

Collect existing evidence only. Do not restart/recreate services, retry jobs, change settings, migrate/seed, repair integrity, reindex, delete data, or repeat a paid provider call to reproduce the incident. Keep a proposed fix separate from diagnosis; this Skill grants no additional authority.

Use the database only for a specific missing durable fact after logs/process evidence. Consult the relevant storage owner/schema and use a bounded read-only query with owner scope. Do not mutate SQL or dump tables, content, payloads, or raw histories.

Return a short sanitized report: version and role, time window/time zone, available diagnostic IDs, observed sequence and result codes, confirmed persistence or its uncertainty, known cause versus hypotheses, and the next read-only step. Preserve uncertainty when evidence ends at a boundary.

Before sharing any output, remove credentials/tokens, environment values, user text, documents, provider/tool bodies, custom endpoints, share URLs, and raw exception messages/stacks. Safe AIQSA records do not make arbitrary third-party logs safe to publish. Post an issue or send the report to others only when explicitly requested.
