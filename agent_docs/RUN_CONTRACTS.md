---
paths:
  - "lib/server/runs/**"
  - "lib/server/tools/**"
  - "lib/server/toolObservations/**"
  - "lib/server/knowledge/**"
  - "lib/server/mcp/**"
  - "lib/server/workspace/**"
  - "lib/server/agents/**"
  - "lib/server/scheduledTasks/**"
  - "lib/server/telegram/**"
  - "lib/server/answerReviews/**"
  - "lib/server/webFetch/**"
---
# Run Contracts

How an accepted message becomes an answer: admission, context, tools, Knowledge evidence, MCP, Workspace and Agent runs, scheduled tasks, Telegram, recovery and settlement. The pipeline lives in `lib/server/runs/`; tools in `lib/server/tools/`; Knowledge answering in `lib/server/knowledge/`.

## Admission and context

- Admission freezes every non-secret binding the run will use: model, credential, tools, Search sources, Knowledge scope, budgets, Workspace runtime. Recovery and retries use these frozen bindings, never current settings or browser claims.
- An Assistant run takes its fixed settings only from the Assistant definition; a chat bound to an Assistant rejects request fields that would override them. Implicit Project defaults apply only to a first message that names no Assistant and no composer settings, and never make that message fail. Project runs keep rechecking Project authority, credentials and revocation.
- Regeneration is an ordinary run through the same pipeline.
- Context follows the active branch's ancestors, never siblings. A reviewed answer is read as its question plus latest version. User turns stay in context after an error or a partial answer.
- Earlier attempts of the same user message contribute their tool calls only as provider-only history. That history carries no authority, and its compact record is irreducible: the request is refused rather than dropping it.
- Context compaction never silently drops history. A turn or tool round leaves the request only after notes the run committed cover it; if the request still does not fit, the run is refused explicitly. Summaries never contain provider reasoning, signatures or attachment identifiers. Mechanics live in `lib/server/runs/contextCompaction*.ts`.
- Personal presets apply only to personal and temporary chats, never to Assistants or Projects. Instructions are never Memory facts.
- Once accepted, execution belongs to the server: closing the browser does not cancel the run, while Stop, deadlines and authority loss still apply. A Memory preparation failure answers without Memory instead of failing the run.
- Automatic answer review steps are ordinary server-driven runs of the initiator, each claimed once.

## Model-initiated changes

Models change user data only through these operator exceptions, always for the chat's owner and under the owner's own rules and limits. The first two exist only in personal chats, never in scheduled, temporary, Project, Assistant or Knowledge runs:

- In an ordinary personal chat the model may create one scheduled task per answer, and change, pause or resume the owner's tasks. It may choose a new task's history retention, but only the owner changes it later, because retention deletes chats. Deleting a task only proposes it; the owner's click deletes. Each change commits with its tool call's settlement and shows a card. A scheduled task's own turns and Agent runs never create tasks.
- In an interactive personal chat the model may create a personal Skill or save a new version of the owner's Skill, one per answer, with an after-the-fact card and Undo (`save_skill`, operator decision 2026-10-07). The Skill store rules are in `agent_docs/BACKEND.md`.
- MCP tools that may change data are not an exception (operator decision 2026-10-08). Every interactive run, Project, Assistant and Knowledge chats included, sends them only after the initiator approves; an Allow once is consumed by the claim of exactly that call. The server-written turn that continues after an Allow is never user speech and never Memory evidence. Approval mechanics are in `agent_docs/SECURITY.md`.

## Scheduled tasks

Code: `lib/server/scheduledTasks/`.

- A scheduled task is its owner's standing authority for one saved prompt. Every occurrence is re-admitted through the ordinary send handler as the owner, under the current catalog, entitlements and active-run rules. Saved models and Search sources are never substituted; lost authority (pinned Skills included) fails the occurrence and pauses the task visibly.
- An occurrence's context is flat and frozen at admission: the prompt, plus the previous shown result in same-chat mode. Owner turns, branch notes, other tool history and chat artifacts stay out.
- With tools on, a task uses the owner's MCP servers and Skills in Auto mode (never Load all) plus its pinned Skills. Knowledge and Agent stay off. Scheduled runs need no per-run approval (operator decision 2026-10-04, `agent_docs/SECURITY.md`).
- Same-chat tasks start a new chat each calendar month, carrying a reauthorized copy of the previous result and the Workspace files across; the rotation epoch fences late writes to the old chat.
- A run that could not use a source its previous result relied on is complete but unhealthy; repeated unhealthy runs pause the task.
- Monitoring tasks are checks. The model reports `update`, `no_update` or `goal_reached` through a reserved built-in tool. Verdicts are model-reported and fail open: only a healthy `no_update` is hidden (no unread mark, email, push or Telegram). A check missing a source it relied on shows as `could_not_check` and never counts as a comparison basis or a reached goal.

## Telegram

Code: `lib/server/telegram/`.

- A Telegram message is an interactive personal run of the linked user, sent through the ordinary send handler; access is rechecked for each message and each delivery, and revoking the linking session unlinks. Button approvals use the ordinary approval path.
- Tasks with Telegram notification send their results and files through a durable outbox and never repeat an ambiguous send.
- Telegram is a content egress destination (operator decision 2026-10-19); see `agent_docs/ARCHITECTURE.md`.

## Follow-ups and continuation

- A follow-up adds user input to a running answer within its accepted bindings and budgets; delivery proves receipt, not obedience.
- Continuation into a new chat summarizes the active branch's text through the admitted System Model, without tools, attachments or Workspace inspection. An enabled Workspace may copy its project files unread into a private single-use seed.

## Skills

- Skills grant no capabilities. Other users' and Project Skills require approved revisions and audience authority. Turning Skills off keeps pins; Projects ignore personal Skill preferences. Filtering never hides a required dependency, and reads reauthorize.

## Search and documents

- Search freezes its exact sources and routes at admission and never silently drops or substitutes one. Attachments do not disable selected Search.
- `fetch_url` reads only links from user-authored text on the branch, delivered follow-ups or the same run's Search results. The rules for links and transport are in `agent_docs/SECURITY.md`.
- Chat PDF admission picks a verified route and freezes its destination; required document work finishes before any other dispatch, and the preparation model only transcribes. A Workspace run may continue past a classified transcription failure with the verified original and an explicit unread-content notice; access, integrity and cancellation failures stay blocking.
- Transcription keeps visible text and meaningful visuals and never invents hidden values, causes or intent. Uncertain table rows, units and associations stay uncertain; numbers keep their exact decimals and are never converted.
- Knowledge ingestion follows its immutable Profile and disclosed destination and never borrows Memory's role. Reprocessing creates a new generation, keeps old attempts and reuses only checksum-verified settled work.

## Knowledge evidence

- Knowledge Sources, Versions, ready artifacts and accepted evidence keep their identities. Removing a Source from a Base, replacing it or reprocessing it affects only future snapshots. Equal content never merges Sources.
- No Knowledge scope means no Knowledge I/O. Admission freezes the authorized Sources, ready Versions, Profile destinations and any exclusions, and discloses exclusions. Capacity never silently narrows scope.
- Admission delivers the full corpus when it fits; otherwise the model gets `search_knowledge`. Source aliases are run-local disclosures, not grants. Every call rechecks scope, egress and readiness before external work.
- OpenSearch supplies candidates; PostgreSQL revalidates authority for every hit. A required search backend failure fails visibly and is never reported as empty evidence or replaced by another backend. "No relevant evidence", "retrieval unavailable", cancellation and invalid output stay distinct outcomes.
- Grounding: composition cannot declare evidence sufficient, and matching citations are not proof. Code checks reference integrity, not semantic truth. Exhaustive requests stay exhaustive; unavailable resources or missing premises prevent claims of completeness or absence. Unchanged drafts get no repeated paid review.
- Publication is deterministic and provider-free and revalidates every excerpt and citation handle against the accepted manifest. Only persisted, delivered evidence can support a citation. Deleting a Source keeps the generated text but scrubs its private evidence and later citation resolution.

## MCP tool loop

- Auto, Load all and Off are user choices. Auto freezes the authorized catalog; `find_tools` is local, model-free search. Schemas are exposed only after reauthorization and a checkpoint; an unusable server records a stable reason and the answer continues.
- Tool batches are persisted before any effect. A batch over the remaining call budget is neither persisted nor dispatched; the run forces one tool-free answer that names the unverified work.
- Repeating an identical, not provably read-only call after identical successes is blocked as `tool_call_repeat_blocked`; a call waiting for approval records `mcp_approval_required`. Recovery derives both from persisted calls and re-searches only unsettled ones.
- Results too large for the budget arrive as references the model reads in a later round, never silently truncated.
- Tool history stores only call references and digests. Each request re-projects them under the reading run's current authority; MCP arguments and results appear only with current access and provable redaction. Reading a past call never reruns it. A failed history read degrades to "details unavailable" instead of failing the run.

## Workspace and Agent runs

- Workspace admission freezes the runtime, image, tool catalog, network policy, authority and secret revisions. The server controls sandbox identity and VM lifecycle; execution and export are exclusive per chat. Guests receive verified originals and the owner's personal secrets under `agent_docs/SECURITY.md`.
- Every terminal path retires guest execution authority: it stops registered processes, or stops the VM (disk intact) when execution state is unknown. Stop keeps the environment; a successful turn leaves no background processes. Completion requires closed output obligations; an export failure keeps the answer. Path escapes fail closed and links or special files are skipped visibly.
- Vision-capable models read images natively. Workspace files, and chat images for tool-calling models without vision, reach a model only through admitted System Vision, whose results are untrusted. A Knowledge answer gets the current images as one frozen description: untrusted request context, never evidence.
- The Agent (Codex) needs a personal chat with manual Workspace, administrator-enabled internet and an eligible model. Codex owns planning, tools, compaction and completion; AIQSA owns authority, accounting and settlement, without an evaluator. Unsettled effects forbid interruption and Stop is terminal. Knowledge and Memory are unavailable to the Agent.
- Administrator Agent limits default to Off. Off removes the time, call, token and output caps, never accounting, leases, Stop or model constraints.

## Settlement and outputs

- Completion requires the provider's terminal proof. Failure keeps accepted partial text and reported usage without claiming success. Cancellation stops later work and writes; stale reconciliation never sweeps newer runs.
- An unknown command exit, a confirmed environment stop and durable cleanup are different facts. Local publication or accounting failures never authorize replay or prove a provider failure. Never infer a cause from exception text.
- Optional work such as chat titles never delays an answer.
