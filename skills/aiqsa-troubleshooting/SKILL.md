---
name: aiqsa-troubleshooting
description: Diagnose an AIQSA installation from its read-only health telemetry, then bounded logs and process state. Use for failed or stuck runs, errors users hit, sign-in failures, timeouts, provider/tool errors, background jobs, startup failures, slow answers, users' problem reports, and preparing a sanitized summary. Collect existing evidence without changing the installation.
---

# AIQSA troubleshooting

Read this file directly in Claude Code or Codex; it needs no plugin, registration, or helper service. Work from the installation directory, with its existing `.env` and Compose selection; never print `.env` or resolved Compose configuration.

## 1. Identify the installation

Note `./aiqsa.sh version`, the deployment type, the affected role/service, the time window and time zone, and any error reference a user reported (the first 8 or more characters of a run id). A failure before admission may have no run. Do not request credentials or `.env` values.

## 2. Read the health report first

The persisted telemetry keeps 30 days of counters and incidents and works while the app container is down. Start with the complete agent report of the period since the last visit, kept in a private file:

```sh
umask 077
aiqsa_diag_dir=$(mktemp -d "${TMPDIR:-/tmp}/aiqsa-diagnostics.XXXXXX")
./aiqsa.sh health --full --since 14d --json >"$aiqsa_diag_dir/health-full.json"
```

`--full` and `--user` output carries internal user ids and users' problem-report comments: it stays on the host, is never pasted, attached or quoted. The default `./aiqsa.sh health` (counts and codes only) is the one safe to share. Use `--since 24h|7d|14d|30d`; text without `--json` is easier to skim.

## 3. Triage by user impact

Rank problems by who they hit and since when, not by log volume:

- `errorGroups`: new failures (`newInRange`), their code site, and `usersAtLeast`/`runsAtLeast` — many users versus one persistent user. Incidents are sampled, so these are lower bounds; counters hold the totals.
- `runs`: failure and cancel rates against `previous`; `failures` and `timeouts` by event, code, provider, route or tool family, with first/last seen and app versions.
- `signIns`: failures by method, step and code (users who cannot sign in cannot report it).
- `toolCalls`: families that fail or time out while their runs still complete.
- `latency`: run duration and time to first output p50/p95 per provider/model (bucket upper bounds).
- `problemReports`: what users reported, with run references; `operations`: restarts, stalled queues, dropped log lines, telemetry write failures.

## 4. Drill into one case

```sh
./aiqsa.sh health --run 1a2b3c4d                 # runs and incidents of one error reference
./aiqsa.sh health --user <id> --since 14d --json  # one user's incidents, failed runs, reports
```

The `--user` id comes from the `--full` report; keep it on the host as well.

## 5. Read the logs of that window

```sh
./aiqsa.sh logs --errors --since 2h app >"$aiqsa_diag_dir/app.log" 2>&1
./aiqsa.sh logs --since 2026-01-31T08:00:00Z app >"$aiqsa_diag_dir/app-all.log" 2>&1
```

`logs` masks `.env` secrets; `--errors`/`--warnings` drop plain-text lines, including startup and crash output, so read unfiltered logs for process failures. For a closed historical window use `docker compose logs --since … --until … --no-color <service>` with the installation's Compose selection. Logs rotate and vanish when a container is recreated; telemetry keeps longer. Find an id with `grep -F -- "$id"`; interpret unfamiliar fields with the installed version's [event definitions](../../lib/server/observability/events.ts).

Follow HTTP → accepted run/job → tool/provider or processing stages → operation outcome → persistence, and state each layer's outcome separately:

- `trace_id` groups one context; follow `run_id`/`job_id` across requests, claims and restarts. A Stop request has its own trace.
- HTTP 200 or the absence of ERROR does not prove a successful run. Only a `confirmed` persistence record proves that guarded write; `not_applied` and `unconfirmed` do not.
- For cancellation, find the first observed `nested_abort` source at the relevant layer; a configured deadline is not proof that it fired, and `parent_signal` alone does not identify Stop.
- Separate failures before headers, HTTP rejection, stream read and parse failure; missing status or byte counters mean unavailable evidence, not zero.
- `process.started` is not readiness; read `readiness.changed`. Repeated failures may be suppressed (`repeat_count`, `subsystem.recovered`); `logging.dropped_records` reports lost output.

If there is no terminal record, SIGKILL/OOM may have stopped the process. Inspect only selected container state:

```sh
for aiqsa_diag_container in $(docker compose ps -a -q app); do
  docker inspect --format 'status={{.State.Status}} oom_killed={{.State.OOMKilled}} exit_code={{.State.ExitCode}} restarts={{.RestartCount}} started_at={{.State.StartedAt}} finished_at={{.State.FinishedAt}}' "$aiqsa_diag_container"
done
```

Never request full `docker inspect`: it contains `Config.Env`. Exit 137 alone does not prove OOM.

## 6. Bound the investigation

Collect existing evidence only. Do not restart/recreate services, retry jobs, change settings, migrate/seed, repair integrity, reindex, delete data, or repeat a paid provider call to reproduce an incident. Keep a proposed fix separate from the diagnosis; this Skill grants no additional authority.

Use the database only for a specific durable fact the report and logs lack: consult the relevant schema owner and run a bounded, read-only, owner-scoped query. Never mutate, dump tables, or read message content, payloads or raw histories.

## 7. Summarize

Return a short report per problem: severity (who is affected — how many distinct users and runs, how often, since which version and when it first appeared), the observed sequence and result codes, confirmed persistence or its uncertainty, the known cause versus hypotheses, and the next read-only step.

Summaries carry counts, codes, versions and times only — never user ids, problem-report comments, user text, documents, credentials or tokens, environment values, provider/tool bodies, custom endpoints, share URLs, or raw exception messages/stacks. Safe AIQSA records do not make arbitrary third-party logs safe to publish. Post an issue or send the report to others only when explicitly requested.
