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
  - "lib/server/engine/**"
---
# Run Contracts

How an accepted message becomes an answer: admission, retries, context and compaction, tools and approvals, agent-initiated changes, Workspace, scheduled tasks, Telegram, recovery and outputs. The pipeline lives in `lib/server/runs/`; tools in `lib/server/tools/`.

The native agent engine replaces the old run core (execution, tool loop, compaction, recovery and settlement in `lib/server/runs/`) and the Codex Agent in `lib/server/agents/`; admission, preparation and the tool executors stay. The old core is frozen and gets no fixes (operator decision 2026-10-22): it keeps serving chats until the switch, and nothing is ported from it where it differs from the rules below. Projects and Knowledge are disabled (root `AGENTS.md`), so runs get neither.

Until the switch the native engine (`lib/server/engine/`) serves only the interactive personal and temporary chat runs of the users in `AIQSA_NATIVE_ENGINE_USERS` that it can run (`lib/server/engine/routing.ts`); scheduled tasks, Telegram, answer review and Assistant chats stay on the old core (operator decision 2026-10-23). It keeps writing the rows the UI, exports, limits and deletion read (`Message`, `ModelRun`, `ModelRunToolCall`, `UsageEvent`). `RunTranscriptItem` adds only the provider-neutral transcript: it holds tool results, stays private to its chat, is never exported and is deleted with its run. Memory search results stay within the run that searched and later turns search again, because Memory rechecks authority before every disclosure (`agent_docs/MEMORY.md`). Earlier old-core answers enter its context as text.

## Answer first

Answering the user is the top priority (operator decision 2026-10-22).

- Model calls, summary and compaction calls included, retry transparently under the transport policy in `agent_docs/PROVIDERS.md`, and read-only tools retry the same way. None of them needs a durable dispatch receipt.
- A call with external side effects is recorded before dispatch and never re-sent automatically when its outcome is unknown; the transcript keeps the outcome as unknown. An equivalent call the model asks for later, in any turn, waits for the user's decision: the approval card for an MCP tool, whatever its consent, otherwise the user writing again (`lib/server/engine/unknownEffects.ts`).
- The answer is saved and shown before bookkeeping. Usage, checkpoints and other records are written after it and retried; their failure never fails the run or hides the answer.
- Entitlement is checked at admission, not again before each call. Per-request ownership checks stay.
- A run reaches exactly one terminal state. An interrupted run (restart, crash) keeps its transcript, files and outputs and offers Continue, which starts an ordinary follow-up turn. Recovery touches only its own engine's runs.
- Completion requires the provider's terminal proof. Failure keeps accepted partial text and reported usage without claiming success. Cancellation stops later work and writes; stale reconciliation never sweeps newer runs.
- An unknown command exit, a confirmed environment stop and durable cleanup are different facts. A local bookkeeping failure never re-sends a side-effecting call or counts as a provider failure. Never infer a cause from exception text.
- Optional work such as chat titles never delays an answer.

## Admission and context

- Every chat is one agent, with no Agent mode or Workspace toggle (operator decision 2026-10-22): a direct answer is a one-round loop, and the agent has the same tools whether or not the Workspace VM runs. Chat models must support tool calling (`agent_docs/PROVIDERS.md`).
- Admission freezes every non-secret binding the run will use: model, credential, tools, Skills, Search sources, budgets, Workspace runtime. Retries use these bindings, never current settings or browser claims.
- An Assistant run takes its fixed settings only from the Assistant definition; a chat bound to an Assistant rejects request fields that would override them.
- Regeneration is an ordinary run through the same pipeline.
- Context follows the active branch's ancestors, never siblings. A reviewed answer is read as its question plus latest version. User turns stay in context after an error or a partial answer.
- Context size is measured from the provider's reported usage, so opaque reasoning counts only through provider figures. Compaction runs near the model's real window and writes a summary on every route (decision 2026-10-23: on the quality evaluation summaries kept 21 of 23 facts and 4 of 5 continuations, the provider's native compaction 17 and 2; it stays behind `COMPACTION_LIFECYCLE.native`). Summaries never contain provider reasoning, signatures or attachment identifiers, and the tool results they replace stay readable by reference. A request that cannot fit even after compaction fails visibly.
- The user does not wait for compaction: it runs in the background and its item enters the transcript at a request boundary. Only a request past the swap threshold or rejected for its size waits for it or compacts itself (`lib/server/engine/runContext.ts`). A run never waits after its answer, since a run still open holds off the chat's next message: a compaction still running goes on detached under its own deadline, stops when its chat or account is deleted or the process stops, and its run records the item when it finishes; a later run of the chat joins it rather than compacting the same span again (`lib/server/engine/detachedCompactions.ts`). A compaction reads the transcript as later turns read it, so Memory results enter it only as their note, and it never covers the run's own context (Skills index, pinned Skills).
- Personal presets apply only to personal and temporary chats, never to Assistants. Instructions are never Memory facts.
- Once accepted, execution belongs to the server: closing the browser does not cancel the run, while Stop, deadlines and deleting the chat or account still end it. A Memory preparation failure answers without Memory instead of failing the run.
- Automatic answer review steps are ordinary server-driven runs of the initiator, each claimed once.

## Agent-initiated changes

The agent may do for its user everything the user can do with their own resources: secrets, Skills, Assistants, artifacts, scheduled tasks and personal settings (operator decision 2026-10-23). An administrator agent is a later, separate step.

- A change goes through the same service as the UI, with its validation, revisions and limits, commits with its tool call and shows a card, with Undo where the owner keeps revisions.
- Deleting, and sharing or publishing beyond the user (other users, installation-wide listing), needs the user's confirmation in the card. Changing a scheduled task's history retention deletes chats, so it counts as deleting. Other users' resources and administrator settings are never touched.
- Data-changing MCP calls are sent only after the initiator's approval (`agent_docs/SECURITY.md`); after an Allow the agent continues the same turn with the call's result.
- Memory is frozen and keeps its own change rules (`agent_docs/MEMORY.md`). Skill store rules are in `agent_docs/BACKEND.md`.

## Scheduled tasks

Code: `lib/server/scheduledTasks/`.

- A scheduled task is its owner's standing authority for one saved prompt. Every occurrence is re-admitted through the ordinary send handler as the owner, under the current catalog, entitlements and active-run rules. Saved models and Search sources are never substituted; lost authority (pinned Skills included) fails the occurrence and pauses the task visibly.
- An occurrence's context is flat and frozen at admission: the prompt, plus the previous shown result in same-chat mode. Owner turns, branch notes, other tool history and chat artifacts stay out.
- With tools on, a task uses the owner's MCP servers and Skills in Auto mode (never Load all) plus its pinned Skills. Scheduled runs need no per-run approval (operator decision 2026-10-04, `agent_docs/SECURITY.md`) and never create tasks.
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

- Skills grant no capabilities. Other users' Skills require approved revisions and audience authority, checked at admission. Turning Skills off keeps pins. Filtering never hides a required dependency.

## Search and documents

- Search freezes its exact sources and routes at admission and never silently drops or substitutes one. Attachments do not disable selected Search.
- `fetch_url` reads only links from user-authored text on the branch, delivered follow-ups or the same run's Search results. The rules for links and transport are in `agent_docs/SECURITY.md`.
- Chat PDF admission picks a verified route and freezes its destination; required document work finishes before any other dispatch, and the preparation model only transcribes. A Workspace run may continue past a classified transcription failure with the verified original and an explicit unread-content notice; access, integrity and cancellation failures stay blocking.
- Transcription keeps visible text and meaningful visuals and never invents hidden values, causes or intent. Uncertain table rows, units and associations stay uncertain; numbers keep their exact decimals and are never converted.

## Tools and MCP

- Auto, Load all and Off are user choices, and Auto stays as it works today (operator decision 2026-10-23): it freezes the authorized catalog, `find_tools` is local, model-free search, and Skills arrive through their index and `load_skill`, so not every schema enters the context. An unusable server records a stable reason and the answer continues.
- When the call budget runs out, the agent gets one tool-free round that names the work it could not verify.
- Repeating an identical, not provably read-only call after identical successes is blocked as `tool_call_repeat_blocked`.
- Results too large for the context arrive as an excerpt with a reference the agent can read later, never silently truncated. Every result longer than a short excerpt is saved with that reference, so a compaction can leave it out and name where it lives (decision 2026-10-23: exact facts recalled after compaction rose from 17 to 21 of 23).
- A tool result is a transcript item of its chat. Reading it by reference checks only that the reader may read that chat, and never reruns the call.

## Workspace

- Workspace is available in every chat whenever the installation offers it, so its tools ride on every request (accepted cost, operator decision 2026-10-20). The VM is not started per chat: it boots at the first call that needs code execution, may be prewarmed when that is cheap, and keeps the chat's files. A capability that needs no code execution, such as secrets, Skill instructions, MCP, Memory, search or images, never requires the VM (operator decision 2026-10-22).
- Admission binds the Workspace runtime, image, tool catalog, network policy and secret revisions. The server controls sandbox identity and VM lifecycle; execution and export are exclusive per chat. Guests receive verified originals and the user's saved secrets under `agent_docs/SECURITY.md`.
- Every terminal path retires guest execution authority: it stops registered processes, or stops the VM (disk intact) when execution state is unknown. Stop keeps the environment; a successful turn leaves no background processes. Completion requires closed output obligations; an export failure keeps the answer. Path escapes fail closed and links or special files are skipped visibly.
- Vision-capable models read images natively. Workspace files, and chat images for models without vision, reach a model only through admitted System Vision, whose results are untrusted.
- The Codex Agent mode is frozen with the old core and is removed after the switch; do not extend it.
