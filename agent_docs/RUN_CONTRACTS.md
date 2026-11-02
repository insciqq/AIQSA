---
paths:
  - "lib/server/runs/**"
  - "lib/server/tools/**"
  - "lib/server/toolObservations/**"
  - "lib/server/mcp/**"
  - "lib/server/workspace/**"
  - "lib/server/scheduledTasks/**"
  - "lib/server/telegram/**"
  - "lib/server/webFetch/**"
  - "lib/server/engine/**"
  - "lib/server/subagents/**"
  - "lib/server/research/**"
---
# Run Contracts

How an accepted message becomes an answer. The pipeline lives in `lib/server/runs/`; tools in `lib/server/tools/`.

The native agent engine (`lib/server/engine/`) replaced the old run core and runs every turn, whichever path admits it (operator decision 2026-10-23). A model the engine cannot run (no tool calling, an adapter it does not render) is refused at admission with a stable code, never answered another way (`lib/server/engine/handlerSupport.ts`).

`RunTranscriptItem` is the run's provider-neutral transcript beside its rows: it holds tool results, stays private to its chat, is never exported and is deleted with its run. Memory search results stay within the run that searched and later turns search again, because Memory rechecks authority before every disclosure (`agent_docs/MEMORY.md`).

## Answer first

Answering the user is the top priority (operator decision 2026-10-22).

- Model calls, summary and compaction calls included, retry transparently under the transport policy in `agent_docs/PROVIDERS.md`, and read-only tools retry the same way. None of them needs a durable dispatch receipt.
- A call with external side effects is recorded before dispatch and never re-sent automatically when its outcome is unknown; the transcript keeps the outcome as unknown. An equivalent call the model asks for later, in any turn, waits for the user's decision: the approval card for an MCP tool, whatever its consent, otherwise the user writing again (`lib/server/engine/unknownEffects.ts`).
- The answer is saved and shown before bookkeeping. Usage, checkpoints and other records are written after it and retried; their failure never fails the run or hides the answer.
- A run reaches exactly one terminal state. An interrupted run (restart, crash) keeps its transcript, files and outputs and offers Continue, which starts an ordinary follow-up turn. Recovery touches only the engine's own runs.
- Completion requires the provider's terminal proof. Failure keeps accepted partial text and reported usage without claiming success. Cancellation stops later work and writes; stale reconciliation never sweeps newer runs.
- An unknown command exit, a confirmed environment stop and durable cleanup are different facts. A local bookkeeping failure never re-sends a side-effecting call or counts as a provider failure. Never infer a cause from exception text.
- Optional work such as chat titles never delays an answer.

## Admission and context

- Every chat is one agent, with no Agent mode or Workspace toggle (operator decision 2026-10-22): a direct answer is a one-round loop, and the agent has the same tools whether or not the Workspace VM runs.
- Admission freezes every non-secret binding the run will use: model, credential, tools, Skills, Search sources and routes, budgets, Workspace runtime. Retries use these bindings, never current settings or browser claims.
- An Assistant run takes its fixed settings only from the Assistant definition; a chat bound to an Assistant rejects request fields that would override them.
- Context follows the active branch's ancestors, never siblings. User turns stay in context after an error or a partial answer.
- Context size is measured from the provider's reported usage, so opaque reasoning counts only through provider figures. Compaction runs near the model's real window and writes a summary on every route (decision 2026-10-23, reasons in `lib/server/engine/runContext.ts`). Summaries never contain provider reasoning, signatures or attachment identifiers, and the tool results they replace stay readable by reference. A request that cannot fit even after compaction fails visibly.
- The native system prompt and tool list stay byte-identical across a chat's turns on one day, so provider prompt caches keep reading them: the time of day and what admission records as one turn's own (`prompt.turnGuidance`) ride in run context just before the input and are never recorded (`lib/server/engine/systemPrompt.ts`).
- A run never waits for a compaction after its answer, since a run still open holds off the chat's next message (`lib/server/engine/detachedCompactions.ts`). A compaction never covers the run's own context (Skills index, pinned Skills); replay also keeps the input its attachments and reminder render on.
- Personal presets apply only to personal and temporary chats, never to Assistants. Instructions are never Memory facts.
- Once accepted, execution belongs to the server: closing the browser does not cancel the run, while Stop, deadlines and deleting the chat or account still end it. A Memory preparation failure answers without Memory instead of failing the run.

## Agent-initiated changes

The agent may do for its user everything the user can do with their own resources: secrets, Skills, Assistants, artifacts, scheduled tasks and personal settings (operator decision 2026-10-23). An administrator agent is a later, separate step.

- A change goes through the same service as the UI, with its validation, revisions and limits, commits with its tool call and shows a card, with Undo where the owner keeps revisions.
- Deleting, and sharing or publishing beyond the user (other users, installation-wide listing), needs the user's confirmation in the card. Changing a scheduled task's history retention deletes chats, so it counts as deleting.
- Interactive MCP writes follow the guard and approval rules in `agent_docs/SECURITY.md` (operator decision 2026-10-29). After an Allow the agent continues the same turn with the call's result. Once the user has written since, the Allow becomes the next instruction and covers the call made again only with the same arguments (`lib/server/engine/execution.ts`). In Auto the server loads the approved tool from the run's frozen catalog and sends exactly the approved call; one no longer available is refused visibly in the answer (decision 2026-10-23).
- Assistant chats take only the guide and Skill saves (operator decision 2026-10-29): the author's instructions steer them; only Skill saves have Undo.
- Custom sub-agents (operator decision 2026-10-29) are personal and list in run context (`lib/server/subagents/typeCatalog.ts`); edits and moving the default (2026-10-30) have Undo; a confirmed deletion is final and cuts off its threads.

## Sub-agents

Operator decisions 2026-10-29, Claude Code's Agent tool the reference (`lib/server/engine/subagents/`).

- A sub-agent inherits its parent's frozen binding; `model` and `effort` come only from the chat models admission froze (`lib/server/engine/subagents/modelCatalog.ts`), never substituted.
- It never changes the user's resources or asks the user: an MCP call that would wait for approval, or a repeat of an unknown effect, is handed back unsent, climbs with each parent's report, and the main agent makes it (`lib/server/engine/toolBatch.ts`).
- One with every tool may start children, one level deep and at most 2 at once (operator decision 2026-10-31, replacing "no nesting"; `lib/server/subagents/nesting.ts`). Only their parent continues them and only it or the main agent stops them; a child reports and asks in its parent's mailbox and ends with it.
- Only the user's message, passed verbatim, authorizes irreversible website actions; a brief, report or message from any agent is never user speech.
- Agents talk (operator decisions 2026-10-31): a message is no worse than a shared file, so each agent lists the others on its branch and sub-agents write to any active agent by name; the protection is that it authorizes nothing. A question goes to the parent: a background asker waits, the main agent woken if it ended; a foreground one ends `blocked (needs_answer)` and is continued by name; only the main agent asks the user. Mailboxes are `RunFollowup` rows stamped by the transcript write that records them, so a thread's next turn reads what a turn left (`SUBAGENT_FOLLOWUP_LIMITS`).
- Thread rows stay out of the main context, Memory and exports. Threads branch with their anchor run; a bounded number run at once per chat (`SUBAGENT_LIMITS`), none replayed.
- A new thread with no `type` runs the custom sub-agent of its name, else the user's default frozen at admission, else the built-in; `type: "built-in"` always runs the built-in. A wrong `type` or a default that cannot run refuses visibly, never the built-in (operator decisions 2026-10-30, `lib/server/engine/subagents/callTools.ts`).
- Assistant chats work the same (operator decision 2026-10-30, replacing the 2026-10-29 limit): the runner's custom sub-agents, default, `model` and `effort`. Their tools stay the run's, which tool groups only narrow, and a custom sub-agent's instructions apply. Accepted risk: a model the author fixed no longer binds sub-agents, and the Assistant's instructions reach the provider of the runner's chosen sub-agent model.

## Scheduled tasks

Code: `lib/server/scheduledTasks/`.

- A scheduled task is its owner's standing authority for one saved prompt. Every occurrence is re-admitted through the ordinary send handler as the owner, under the current catalog, entitlements and active-run rules. Saved models and Search sources are never substituted; lost authority (pinned Skills included) fails the occurrence and pauses the task visibly.
- An occurrence's context is flat and frozen at admission: the prompt, a webhook occurrence's event as labelled untrusted data, and the previous shown result in same-chat mode. Owner turns, branch notes, other tool history and chat artifacts stay out.
- With tools on, a task uses the owner's MCP servers and Skills in Auto mode (never Load all) plus its pinned Skills. Scheduled runs need no per-run approval (operator decision 2026-10-04, `agent_docs/SECURITY.md`) and never create tasks.
- Monitoring tasks are checks. Verdicts are model-reported and fail open: only a healthy `no_update` is hidden (no unread mark, email, push or Telegram). A check missing a source it relied on shows as `could_not_check` and never counts as a comparison basis or a reached goal.
- A task runs on a schedule, a webhook or both (operator decision 2026-10-25). Each accepted event is an ordinary occurrence; later events wait in order while a run is open.

## Telegram

Code: `lib/server/telegram/`.

- A Telegram message is the linked user's interactive personal run through the ordinary send handler; access is rechecked per message and delivery. The link belongs to the account (operator decision 2026-10-19): revoking all sessions, a password change or reset, deactivation or rejection (SCIM included) and disconnecting (settings, admin, `/unlink`) remove it, and disconnecting voids pending link codes; signing out of one browser does not. Approval buttons use the ordinary path. Telegram turns take no self-service tools or Skill saves: the bridge shows only approval cards, never confirmations or Undo (decision 2026-10-23). Telegram turns and scheduled occurrences start no background sub-agents, but answer and stop those of their branch.
- Tasks with Telegram notification send their results and files through a durable outbox and never repeat an ambiguous send.
- Answers and task results carry no Sources list; a `[N]` citation links to its source (operator decision 2026-10-25).

## Follow-ups and continuation

- A follow-up adds user input to a running answer within its accepted bindings and budgets; delivery proves receipt, not obedience.
- Continuation into a new chat summarizes the active branch's text through the admitted System Model, without tools, attachments or Workspace inspection. An enabled Workspace may copy its project files unread into a private single-use seed.

## Background sub-agents

- One active run per thread (operator, 2026-10-29): only the main agent's run blocks sends, edits and branch switches; its Stop spares background sub-agents (foreground turns end with it); deleting stops them first, archiving refuses (`subagents_running`). Accepted risk: wake-up chains run until usage limits refuse.
- A callback wakes the main agent through the ordinary send as the owner, on the branch's latest turn. Wake-up turns and callbacks into a running answer are the server's, never the user's speech: they authorize nothing, and wake-up turns stay out of exports and shares (`lib/server/runs/subagentBackground/wakeUp.ts`).

## Research

Operator decisions 2026-11-01. The model starts it when the user wants a thorough result, with no control, only with Search in an interactive web run. It stays in one run that ends in an ordinary answer: Stop ends it, so researchers run in the foreground, and a restart never replays it. The server holds the report back until its gates end; a failed gate or the deadline leaves a visible note, never a lost answer (`lib/server/research/run.ts`).

The research system is being built on that method, part by part, on one contract (`lib/contracts/research.ts`, which holds every number below) and one set of ports (`lib/server/research/ports.ts`). A port not yet filled is a no-op, so a run behaves as above until its part lands; the code shows which have. These decisions bind each part:

- No clarifying questions. The user may give the request and leave, so what the model lacks becomes a named assumption, or a branch when it changes the result.
- The user may not know what matters for what they ask about, so the model scopes first: it reads how such a thing is chosen and finds the criteria itself, and the user is told plainly that a plan is being made. Scoping's limit is the server's: past it only the plan's call still runs, and a model that never proposes still ends in an answer, marked as unchecked.
- The plan window, as in ChatGPT Deep Research: a short plan the user can change for a moment. With no action, research starts. The start button, a saved edit and a chat message end the window at once, an edit in progress holds it through a lease, and an abandoned edit releases the last saved plan. A closed tab changes nothing. The window's times are the server's, so a countdown survives a reload and a wrong client clock. A person edits the plan's words, never its questions, so a changed plan holds researchers back until the model has rebuilt the questions from those words (decision 2026-11-01).
- Time: phases count from the plan's release, and research winds down through them to a hard end, never a silent crash or an unmarked incomplete answer. Only a research run's turn is extended, once, at that moment. One researcher's turn has its own limit, so one stuck agent cannot spend the budget, and time ending a researcher is a result the main agent goes on from, never a failure. The main agent's tools close when running researchers stop, so it hands in a report; the checks keep theirs for as long as their phase needs. The hard end moves the turn's end either way, so a longer configured turn gets the same 90 minutes. A VM's own idle stop is fixed before anyone knows a run will research, so every VM's allows for it (accepted: after an app crash a guest may stay up longer). Stop works in every phase.
- An approval continuation is a new run of the same research: it works on the rows of the run that started it, named by that start call's stored result, which counts only when it names a run of the branch. Its phases start afresh, so a long wait for a person is not charged to research.
- A site that wants a person gets a shorter handoff in research, then goes to the unreachable list and the work goes on, since the user may have left. Other runs keep their wait.
- A finding is an append-only record the moment it is made: a correction supersedes, and nothing is deleted while the run lives, so no send back or rewrite can lose one (a real run went from 15 findings to 0). A cell recorded as nothing found counts as filled.
- A report rests on records (decision 2026-11-02). A draft names record ids and the server fills its findings from them: a real run's model, retyping them, listed 9 of 56, so the checks read the maker's specifications while the prices, sellers and reviews behind the pick went unread. A row the draft leans on needs a record cited in each cell that holds evidence, and a link in the report is a cited record. The check reads fields, so what they cannot show stays the model's word (`lib/server/research/reportCheck.ts`). A pick is a row of the matrix, or the report says the data does not separate the rows and what would decide. With no report the server builds the answer from the records: it picks nothing and says so, and it outranks the model's last text, since nearly every run has a line of narration by then.
- Research ends on what it finds, not on time: a real run went round for 70 minutes, each send back asking for one more detail. Holes in the matrix plan each round, and only the additions an agent makes with their reasons change it. Every gate has a cap on send backs, and past it the send back becomes that gate's note. The cap counts across an approval, since a person's Allow buys no checks; rounds with no new cell count afresh, as the clock does (decision 2026-11-02). A round is the researcher calls of one response, and every turn that ran counts, a failed one too, so failures cannot restart until time ends and what a failed turn saved still counts. A record under a key the matrix lacks is kept, never refused, and a frame with no rows has one cell per criterion, so a knowledge question has cells too. Every researcher keeps `record_evidence` and `change_research_frame` whatever its tool groups, since a custom researcher that cannot record fills no cell and research would read that as exhausted; a gate's turn never has them.
- Page texts live with the run and go with it (`agent_docs/ARCHITECTURE.md`), so a check reads what the researcher saw.
- A claim that stands for a record is judged on its stored page, since `fetch_url` refuses links only a browser reached and that authority stays; only a record with no stored page stays could not check. Last comes the skeptic, which tries to refute the conclusion, and only what an opened page shows counts. A finding goes back within the cap, researchers closed or not, since it needs none, and stays named in the answer until the skeptic itself finds it answered.
- Roles: the main agent stays on the chat's model; an administrator may bind researchers, and the checks (gap judge, verifier, skeptic). Not set, a role runs on the chat's model; set and unusable, research is refused visibly, never run on another model. Model names live in settings, never in code. Not everyone has two models, so a check may run on the report's own model: a separate context is still useful, and the answer says it is not an independent model.
- Nothing restarts by itself: only the user's Continue picks research up from what was recorded, and only on the interrupted run of its own branch. Any other new message is an ordinary turn. A Continue is a new run with its own bindings and row, linked once to the run it continues, with a fresh clock. What the gates said adds up across every Continue of a research, read back through the turns each one picked up: as with an approval, a Continue buys no checks, so caps stay spent, rejected claims stay named and an owed rebuild stays owed. A turn whose records were lost takes its part of that with it, so its caps reopen, and the log says so. With nothing recorded it starts over with the plan. So does a Continue past the chain's bound, since a further link would put the oldest records out of a reader's reach.

## Skills

- Skills grant no capabilities. Other users' Skills require approved revisions and audience authority, checked at admission. Turning Skills off keeps pins. Filtering never hides a required dependency (`lib/server/skills/catalogRelevanceAuthority.ts`).

## Search and documents

- Attachments do not disable selected Search; Search rules are in `agent_docs/PROVIDERS.md`.
- Required chat PDF work finishes before any other dispatch, and the preparation model only transcribes. A Workspace run may continue past a classified transcription failure with the verified original and an explicit unread-content notice; access, integrity and cancellation failures stay blocking.
- Transcription keeps visible text and meaningful visuals and never invents hidden values, causes or intent. Uncertain table rows, units and associations stay uncertain; numbers keep their exact decimals and are never converted.

## Tools and MCP

- Auto, Load all and Off are user choices, and Auto stays as it works today (operator decision 2026-10-23): it freezes the authorized catalog, `find_tools` is local, model-free search, and Skills arrive through their index and `load_skill`, so not every schema enters the context. An unusable server records a stable reason and the answer continues.
- Per-answer tool call and round limits are off by default, existing installations included; administrators may turn them on (operator decision 2026-10-26: agent tasks outgrow any count, and Workspace turns get an hour). An answer then ends at its tool time (`lib/server/runs/turnDeadline.ts`), Stop or a repeated call. When calls or tool time run out, one tool-free round names what could not be verified.
- Results too large for the context arrive as an excerpt with a reference the agent can read later, never silently truncated. Every result longer than a short excerpt is saved with that reference, so a compaction can leave it out and name where it lives (decision 2026-10-23).
- Reading a tool result by reference checks only that the reader may read its chat, and never reruns the call.

## Workspace

- Workspace is available in every chat whenever the installation offers it, so its tools ride on every request (accepted cost, operator decision 2026-10-20). The VM is not started per chat: it boots at the first call that needs code execution, may be prewarmed when that is cheap, and keeps the chat's files. A capability that needs no code execution, such as secrets, Skill instructions, MCP, Memory, search or images, never requires the VM (operator decision 2026-10-22).
- All of a chat's runs share one Workspace (operator decision 2026-10-29, `lib/server/workspace/attachments.ts`); Reset and continuation wait for sub-agents; only main-agent runs export downloads.
- Each terminal path retires its run's authority: the last attached run stops the VM; an earlier one provably stops its processes (`lib/server/workspace/agentProcessGuest.ts`), or else the VM, interrupting all attached runs. Successful turns leave no background processes. Completion requires closed output obligations; an export failure keeps the answer. Path escapes fail closed; links and special files are skipped visibly. A dead run whose stop cannot be proven is settled only behind a fenced Workspace (`workspace_stop_unproven`, `lib/server/runs/subagentBackground/recovery.ts`).
- `browser_handoff` (operator decisions 2026-10-26) waits for Done or Cancel within the tool time, returning only outcome and page; Stop and the deadline end it. Each agent's handoff holds only its tab, shown oldest first. Telegram and unattended runs refuse every agent (`browser_handoff_unavailable`); an unattended occurrence that asked fails as `browser_sign_in_required`.
- Vision-capable models read chat images natively, and verified ones view Workspace images (`view_workspace_image`, operator decision 2026-10-26), only in the answer that viewed them. Other images reach models only through admitted System Vision, with untrusted results.
