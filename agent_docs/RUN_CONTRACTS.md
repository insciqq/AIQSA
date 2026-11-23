---
paths:
  - "lib/server/runs/**"
  - "lib/server/tools/**"
  - "lib/server/toolObservations/**"
  - "lib/server/mcp/**"
  - "lib/server/workspace/**"
  - "lib/server/scheduledTasks/**"
  - "lib/server/telegram/**"
  - "lib/server/connectors/**"
  - "lib/server/discord/**"
  - "lib/server/messages/**"
  - "lib/server/instructions/**"
  - "lib/server/parsing/{adaptivePdf,modelPdf,pdfPreparation}*.ts"
  - "lib/server/webFetch/**"
  - "lib/server/engine/**"
  - "lib/server/subagents/**"
  - "lib/server/research/**"
---
# Run Contracts

How an accepted message becomes an answer. The pipeline lives in `lib/server/runs/`; tools in `lib/server/tools/`.

The native agent engine (`lib/server/engine/`) replaced the old run core and runs every turn, whichever path admits it (operator decision 2026-10-23). A model the engine cannot run (no tool calling, an adapter it does not render) is refused at admission with a stable code, never answered another way (`lib/server/engine/handlerSupport.ts`).

`RunTranscriptItem` is the run's provider-neutral transcript beside its rows: it holds tool results, stays private to its chat, is never exported and is deleted with its run. Past-chat search and `manage_memory` results (`runScopedResult`) stay within their run, so later turns search again and eligibility is rechecked at every disclosure (`agent_docs/MEMORY.md`).

## Answer first

Answering the user is the top priority (operator decision 2026-10-22).

- Model calls, summary and compaction calls included, retry transparently under the transport policy in `agent_docs/PROVIDERS.md`, and read-only tools retry the same way. None of them needs a durable dispatch receipt.
- A call with external side effects is recorded before dispatch and never re-sent automatically when its outcome is unknown; the transcript keeps the outcome as unknown. An equivalent call the model asks for later, in any turn, waits for the user's decision: the approval card for an MCP tool, whatever its consent, otherwise the user writing again (`lib/server/engine/unknownEffects.ts`).
- The answer is saved and shown before bookkeeping. Usage, checkpoints and other records are written after it and retried; their failure never fails the run or hides the answer.
- A run reaches exactly one terminal state. An interrupted run (restart, crash) keeps its transcript, files and outputs and offers Continue, which starts an ordinary follow-up turn. Recovery touches only the engine's own runs.
- A failed answer whose run finished work offers Continue too, whatever failed it, with Regenerate and a model change beside it: its steps stay on the branch, and Continue sends with the chat's current model (operator decision 2026-11-15: a provider that failed the last request of a 14-minute search left only Regenerate, which runs it all again; `answerKeptWorkV2` in `features/run-lifecycle-v2/runPresentation.ts`).
- Completion requires the provider's terminal proof. Failure keeps accepted partial text and reported usage without claiming success. Cancellation stops later work and writes; stale reconciliation never sweeps newer runs.
- An unknown command exit, a confirmed environment stop and durable cleanup are different facts. A local bookkeeping failure never re-sends a side-effecting call or counts as a provider failure. Never infer a cause from exception text.
- Optional work such as chat titles never delays an answer.

## Admission and context

- Every chat is one agent, with no Agent mode or Workspace toggle (operator decision 2026-10-22): a direct answer is a one-round loop, and the agent has the same tools whether or not the Workspace VM runs.
- Admission freezes every non-secret binding the run will use: model, credential, tools, Skills, Search sources and routes, budgets, Workspace runtime. Retries use these bindings, never current settings or browser claims.
- An Assistant run takes its fixed settings only from the Assistant definition; a chat bound to an Assistant rejects request fields that would override them.
- Context follows the active branch's ancestors, never siblings. User turns stay in context after an error or a partial answer.
- Context size is measured from the provider's reported usage, so opaque reasoning counts only through provider figures. Compaction runs near the model's real window and writes a summary on every route (decision 2026-10-23, reasons in `lib/server/engine/runContext.ts`). Summaries never contain provider reasoning, signatures or attachment identifiers, and the tool results they replace stay readable by reference. A request that cannot fit even after compaction fails visibly. While a request fits, a compaction runs only when it frees the recent tail's budget, never while what it cannot remove alone reaches the background threshold, and admission caps attachment text below that threshold (decision 2026-11-11, reasons in `lib/server/engine/compaction/policy.ts`).
- The native system prompt and tool list stay byte-identical across a chat's ordinary turns on one day (a research turn's differ, see `agent_docs/RESEARCH.md`), so provider prompt caches keep reading them: the time of day and what admission records as one turn's own (`prompt.turnGuidance`) ride in run context just before the input and are never recorded (`lib/server/engine/systemPrompt.ts`).
- A run never waits for a compaction after its answer, since a run still open holds off the chat's next message (`lib/server/engine/detachedCompactions.ts`). A compaction never covers the run's own context (Skills index, pinned Skills); replay also keeps the input its attachments and reminder render on, and both go before the summary, so a compaction keeps the cached prefix (2026-11-11).
- Personal presets apply only to personal and temporary chats, never to Assistants. Which requests change the Instructions and which the memory note is in `agent_docs/MEMORY.md`.
- Once accepted, execution belongs to the server: closing the browser does not cancel the run, while Stop, deadlines and deleting the chat or account still end it. Admission makes every run dispatchable at once, except one waiting at its PDF or Workspace gate, and a failed read of the memory note answers without it instead of failing the run.

## Agent-initiated changes

The agent may do for its user everything the user can do with their own resources: secrets, Skills, Assistants, artifacts, scheduled tasks and personal settings (operator decision 2026-10-23), personal Instructions included (2026-11-20), and the memory note (2026-11-22, `agent_docs/MEMORY.md`). An administrator agent is a later, separate step.

- A change goes through the same service as the UI, with its validation, revisions and limits, commits with its tool call and shows a card, with Undo where the owner keeps revisions.
- Deleting, and sharing or publishing beyond the user (other users, installation-wide listing), needs the user's confirmation in the card. Changing a scheduled task's history retention deletes chats, so it counts as deleting.
- Exception (operator decision 2026-11-16): the artifacts a Discord answer made are published by public link without a card, as the service account and with no expiry, like the thread's chat share: nobody can confirm for a service account, and Discord members have no AIQSA account. Accepted risks: the link travels outside the server with whatever the thread held, and since only a link's hash is stored, a delivery after a restart publishes the same version again under a new link (`lib/server/discord/artifacts.ts`).
- Interactive MCP writes follow the guard and approval rules in `agent_docs/SECURITY.md` (operator decision 2026-10-29). After an Allow the agent continues the same turn with the call's result. Once the user has written since, the Allow becomes the next instruction and covers the call made again only with the same arguments (`lib/server/engine/execution.ts`). The continuation has the authority of the turn whose call the user allowed: after an Allow of a wake-up's or a sign-in request's call it takes no self-service tools and commits no self-service change, since the Allow covers that one call (`storedUserRequest` in `lib/server/runs/turnProvenance.ts`). In Auto the server loads the approved tool from the run's frozen catalog and sends exactly the approved call; one no longer available is refused visibly in the answer (decision 2026-10-23).
- Assistant chats take only the guide and Skill saves (operator decision 2026-10-29): the author's instructions steer them; only Skill saves have Undo.
- Custom sub-agents (operator decision 2026-10-29) are personal and list in run context (`lib/server/subagents/typeCatalog.ts`); edits and moving the default (2026-10-30) have Undo; a confirmed deletion is final and cuts off its threads.

## Sub-agents

Operator decisions 2026-10-29, Claude Code's Agent tool the reference (`lib/server/engine/subagents/`).

- A sub-agent inherits its parent's frozen binding; `model` and `effort` come only from the chat models admission froze (`lib/server/engine/subagents/modelCatalog.ts`), never substituted.
- It never changes the user's resources or asks the user: an MCP call that would wait for approval, or a repeat of an unknown effect, is handed back unsent, climbs with each parent's report, and the main agent makes it (`lib/server/engine/toolBatch.ts`).
- One with every tool may start children, one level deep and at most 2 at once (operator decision 2026-10-31, replacing "no nesting"; `lib/server/subagents/nesting.ts`). Only their parent continues them and only it or the main agent stops them; a child reports and asks in its parent's mailbox and ends with it.
- Only the user's message, passed verbatim, authorizes irreversible website actions; a brief, report or message from any agent is never user speech.
- Agents talk (operator decisions 2026-10-31): a message is no worse than a shared file, so each agent lists the others on its branch and sub-agents write to any active agent by name; the protection is that it authorizes nothing. A question goes to the parent: a background asker waits, the main agent woken if it ended; a foreground one ends `blocked (needs_answer)` and is continued by name; only the main agent asks the user. Mailboxes are `RunFollowup` rows stamped by the transcript write that records them, so a thread's next turn reads what a turn left (`SUBAGENT_FOLLOWUP_LIMITS`).
- A sub-agent's own tools decide what it hears of the Workspace, as the run's Workspace decides the main agent's (operator decision 2026-11-16): one whose tool groups leave it out, a research gate included, runs as in a chat without one, and the main agent's list marks such a type and default so its brief asks for a report, not a file (`lib/server/subagents/typeCatalog.ts`).
- Thread rows stay out of the main context, past-chat search and exports. Threads branch with their anchor run; a bounded number run at once per chat (`SUBAGENT_LIMITS`), none replayed.
- A new thread with no `type` runs the custom sub-agent of its name, else the user's default frozen at admission, else the built-in; `type: "built-in"` always runs the built-in. A wrong `type` or a default that cannot run refuses visibly, never the built-in (operator decisions 2026-10-30, `lib/server/engine/subagents/callTools.ts`).
- Assistant chats work the same (operator decision 2026-10-30, replacing the 2026-10-29 limit): the runner's custom sub-agents, default, `model` and `effort`. Their tools stay the run's, which tool groups only narrow, and a custom sub-agent's instructions apply. Accepted risk: a model the author fixed no longer binds sub-agents, and the Assistant's instructions reach the provider of the runner's chosen sub-agent model.

## Scheduled tasks

Code: `lib/server/scheduledTasks/`.

- A scheduled task is its owner's standing authority for one saved prompt. Every occurrence is re-admitted through the ordinary send handler as the owner, under the current catalog, entitlements and active-run rules. Saved models and Search sources are never substituted; lost authority (pinned Skills included) fails the occurrence and pauses the task visibly.
- An occurrence's context is flat and frozen at admission: the prompt, a webhook occurrence's event as labelled untrusted data, and the previous shown result in same-chat mode, as its saved answer text. Owner turns, branch notes, other tool history and chat artifacts stay out; that result's own tool work feeds only the unknown-effect guard. Its turn context also states, as server facts, that the run already is the named automation with its schedule, which it cannot change, and when that result's run started (decision 2026-11-11, reasons in `lib/server/scheduledTasks/occurrenceContext.ts`). A new task continues in one chat unless the user asks otherwise (decisions 2026-11-08).
- With tools on, a task uses the owner's MCP servers and Skills in Auto mode (never Load all) plus its pinned Skills. Scheduled runs need no per-run approval (operator decision 2026-10-04, `agent_docs/SECURITY.md`) and never create tasks. What a task's Memory switch allows is in `agent_docs/MEMORY.md`.
- Monitoring tasks are checks. Verdicts are model-reported and fail open: only a healthy `no_update` is hidden (no unread mark, email, push, Telegram or move in the chat list). A check missing a source it relied on (at admission, in its code, tool search or MCP calls), or whose model reports `could_not_check`, shows as `could_not_check`, never counts as a comparison basis or a reached goal, and extends the streak that pauses the task; one whose context held no previous result is the starting point (decision 2026-11-08). Hidden means gone from what the owner reads (operator decision 2026-11-11, option B; deleting them was rejected): the chat's history and its pages, its branch graph, message search, exports and shares leave out a `no_update` check's turn and answer however old, and the chat's summary counts them. The rule reads durable facts, `Message.scheduledTaskPrompt` and its run's `scheduledOutcome`, since occurrence rows are pruned; the rows stay. A message the user writes continues the latest turn shown, never a quiet check, and its model reads the shown branch too, reply, regenerate or edit: hundreds of quiet prompts and their tool results would crowd and mislead it. Only a quiet check's call whose outcome is unknown, anywhere in the chat since a reply leaves the quiet checks it follows off its path, still counts for the effect guard (`lib/server/chats/quietScheduledChecks.ts`).
- Only `goal_reached` ends a monitoring task, and its instruction says so; a goal stands unless the question changed or the task was paused or completed during the check. A model that answers without its verdict is asked for it once more, and the answer stands (decisions 2026-11-08). A shown check whose answer has no text is asked for it once, since that text is what the user reads and the next check compares with; a hidden one is not (decision 2026-11-11).
- A task runs on a schedule, a webhook or both (operator decision 2026-10-25). Each accepted event is an ordinary occurrence; later events wait in order while a run is open.

## Telegram and Discord

Code: `lib/server/telegram/`, and the run bridge and rules the connectors share in `lib/server/connectors/`.

- A Telegram message is the linked user's interactive personal run through the ordinary send handler; access is rechecked per message and delivery. The link belongs to the account (operator decision 2026-10-19): revoking all sessions, a password change or reset, deactivation or rejection (SCIM included) and disconnecting (settings, admin, `/unlink`) remove it, and disconnecting voids pending link codes; signing out of one browser does not. Approval buttons use the ordinary path. Telegram turns take the self-service tools, Skill saves and sub-agent management their chat takes on the web (operator decision 2026-11-16, replacing 2026-10-23: Telegram gets every web capability it can show). Each change card becomes a message with Undo where the card has it, and a proposal asks Confirm or Cancel without holding the turn, as on the web; a press counts once, only from the link's own account in its own chat, and sends the card's request through the same Settings route as the link's user (`lib/server/telegram/changes/`). Telegram turns and scheduled occurrences start no background sub-agents, but answer and stop those of their branch.
- Telegram turns have the Workspace like web chats (operator decision 2026-11-16, replacing the 2026-10-19 bot setting that was off by default and left a sub-agent unable to write its file): a turn asks for it whenever the installation offers it and the model calls tools, and files take its upload scope then (`connectorWorkspaceRequest` in `lib/server/connectors/turn.ts`). An old menu's Workspace button answers as expired.
- Tasks with Telegram notification send their results and files through a durable outbox and never repeat an ambiguous send. A chat answer of which nothing reached Telegram, its last send provably unsent, stays deliverable: the recovery sweeps send it, access checked again, once Telegram answers, until an hour after its run settled (2026-11-23: the host loses Telegram for minutes daily), and never resend an ambiguous one (`lib/server/telegram/bridge/delivery.ts`).
- Answers and task results carry no Sources list; a `[N]` citation links to its source (operator decision 2026-10-25).
- A Discord message is a run of the installation's service account through the ordinary send handler, one chat per Discord thread (owner decisions 2026-11-12). The server applies its rules whatever the body says (`lib/server/connectors/turn.ts`): Memory off (only a chat excluded from Memory), MCP unattended like a scheduled occurrence, foreground sub-agents only, no self-service or automation tools, computer or Deep research, and no per-user message limits, while budgets and the installation cap still apply. A Discord answer is never regenerated. In server channels and threads, the bot's own threads included, only a mention of the bot or its role, a Reply to the bot or a message starting with one of the installation's call names asks it; other talk only enters the next turn's context, and direct messages always ask (owner decision 2026-11-12, `lib/server/discord/bridge/triggers.ts`). Call names are administrator settings, never written in code.
- Discord turns have the Workspace like web chats (operator decision 2026-11-16, replacing the 2026-11-12 refusal): a turn asks for it whenever the installation offers it, and each thread's chat has its own. Nobody can take its browser over, so `browser_handoff` tells the agent to say what blocked it.
- A Discord voice message is transcribed only when it is the question or the message the question replies to, never history (operator decision 2026-11-16), as the service account and on its budgets; the transcription window counts per Discord author, because the one account stands for every member (`lib/server/discord/voice.ts`). Transcripts are never stored, so a recovered question is transcribed again.

## Follow-ups and continuation

- A follow-up adds user input to a running answer within its accepted bindings and budgets; delivery proves receipt, not obedience.
- Continuation into a new chat summarizes the active branch's text through the admitted System Model, without tools, attachments or Workspace inspection. An enabled Workspace may copy its project files unread into a private single-use seed.
- The new chat's first turn is the server's (`conversation_summary`), so answering it again authorizes no change.

## Background sub-agents

- One active run per thread (operator, 2026-10-29): only the main agent's run blocks sends, edits and branch switches; its Stop spares background sub-agents (foreground turns end with it); deleting stops them first, archiving refuses (`subagents_running`). Accepted risk: wake-up chains run until usage limits refuse.
- A callback wakes the main agent through the ordinary send as the owner, on the branch's latest turn. Wake-up turns and callbacks into a running answer are the server's, never the user's speech: they authorize nothing, and wake-up turns stay out of exports and shares (`lib/server/runs/subagentBackground/wakeUp.ts`).
- What an agent sends into a running answer adds below it and never rewrites it (operator decision 2026-11-05): a callback that came as the final answer streamed started it over, so a long answer became a short addition or an empty completion. Only the user's own follow-up starts the answer over, keeping the replaced text with it; an answer still empty after that fails as `model_answer_empty` (`lib/server/engine/loop.ts`).

## Research

Deep research has its own contract, loaded for research code: [Research](RESEARCH.md).

## Skills

- Skills grant no capabilities. Other users' Skills require approved revisions and audience authority, checked at admission. Turning Skills off keeps pins. Filtering never hides a required dependency (`lib/server/skills/catalogRelevanceAuthority.ts`).

## Search and documents

- Attachments do not disable selected Search; Search rules are in `agent_docs/PROVIDERS.md`.
- Required chat PDF work finishes before any other dispatch, and the preparation model only transcribes. A Workspace run may continue past a classified transcription failure with the verified original and an explicit unread-content notice; access, integrity and cancellation failures stay blocking.
- Transcription keeps visible text and meaningful visuals and never invents hidden values, causes or intent. Uncertain table rows, units and associations stay uncertain; numbers keep their exact decimals and are never converted.

## Tools and MCP

- Auto, Load all and Off are user choices, and Auto stays as it works today (operator decision 2026-10-23): it freezes the authorized catalog, `find_tools` is local, model-free search, and Skills arrive through their index and `load_skill`, so not every schema enters the context. An unusable server records a stable reason and the answer continues.
- Per-answer tool call and round limits are off by default, existing installations included; administrators may turn them on (operator decision 2026-10-26: agent tasks outgrow any count, and Workspace turns get an hour). An answer then ends at its tool time (`lib/server/runs/turnDeadline.ts`), Stop or a repeated call. When calls or tool time run out, one tool-free round names what could not be verified.
- Results too large for the context arrive as an excerpt with a reference the agent can read later, never silently truncated. Every result longer than a short excerpt is saved with that reference, so a compaction can leave it out and name where it lives (decision 2026-10-23). A long search result of several sources gives each source a share of its excerpt (2026-11-03): cut as one text's head and tail, three selected sources showed the model one and a half.
- Reading a tool result by reference checks only that the reader may read its chat, and never reruns the call.

## Your computer

- A chat may bind one of its owner's AIQSA Connect computers and a starting folder (operator decisions 2026-11-06). The composer sends the choice with every message; admission checks it, freezes it with the run and stores it as the chat's choice, and a message without the field runs without one. Regenerate and an Allow continuation keep the run's frozen computer. Only interactive personal and temporary chats get one: Assistant chats, Telegram, scheduled tasks, webhooks and wake-up turns never do, and the model is told so where the chat has one (`lib/server/runs/computerAdmission.ts`). The tool list never depends on whether the computer is online; its facts ride in the turn context.
- `computer_read` reads documents as the attachment parser's text and shows images only to a vision model whose route carries result images, only in the answer that read them, with no System Vision fallback; parsed text is cached only in the run's memory (operator decision 2026-11-07, `lib/server/tools/computerReadFiles.ts`).
- Commands, writes, edits and job stops are external effects: an unknown outcome stays unknown and is never re-sent, while reads retry. Background jobs end with their run (`run_ended`), which waits for an offline computer, and the device ends a job whose run has gone silent past a lease (`lib/server/connect/relay.ts`, `connect/internal/ops/executor.go`).
- `computer_attach_file` puts a file from the computer on the answer like a Workspace output (operator decision 2026-11-07). Only the main agent has it, since only its run is shown there; it retries like a read, and one call attaches at most one file (`lib/server/tools/computerAttachFile.ts`).

## Workspace

- Workspace is available in every chat whenever the installation offers it, so its tools ride on every request (accepted cost, operator decision 2026-10-20). The VM is not started per chat: it boots at the first call that needs code execution, may be prewarmed when that is cheap, and keeps the chat's files and browser (operator decision 2026-11-20): each agent's first browser command of a turn reopens the tabs it had open at the end of its last one, unless that command opens a page itself (then the summary lists them), so a page that acts when loaded never reloads unasked. A capability that needs no code execution, such as secrets, Skill instructions, MCP, Memory, search or images, never requires the VM (operator decision 2026-10-22).
- All of a chat's runs share one Workspace (operator decision 2026-10-29, `lib/server/workspace/attachments.ts`); Reset and continuation wait for sub-agents; only main-agent runs export downloads.
- Each terminal path retires its run's authority: the last attached run stops the VM; an earlier one provably stops its processes (`lib/server/workspace/agentProcessGuest.ts`), or else the VM, interrupting all attached runs. Successful turns leave no background processes. Completion requires closed output obligations; an export failure keeps the answer. Path escapes fail closed; links and special files are skipped visibly. A dead run whose stop cannot be proven is settled only behind a fenced Workspace (`workspace_stop_unproven`, `lib/server/runs/subagentBackground/recovery.ts`).
- `browser_handoff` (operator decisions 2026-10-26 and 2026-11-20) waits for Done or Cancel until two minutes after the user's last sign in the live browser, ten minutes at most and within the tool time, returning only outcome and page; Stop and the deadline end it. No sign at all returns `not_answered`, otherwise `timed_out`: a user who has not come in two minutes will not come, while 41% of those who came needed longer (`lib/server/workspace/browserLive.ts`). A follow-up the user writes into the answer ends the wait of the request whose card is shown, the main agent's or a foreground sub-agent's, at once as `replied`, saving nothing, and the agent acts on that message next (operator decision 2026-11-20: an OTP sent in the chat waited out the card and expired). The signal is an in-process hint (`lib/server/runs/runFollowupRegistry.ts`), so a missed one ends the wait as before. Each agent's handoff holds only its tab, shown oldest first. Telegram, Discord and unattended runs refuse every agent (`browser_handoff_unavailable`) but still pass checks themselves; a Telegram agent asks in the chat for what the site needs and types it from the next message. An unattended occurrence that asked fails as `browser_sign_in_required` with the host from its agent's own step lines; Sign in again there, on an answer whose sign-in handoff ended without Done and on a saved sign-in sends a server-written turn (`browser_sign_in_request`, `lib/contracts/browserSignIn.ts`) that is never the user's speech and authorizes only opening that site and handing it over. Any turn the server wrote (a wake-up, a scheduled prompt, a Sign in again request, a continued chat's summary prompt, the continuation after an MCP Allow of such a turn) saves or replaces a browser sign-in only for a site whose `sign_in` handoff the user finished with Done in that run, from a file holding that site alone, and any other save from it is refused as `browser_session_server_turn`, keeping the saved one; the refused bytes stay refused when a later run of the chat collects them from the disk (operator decision 2026-11-23, `lib/server/workspace/secrets/browserSignInAuthority.ts`). Accepted risks (operator decision 2026-11-23): a run of the user's own that settles while a turn the server wrote shares the chat's browser can save that turn's change, because the chat's browser profile is shared, and an imported chat's turns keep only the restriction its export recorded (scheduled prompts, approval continuations and version 1 exports come back as ordinary turns), since only the user's own explicit Regenerate can act on them.
- Vision-capable models read chat images natively, and verified ones view Workspace images (`view_workspace_image`, operator decision 2026-10-26), only in the answer that viewed them. Other images reach models only through admitted System Vision, with untrusted results.
