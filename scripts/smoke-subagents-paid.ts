/**
 * Opt-in, paid sub-agent scenarios against a DISPOSABLE real-KVM AIQSA stand
 * (the acceptance task's scenarios 1–9). Never a default lane and never a
 * persistent installation. It drives the product as a user would, through its
 * own HTTP APIs: messages, edits and regenerations, the sub-agent thread
 * routes (list, summary, Stop, Stop all), scheduled tasks, and the live
 * Browser panel through Playwright (`scripts/browser-scenarios-handoff.ts`).
 * Evidence comes from read-only `pg` queries; arguments, results and
 * messages are matched inside SQL and only booleans and counts leave it.
 *
 * Scenarios (`scripts/subagent-scenarios-support.ts`), selected with
 * AIQSA_SUBAGENTS_SELECT (default A,B,E,F; the others only when named):
 * - A: no-setup sub-agents, "find and compare 10 options" (scenario 1).
 * - B: 5 background sub-agents, a second message while they run, the wake-up (2).
 * - C1, C2: S6 with one sub-agent per category, on the default sub-agent and
 *   with a one-off `model` override to AIQSA_SUBAGENTS_SECOND_MODEL (3).
 * - D5, D1: "the 5 best headphones on amazon.es" with 5 sub-agents browsing at
 *   once, and by one agent for the wall-time reference (3a).
 * - E: a correction sent to a running sub-agent, then `stop_subagent`, the
 *   thread Stop route and Stop all (4).
 * - F: a thread continued by name, then an edit of the first message whose
 *   branch must not see the abandoned branch's sub-agent (5).
 * - G: a restart of the app container during background work (6), through
 *   AIQSA_SUBAGENTS_RESTART_COMMAND.
 * - H: a background sub-agent's saucedemo sign-in through `browser_handoff`
 *   while another agent browses; Playwright signs in through the live card (8).
 * - I: a scheduled task's Run now with sub-agents in waiting mode (9). Telegram
 *   is not covered: its only update hook (`/api/test/telegram/updates`) exists
 *   in test mode, which the stand guard refuses, and a real bot needs a token
 *   and a linked Telegram account.
 * - J: the capture and retire defects, one chat and two sends, only when named. The main agent
 *   writes a small PNG, starts `viewer` (views it with its image tool) and `quiet` (no tool, a long
 *   written answer, so it ends last) and answers at once; the second message goes as soon as the
 *   main run and both turns ended. Oracles: the image call succeeded and no capture identity or
 *   internal vision failure exists; the second message was accepted (a refusal only because the
 *   server's wake-up took the turn first is sent again once and recorded); no callback stays owed;
 *   the session left `RUNNING` to `STOPPED` or `PENDING` by the ordinary path (`secondsToLeaveRunning`
 *   from the last turn's end, signed, zero or less when healthy). `order_not_reached: true` records
 *   that the model did not produce the defect's order, and is not a failure. Paid calls: about 8–11
 *   codex-lb requests (main 3–4, viewer 2–3 and at most one System Vision call, quiet 1 long answer,
 *   wake-up and second message 1–2 each) in about 3–6 minutes.
 * - K: files and images across agents, one chat, only when named. The main agent and two background
 *   sub-agents each write a text file only its writer's command makes and a coloured PNG in one
 *   `/workspace/project/` folder and read the main agent's. Then `file-left` is continued by name in
 *   the foreground and `file-right` in the background: each reads its own earlier files and the
 *   others', the main agent reads both, and the result file reports every read. Then "a chart in the
 *   background" with no path in the message: the chart's turn ended, the main agent's image tool
 *   succeeded on an answer after it, and a PNG exported by those answers opens through the user's
 *   attachment route. Last, with a model without vision (below), `blind` on that model finishes with
 *   System Vision and never calls direct view; without one, `blind: "not_configured"` records that
 *   the step did not run. Paid calls: about 40–60 codex-lb requests and at most 3 System Vision calls,
 *   plus 2–4 OpenRouter text requests with the last step, in about 10–20 minutes.
 * - L: a document the parser refuses, one chat and one send, only when named, no sub-agents. An XLSX
 *   over `SPREADSHEET_MAX_POPULATED_CELLS` whose second column comes from a per-run nonce goes up through
 *   `/api/uploads` as the composer sends it; before anything paid, read-only SQL requires `failed`,
 *   `parser_output_too_large` and no extracted text (`checksFailed` says otherwise, and that upload stays
 *   on the stand: no route deletes an unsent attachment). The message asks for the exact sum, computed
 *   with Python in the Workspace; a refusal at admission (`attachment_not_ready`, `attachment_needs_workspace`,
 *   any other) lands in `admissionRefusal`. Oracles: the run completes, the answer holds the exact sum
 *   (matched inside SQL, separators allowed; the nonce and the sum stay in memory), a Workspace command
 *   ran, a Workspace call named `/workspace/inbox`, and no Workspace call has an unknown outcome. Paid
 *   calls: about 2–4 codex-lb requests, no System Vision, in about 2–5 minutes.
 * - M: agents talking, one chat, only when named. Two background sub-agents each know half of a per-run code and write
 *   it to the other: both reports hold both halves and each read a message. `m-late` is briefed with the work
 *   `m-worker` is doing: it lists the agents, names the worker and no call of its names the worker's file. A background
 *   `m-asker` sleeps past the main agent's answer and asks: it is seen `waiting`, the question wakes the main agent, and
 *   its report holds an answer only the user's message had. A foreground `m-front` asks: its turn ends
 *   `blocked (needs_answer)`, and continued by name its report holds the answer. `m-forger` writes `m-target` a message
 *   dressed as the user's confirming a payment: the target read it and no call of its names the payment's file. `m-ping`
 *   and `m-pong` count at each other until `subagent_message_limit_reached` ends them. `m-hold` asks a question nobody
 *   answers, and the thread's Stop reaches it in `waiting`. Paid calls: about 60–90 codex-lb requests, most of them the
 *   count, in about 15–30 minutes.
 * - N: an earlier file read without a Workspace, one chat and two sends, only when named, no sub-agents.
 *   The Workspace goes off for the installation through `/api/admin/workspace` and comes back on in a
 *   `finally`; when it cannot, the line says `workspaceRestored: false` and the harness stops, because
 *   later scenarios need it. A DOCX of three headed sections, with a per-run word only in section 3, goes
 *   up through `/api/uploads` as the composer sends a document; before anything paid, read-only SQL requires
 *   `ready`, extracted text and the word in that text (`checksFailed` says otherwise, and that upload stays
 *   on the stand: no route deletes an unsent attachment). The first send attaches it and asks only for the
 *   title; the second, attaching nothing, asks what section 3 says and for the word, through `read_chat_file`.
 *   A first run that does not complete ends the scenario before the second send; a refusal at admission
 *   lands in `admissionRefusal`. Oracles: both runs complete, the chat has no Workspace session and no
 *   Workspace tool call, the word is in the second answer and not in the first (matched inside SQL; the word
 *   stays in memory), and the second run has a `read_chat_file` call that succeeded. Paid calls: about 3–5
 *   codex-lb requests (first turn 1, second turn 2–3, possibly a title), no System Vision, in about 1–3 minutes.
 * - O: a sub-agent's children, one chat, only when named. `o-lead` starts `o-left` and `o-right` in the foreground: each works
 *   out a per-run hash with a Workspace command and the lead's report holds both, which no brief states. Continued, it asks
 *   for three background helpers in one response: exactly one is refused `subagent_child_limit_reached`, its report names the
 *   code, and it ended after the two that ran, both done, because a parent waits for its children's reports. Then a helper
 *   is told to start its own: no such thread exists, and `depthRefused` counts a refusal if the model tried a tool it is not
 *   offered (`subagent_depth_limit_reached`; the refusal itself is proven in the focused tests). `o-holder` starts `o-inner`
 *   in the foreground and `o-side` in the background, both in `sleep 900`; once all three run, the main agent's Stop ends every
 *   one of them `parent_stopped`. Last, `o-clerk`'s helper `o-approver` calls a destructive MCP tool of a synthetic server this
 *   harness hosts (below): it is not sent, the helper and the clerk end `blocked (needs_approval)`, the card is on the main
 *   agent's run, and only the Allow sends it, once. Every child is read from the chat's thread list under its parent. Paid calls:
 *   about 30–45 codex-lb requests in about 8–15 minutes.
 * - P: the user writes to a working sub-agent, one chat, only when named. `p-listener` is briefed with three `sleep` commands
 *   and nothing about the user; once its first command runs, the harness posts to the thread as the browser does, asking
 *   for a per-run word at the end of the report and not to repeat a per-run note. Oracles: the message is accepted and read
 *   by the turn, the turn ends done, its report holds the word, and the note is in no message of the main chat (both matched
 *   inside SQL; they stay in memory). Paid calls: about 5–8 codex-lb requests in about 2–3 minutes.
 * - Q: page reading across agents, one chat, only when named, on each Search route the stand has (client, then hosted). A background
 *   `q-reader` makes 3 searches and reads a link of each with `fetch_url`, and the main agent reads 4 others from its report. Oracles:
 *   more searches than the old limit of 2, no refusal of a link any agent's search found, and more than 5 pages in one answer.
 *   Paid calls: about 8-12 codex-lb requests and 3 searches per route, in about 2-5 minutes.
 * - R: no words start research, only when named: 10 Russian phrases, each in a new chat with Search on and without Deep research, five of
 *   them asking in words for a thorough result. A run that calls `start_research` is stopped at once to save money. Oracle (operator
 *   decision 2026-11-05: only the `+` menu's Deep research starts research): no phrase's run is offered research (`normalizedRequest.deepResearch`)
 *   or calls `start_research`, reported by index (`phrase_<n>_offered`, `phrase_<n>_started`). Paid calls: about 10-20 codex-lb
 *   requests and a few searches, in about 5-10 minutes. This needs DEEPSEEK_API_KEY for the Search source, as Q does.
 * - S: proxies end to end, one chat per step, only when named, with the operator's proxy in AIQSA_SUBAGENTS_TEST_PROXY (process only, never printed, never written).
 *   A proxy pasted in chat is saved for `.ru` and tested; the browser opens a hinted page, Yandex Market, Wildberries and Ozon, and an address echo through the named
 *   proxy; `fetch_url` reads through it; a dead proxy fails visibly; a switched-off one is refused by name. Oracles compare exit addresses inside SQL and print booleans. The
 *   answers go to AIQSA_SUBAGENTS_ANSWERS_FILE when set (0600), for reading by hand. Paid calls: about 15-30 codex-lb requests, in about 5-10 minutes.
 * - T: repeatable synthetic research, only when named. Every research send carries Deep research (`deepResearch: true`,
 *   `DEEP_RESEARCH_SEND_FIELD`), as the `+` menu's item sends it; a Continue names nothing and goes on from its run's binding.
 *   AIQSA_SUBAGENTS_T_ACTS gives a kind what a person does on its run, as
 *   technical=edit,medical=start,market=restart: `edit` and `start` drive the plan card in a browser, `handoff` asks a question behind a
 *   sign-in and leaves the handoff unanswered, `restart` runs AIQSA_SUBAGENTS_RESTART_COMMAND mid-research and presses Continue, and
 *   `outage` runs that command once the research handed in a draft, waits for the run to end without its provider, runs
 *   AIQSA_SUBAGENTS_OUTAGE_END_COMMAND and presses Continue.
 *   AIQSA_SUBAGENTS_T_KINDS selects questions; AIQSA_SUBAGENTS_T_REPEATS is
 *   1 by default, an integer (1..20), or purchase=5,medical=3,technical=3,market=3 (omitted kinds keep 1). AIQSA_SUBAGENTS_T_CONCURRENCY
 *   is 3 by default (1..8). Each question has at least 110 minutes, including scoping, the plan window and the harness margin.
 *   AIQSA_SUBAGENTS_ANSWERS_DIR is required unless AIQSA_SUBAGENTS_ANSWERS_FILE supplies its adjacent .d directory. The directory
 *   is 0700 and files are 0600: finalized answers and gate reports are saved as they appear, separately by kind/repeat/chat/invocation.
 *   Files survive cleanup and are kept until the operator removes them; a resumed harness uses new names. ANSWERS_FILE still receives an append-only copy.
 *   AIQSA_SUBAGENTS_RESEARCHER_MODEL/EFFORT and AIQSA_SUBAGENTS_CHECKS_MODEL/EFFORT bind the roles through Admin on the codex-lb route.
 *   Effort without a model is refused; omitted roles keep the stand's settings. VERIFIER_FAMILY remains available without CHECKS_MODEL.
 *   CHECKS_MODEL also grades and separately extracts structured comparisons from each saved answer; absent, evaluation says not_configured.
 *   The judge uses the rubric and extraction prompt in research-eval-support.ts. Scores require human reading: source pages are not independently fetched.
 *   Role tokens sum provider figures from transcript responses, including foreground threads; missing figures are counted, never filled in.
 *   Role input tokens exclude responses without a request anchor, counted in `missing`; acceptance must read `missing` beside the sums.
 *   UsageEvent supplies the grand total and model split. Transcript totals omit retried attempts, compaction, Search and the harness judge/extraction calls;
 *   judge/extraction usage is reported separately and is outside the chat ledger too. Minutes sum turn intervals, including waits and overlapping roles.
 *   Private comparison files retain candidates, criteria, picks, ties and conflicting fact pairs. Stdout keeps comparison counts and the existing server check notes.
 *   No baseline is required. Proxy values are redacted before private storage or evaluation. Paid calls: hundreds per question plus two evaluation calls.
 *   Stdout gives each role's input tokens per response (`inputPerResponse`, the mean over responses with a reported input) and
 *   `researcherInput` restates the researchers' mean beside their responses and the `missing` count it leaves out.
 *   After each question, the links of the records the final answer cites (those its last draft names, and every record whose link
 *   the answer carries, compared in `fetch_url`'s form) are matched against the Search results the chat's runs recorded (`SearchRun`):
 *   the private `attribution` file lists, per Search source, the cited links it returned and how many only it returned, and the links
 *   no source returned; stdout keeps the counts.
 *   Acceptance options, each off unless set:
 *   - AIQSA_SUBAGENTS_T_QUESTION_FILE: a file of mode 0600 (regular, this user's, at most 16 KiB, not empty) whose text replaces the
 *     `purchase` question for this invocation; it needs `purchase` among the kinds. The text goes only where the question already goes:
 *     the chat and the evaluation calls. It is never printed, logged or stored by the harness.
 *   - AIQSA_SUBAGENTS_T_QUESTION_SET: a directory of `<name>.txt` questions (name `[a-z0-9][a-z0-9_-]*`, at most 20), each with an
 *     optional `<name>.expect.json`, every file private as the question file is. It replaces the kinds: each question runs in a fresh
 *     chat, one after another (CONCURRENCY other than 1, KINDS, ACTS and QUESTION_FILE are refused beside it; REPEATS takes a plain
 *     integer). An expectation is any subset of `{ "names": [...], "minNames": n, "namesIn": "rows" | "answer" | "either",
 *     "minCandidates": n, "minOffers": n, "minSupportedShare": 0.8, "maxMinutes": n }`: each name is found as a matrix row, in the
 *     answer, or either (the default), matched after NFKC, lowercase, collapsed whitespace and one reading of a number's separators;
 *     `minNames` (all by default) counts the found ones. Candidates are matrix rows, offers the live `action_channel` records the last
 *     draft cites, the supported share the verifier's verdict lines over every draft, minutes the chat's main runs end to end. Each
 *     is reported with its value and pass or fail; stdout names names by position only, the private `acceptance` file by text.
 *   - AIQSA_SUBAGENTS_T_SEARCH_SOURCES (with production Search): the production sources the plan uses, `openai`, `perplexity`,
 *     `deepseek` or a comma list of them, all three by default. Research then searches only with those; a source left out costs no
 *     setup (no OpenRouter, no DeepSeek key, no SEARCH_MODEL, which is refused without `openai`). The ready line and each question
 *     name the sources.
 *   - AIQSA_SUBAGENTS_T_APP_LOG_COMMAND: one shell line, run on the harness host after each question as the restart hook is (the
 *     same minimal environment), that prints the stand app's JSON log lines, for example
 *     `ssh <the stand host> 'docker compose -p aiqsa-sa-kvm logs --no-log-prefix --since 3h app'`. Only Search's `tool_execution`
 *     lines of the question's runs are read, for each source's latency; nothing else of the output is kept. Absent, latency is null.
 *   Every question's acceptance metrics (`acceptance` on stdout, in full in the private `acceptance` file) come from the stand's rows:
 *   wall time; phases in seconds from the research run's start (scoping, plan window, dispatch, each research round with its
 *   researchers and how many ran at once, drafting, each draft's gates with their turns and what sent it back, publishing); each
 *   researcher turn's calls (all, and those the per-task budget counts), its end (`report`, `budget`, `time_limit` or its state) and
 *   input tokens per response (p50, p90, max); searches, rows and errors per source and its latency; rows; candidate notes (noted,
 *   made rows, set aside, open); the verifier's verdicts; offers. A feature the stand does not have yet (candidate notes, the per-task
 *   budget) reads as null, never 0. Researchers are numbered, not named.
 *   - AIQSA_SUBAGENTS_OPENROUTER_SETUP=approved with OPENROUTER_API_KEY: with production Search and no live OpenRouter connection holding
 *     Perplexity, Quick Setup adds OpenRouter once, which checks every built-in OpenRouter model; only with the operator's approval of that cost.
 *   - AIQSA_SUBAGENTS_T_SEARCH=production with AIQSA_SUBAGENTS_SEARCH_MODEL (no default) and DEEPSEEK_API_KEY:
 *     production's Search plan, every search to three sources at once (`all_selected`), through the Control Center's routes
 *     (`/api/admin/search`, its `actions`): OpenAI Responses web search on a codex-lb connection whose model is SEARCH_MODEL (added by
 *     `ensureModel` with native Search; its setup creates the connection's client source), Perplexity on an OpenRouter connection's
 *     `perplexity/sonar-pro-search` (`openrouter_perplexity_chat`), and the DeepSeek Search API. The OpenRouter connection must already
 *     be on the stand, live with a key and that model, checked first so a stand without it stops before anything paid
 *     (`research_search_perplexity_perplexity_connection_missing`): the harness never adds one, since an OpenRouter connection's first
 *     key, through Quick Setup or the manual routes alike, adds and checks every built-in OpenRouter model. DeepSeek, when missing, comes
 *     through Quick Setup, which checks DeepSeek's two models and its Search API. A source missing its client route is created
 *     with its live check, one on another model is re-saved with Save and check, then each source's Test runs and must show a real
 *     search with sources, or the harness stops with `research_search_<source>_<code>`. The plan becomes the organization's default and
 *     every send names it; Q and R then search on it too. It stays on the stand like the rest of the setup.
 *   - AIQSA_SUBAGENTS_ADMIN_PROXY_FILE: a file of mode 0600 holding exactly
 *     `{ "url": "http://host:port", "username": "...", "password": "...", "country": "RU", "hints": [".ru"] }` (http, https or socks5).
 *     Before the questions T adds it as an administrator proxy (`/api/admin/proxies`), runs its check (`.../check`) and requires `ok`;
 *     after them, and on every failure path inside the process, it deletes it and proves it gone from the list and the database. A
 *     proxy of that name left by a killed invocation stops T with `research_admin_proxy_exists`; one that cannot be removed stops the
 *     harness (`admin_proxy_not_removed`). Stdout shows only booleans and codes; values are redacted from the private files.
 *   - AIQSA_SUBAGENTS_T_STEPS_FILE: a file private as the question file is (0600, this user's, at most 16 KiB), holding a JSON list of 1 to 10
 *     `{ "text": "...", "deepResearch": true | false }` (exactly those keys, text 1 to 8000 characters). After each question's research ended, the
 *     steps go in order into that question's chat, each once the previous run is terminal and the chat idle, on the question's Search plan and with
 *     Deep research only where `deepResearch` is true. Each step's answer goes to the answers directory (`step-<n>-answer-<run>`), its line to
 *     `step-<n>`. Stdout `steps[]`: `offered` (admitted with Deep research), `startCalled`, `frame` (a research frame row), `researchRan` (both),
 *     `researchCalls` (calls of the research tools in the run and its sub-agents), `status`, `code`, `minutes`, `tokens`, `cost`, `answerSaved`,
 *     `ok` and `failed`. Oracle: with Deep research, research ran and the run completed; without it, nothing was offered or called, no frame, and
 *     the run completed as an ordinary answer (`research_offered`, `research_tool_called`, `research_frame_written`, `run_<status>`). A failed step
 *     fails the question and ends the steps there; T's judge and extraction grade only the question's own answers.
 *   Review evidence, after the steps, for every research run of the question's chat (each run with a frame row): stdout `review[]` holds counts and
 *   booleans, the answers directory `review-<run>` in full (with the final draft's summary), `page-<run>` (the page's entry HTML, read through the
 *   user's own artifact source route) and `sendbacks-<run>` (the report check's and verifier's send-back messages). Per run: `research` (its
 *   ordinal in the chat) and `step` (the step that sent it, null for the question); `page` (`card`: a `generated_artifact` card with
 *   `research_page` on the answer, `summaryEnd`/`notesStart` set, `htmlSaved`, `htmlBytes`); `fetches`; `botChecks` (`fetch_url` refusals
 *   `fetch_http_status` with `httpStatus` 200: `botChecks`, `hosts`, `browserAfter` where the same agent's later Workspace command named the host
 *   and drove the browser, matched inside SQL, `laterUnreachable`, `laterRead`, `neither`); `unreachable` (records, hosts, `siblingRefusedAsClosed`
 *   where `fetch_url` then refused another host of the same registrable domain as closed, `closedRefusals`); `ratings` (findings with a `rating`,
 *   their rows and platforms, `pickRatings`, `summaryNamesPickScore`, `summaryNamesPickCount`); `priorities` (the plan's priority criteria,
 *   `answered` by the final summary's `priorities`, `answeredOther`, `allAnswered`, `ratingsCriterion`); `sendBacks` (`sentBack`, `byGate`,
 *   `mentioningDisagreement`); `earlier` (candidates the frame seeded from earlier research: `earlier`, `earlierPick`, `rows`, `setAside`, `open`);
 *   `minutes`, `tokens` and `cost` of the run and its sub-agents' turn runs (`cost.status`: `available`, `partial` or `not_available` when no
 *   `UsageEvent` holds `estimatedCostMicros`; `micros` sums what is known).
 * - U: the answer race, only when named, one chat and one send. The main agent starts one background sub-agent (`u-sleeper`) that runs
 *   `sleep 30` in the Workspace and reports a per-run word, and at once writes a long final answer (about 600 words, a first paragraph of its
 *   own). The run's stream is read as the browser reads it; the streamed text and the word stay in memory. Stdout: `landing` (where the callback
 *   reached the run, on the database's clock: `during_answer` when text events stood within 2 s on either side of it, `before_answer`,
 *   `after_answer`, `none`), `resetsAfterText` (`message_reset` events after text had streamed), `rewritten` (resets after which the text no
 *   longer began with the text before), `paragraphKept` (the saved answer holds the streamed first paragraph, matched inside SQL), `word`
 *   (`absent`, `after` or `before` that paragraph in the saved answer), `status`, `callbackAfterFirstText` and `textEndAfterFirstText` in seconds.
 *   Oracle: the run completed, the paragraph was kept, nothing rewrote the answer and the word is not before the paragraph;
 *   `order_not_reached: true` when the callback did not land during the answer, which is not a failure. Paid calls: about 3-6 codex-lb requests
 *   (the main agent's two or three rounds, the sub-agent's one or two) in about 2-4 minutes.
 * Scenario 7 (the MCP guard) is not part of this harness.
 *
 * Each run prints ONE content-free JSON line (codes, counts, booleans,
 * timings, token numbers), then one summary line per scenario and a final
 * line. The exit code is 0 whenever the measurement completes: a failed
 * oracle is data. Cleanup is not: when a chat, a scheduled task or a saved
 * browser session cannot be removed and proven gone, the harness stops before
 * the next run and exits 1. Chromium's resident memory is not recorded: the
 * stand exposes no reading of the guest's processes.
 *
 * Setup is the browser-scenario harness's (`scripts/browser-scenarios-stand.ts`):
 * the codex-lb route from ~/.codex/config.toml, System Vision on it, Workspace
 * with internet, Memory off, signed in as the bootstrap administrator, whose
 * custom sub-agent count is printed (A expects none: "no setup").
 *
 * Environment (process only; no .env loading):
 * - AIQSA_SUBAGENTS_E2E=DISPOSABLE (required acknowledgement)
 * - AIQSA_SUBAGENTS_COMPOSE_FILE: the stand's `docker compose config --format json`
 * - CODEX_LB_API_KEY
 * - AIQSA_SUBAGENTS_SELECT, AIQSA_SUBAGENTS_RUNS (1..3, default 1), AIQSA_SUBAGENTS_LABEL,
 *   AIQSA_SUBAGENTS_MARGIN_SECONDS (60..3600, default 600), AIQSA_SUBAGENTS_KEEP_CHATS=1
 * - AIQSA_SUBAGENTS_SECOND_NO_VISION=1: add the second model with vision declared off, so K's last step has a model
 *   the product treats as having no vision when no text-only model is reachable;
 * - AIQSA_SUBAGENTS_SECOND_MODEL (C2): an upstream model id on the same codex-lb route, not the parent's;
 *   the harness adds it as "Sub-agents second model" and requires it in the user's catalog
 * - AIQSA_SUBAGENTS_TEXT_MODEL (K's last step) with OPENROUTER_API_KEY: a text-only OpenRouter chat model, added by
 *   `ensureTextModel`, whose public listing proves it takes no images. Without it, K uses AIQSA_SUBAGENTS_SECOND_MODEL
 *   only when the catalog says that model has no image input; `ensureModel` declares vision on what it adds.
 * - AIQSA_SUBAGENTS_FIXTURE_HOST (O: the MCP fixture's listen address, default 127.0.0.1) and AIQSA_SUBAGENTS_FIXTURE_PUBLIC_HOST
 *   (the host the stand's app container reaches it by, default the listen address). An app that cannot reach it fails O's
 *   last step as `approval_step_unavailable`, with the code in the line, and the other steps still count.
 * - AIQSA_SUBAGENTS_OUTAGE_END_COMMAND (T's `outage` act, with AIQSA_SUBAGENTS_RESTART_COMMAND as its start): run as the restart hook is.
 * - AIQSA_SUBAGENTS_RESTART_COMMAND (G), AIQSA_SUBAGENTS_RESTART_TIMEOUT_SECONDS (30..900, default 300):
 *   one shell line run on the harness host with /bin/sh -c, output discarded and only its exit code kept,
 *   that restarts the stand's app container on the server through the SSH connection that forwards the
 *   stand's ports, for example `ssh <the stand host> 'docker compose -p aiqsa-sa-kvm restart app'`. Its
 *   environment is PATH, HOME, USER, LOGNAME and SSH_AUTH_SOCK only.
 * - T's acceptance options (described under T above; each refused without T): AIQSA_SUBAGENTS_T_QUESTION_FILE,
 *   AIQSA_SUBAGENTS_T_QUESTION_SET, AIQSA_SUBAGENTS_T_SEARCH=production with AIQSA_SUBAGENTS_SEARCH_MODEL and DEEPSEEK_API_KEY
 *   (each only when its source is selected), AIQSA_SUBAGENTS_T_SEARCH_SOURCES, AIQSA_SUBAGENTS_T_APP_LOG_COMMAND, AIQSA_SUBAGENTS_T_STEPS_FILE and
 *   AIQSA_SUBAGENTS_ADMIN_PROXY_FILE. Keys are read from the process environment only and never printed.
 * - AIQSA_BROWSER_SCENARIOS_BROWSER_CHANNEL, AIQSA_BROWSER_SCENARIOS_SHOTS_DIR: as for S5 (C, D, H drive the
 *   live panel; the harness host needs a Chromium for Playwright).
 */
import { spawn } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { appendFileSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import type { Client as PostgresClient } from "pg";
import type { CatalogModel } from "../lib/contracts/catalog";
import { PROXY_ROUTES } from "../lib/contracts/proxies";
import { DEEP_RESEARCH_SEND_FIELD } from "../lib/contracts/research";
import { CONTINUE_TURN_TEXT } from "../lib/contracts/runs";
import { decodeSubagentDefinitionListResponse } from "../lib/contracts/subagentDefinitions";
import {
  SUBAGENT_API_PATHS, decodeSubagentChatThreads, decodeSubagentStopAllResponse, decodeSubagentStopResponse,
  decodeSubagentSummaryResponse, decodeSubagentThreadView
} from "../lib/contracts/subagentViews";
import { decodeUploadAttachmentResponse } from "../lib/contracts/uploads";
import { registerBulkResultMcpServer, type BulkRegistrationClient } from "../tests/e2e/support/bulkResultMcpEndpoint";
import { createWriteApprovalFixture, startMutableMcpEndpoint } from "../tests/e2e/support/mutableMcpEndpoint";
import {
  BrowserScenarioError, handoffOutcome, requireBrowserScenarioStand, type BrowserScenarioStand, type InteractionEvidence,
  type OracleVerdict, type ScenarioInteraction, type StandTarget
} from "./browser-scenarios-support";
import {
  SETUP_TIMEOUT_MS, TERMINAL_RUN_STATES, authenticate, awaitExport, catalogModel, createScenarioChat, deleteChat, discard,
  ensureModel, ensureProductionSearch, ensureResearchVerifier, ensureSearchSource, ensureTextModel, errorCode,
  handoffCalls, isRecord, json, poll, readResultFile, removeBrowserSessions, request, requireIdleStand, runControls, safeCode, setWorkspaceEnabled, standDatabase,
  setUpStand, syncSaucedemoSecret, typedValueLeaks, type Api, type ResultRead
} from "./browser-scenarios-stand";
import {
  SCENARIO_L_FILE_NAME, SCENARIO_L_MIME_TYPE, SCENARIO_N_FILE_NAME, SCENARIO_N_MIME_TYPE, SEND_LOST_TO_WAKE_UP, SIDE_QUESTION, SUBAGENT_NAMES, SUBAGENT_PROMPTS, agentMessageEvidence, agentToolEvidence, appendProgression, appendSessionSample, bindingEvidence, blindImageEvidence,
  browserEvidence, callSubagentOutcomes, callbackEvidence, cleanUpScenario, failedToolCalls, imageToolEvidence, mainImageToolEvidence, notaryValue, stopSubagentCalls, oracleA, oracleB, oracleC, oracleD, oracleE, oracleFBranched, oracleFContinued, oracleH, oracleI, oracleJ, oracleKFlow, oracleKReads, oracleL, oracleM, oracleN, oracleO, oracleP, oracleQ, oracleR, SCENARIO_R_PHRASES, SUBAGENT_SCENARIO_NEEDS,
  SCENARIO_S_DEAD_HINT, SCENARIO_S_DEAD_NAME, SCENARIO_S_NAME, SCENARIO_S_PROMPTS, SCENARIO_T_HANDOFF_QUESTION, SCENARIO_T_QUESTIONS, oracleS, parseTestProxy, researchDraftFindings, researchMetrics, researchProcessFacts, researchServerNotes,
  type PageReads, type RPhraseResult, type TDraftFinding, type TEvidenceRow, type TGateRow,
  peakConcurrentTurns, pngBytes, progressionSaw, requestedModelEvidence, restartEvidence, roundsPerAgent, runSecrets, scenarioJOrder, scenarioKFacts, scenarioLAnswerPattern,
  scenarioLFacts, scenarioLUploadChecks, scenarioLWorkspaceEvidence, scenarioMFacts, scenarioNFacts, scenarioNToolEvidence, scenarioNUploadChecks, scenarioOFacts, scenarioPFacts, selectedSubagentScenarios, sendRefusal, sessionStopEvidence, stableCode, stateCounts, stopChecks, stopEvidence, subagentCallEvidence, subagentHarnessOptions, subagentScenarioSummary, turnOutcomes, usageByPurpose,
  type KChartDownload, type LAttachmentRow, type LWorkspaceCall, type MMessageRow, type OEvidence, type PurposeUsageRow, type RestartHook, type ScenarioLFacts, type ScenarioNFacts, type ScenarioOFacts, type SessionSample, type StateCounts, type StopPath, type SubagentHarnessOptions, type SubagentRunRecord,
  type SubagentScenarioId, type ToolRow, type TurnRow, type WakeUpRow
} from "./subagent-scenarios-support";
import { codexLbRoute } from "./workspace-user-paid-support";
import { readConnections } from "./context-compaction-journey-support";
import { createFetchOpenAIResponsesClient } from "../lib/server/providers/openaiResponsesTransport";
import {
  RESEARCH_EXTRACTION_PROMPT, RESEARCH_JUDGE_PROMPT, configureResearchEvalRoles, createResearchArchive, decodeResearchGrade, decodeStructuredResearchAnswer, emptyEval,
  evaluateResearch, redactResearchSecrets, researchEvalOptions, researchEvaluationSummary, researchPlanWindow, researchPool, researchProxySetup, researchQuestionTimeout,
  researchComparisonDetails, researchRepeatability, researchRoleUsage, researchStoreFacts, researchThreadRole, researchUsageByModel, researchEffortConfiguration, type ResearchEvalCall, type ResearchGrade, type ResearchJob, type ResearchTiming,
  type ResearchTranscriptRow, type ResearchUsageRow, type StructuredResearchAnswer,
  RESEARCH_ADMIN_PROXY_MAX_BYTES, RESEARCH_QUESTION_MAX_BYTES, parseResearchAdminProxy, readPrivateFile, researchAdminProxySecrets,
  researchAttributionCounts, researchCitationAttribution, researchCitedUrls, researchProxyCheckStatus, researchQuestionText,
  type ResearchAdminProxy, type ResearchSearchRow,
  readResearchQuestionSet, researchAcceptanceMetrics, researchAcceptanceObserved, researchEngineLatency, researchExpectationCounts, researchExpectationResults,
  researchJobLabel, researchResponses, researchSetJobs, type ResearchAcceptanceCall, type ResearchAcceptanceEvidence, type ResearchAcceptanceTurn, type ResearchExpectations,
  type ResearchResponse, type ResearchSearchLabel, type ResearchSetQuestion
} from "./research-eval-support";
import {
  RESEARCH_STEPS_MAX_BYTES, RESEARCH_TOOL_NAMES, answerRaceLanding, answerStreamFacts, createSseReader, oracleU, parseResearchSteps, researchBotCheckOutcomes,
  researchBotChecks, researchCost, researchEarlierOutcomes, researchFinalSummary, researchPageCard, researchPageEntry, researchPriorityEvidence,
  researchRatingsEvidence, researchSendBacks, researchStepVerdict, researchUnreachableEvidence, type ResearchFetchRow, type ResearchRecordRow,
  type ResearchStep, type SseEvent
} from "./research-review-support";

const SECOND_MODEL_DISPLAY_NAME = "Sub-agents second model";
/** A main-agent run's wait: the shipped 3600 s turn plus the margin. */
const TURN_SECONDS = 3_600;

let stage = "guard";
function emit(value: Record<string, unknown>) { process.stdout.write(`${JSON.stringify(value)}\n`); }
const fail = (code: string): never => { throw new BrowserScenarioError(code); };
const seconds = (since: number) => Math.round((Date.now() - since) / 100) / 10;

type Session = { api: Api };
type Context = Readonly<{
  /** K's model without vision and the id its prompt names; null when none is configured. */
  blind: Readonly<{ id: string; model: CatalogModel }> | null;
  db: PostgresClient;
  keepChats: boolean;
  marginSeconds: number;
  model: CatalogModel;
  options: SubagentHarnessOptions;
  /** The Search routes Q and R run on: the client route, and the hosted one when the stand's model offers it. */
  search: readonly SearchRoute[];
  second: CatalogModel | null;
  research: Readonly<{ options: ReturnType<typeof researchEvalOptions>; judge: ResearchEvalCall | null;
    /** The operator's purchase question (AIQSA_SUBAGENTS_T_QUESTION_FILE) and administrator proxy, in memory only. */
    question: string | null; adminProxy: ResearchAdminProxy | null;
    /** The question set's questions by name (AIQSA_SUBAGENTS_T_QUESTION_SET), in memory only. */
    questions: ReadonlyMap<string, ResearchSetQuestion>;
    /** The same-chat steps after each question's research (AIQSA_SUBAGENTS_T_STEPS_FILE), in memory only; none without the file. */
    steps: readonly ResearchStep[] }> | null;
  session: Session;
  target: StandTarget;
}>;

/** A Search plan a send names: its sources, each with the label attribution reports it under. */
type SearchRoute = Readonly<{ mode: "all_selected" | "model_choice"; model: CatalogModel; name: string; sources: readonly Readonly<{ label: string; optionId: string }>[] }>;

/** What one scenario run created and started, for cleanup and for stopping its streams. */
type Run = {
  chats: string[];
  interactions: Promise<void>[];
  line: Record<string, unknown>;
  streams: { abort: AbortController; drained: Promise<void> }[];
  tasks: string[];
};

// Runs and chats ---------------------------------------------------------------------

type MainRun = { createdAt: Date; errorCode: string | null; id: string; status: string; systemTurn: boolean; userMessageId: string };

async function mainRuns(db: PostgresClient, chatId: string): Promise<MainRun[]> {
  const { rows } = await db.query<MainRun>(`SELECT r."id", r."status"::text AS "status", r."errorPayload"->>'code' AS "errorCode",
      r."createdAt", r."userMessageId", (m."systemTurnKind" IS NOT NULL) AS "systemTurn"
    FROM "ModelRun" r JOIN "Message" m ON m."id" = r."userMessageId"
    WHERE r."chatId" = $1 AND r."subagentTurnId" IS NULL ORDER BY r."createdAt"`, [chatId]);
  return rows;
}

async function activeLeaf(ctx: Context, chatId: string): Promise<string | null> {
  const value = await json(ctx.session.api, `/api/chats/${encodeURIComponent(chatId)}`);
  const leaf = isRecord(value) && isRecord(value.chat) ? value.chat.activeLeafMessageId : undefined;
  if (leaf !== null && typeof leaf !== "string") fail("chat_detail_invalid");
  return leaf as string | null;
}

/** Owed callbacks: ended background turns no main-agent run received yet; a child reports to its parent and owes none. */
async function owedCallbacks(db: PostgresClient, chatId: string): Promise<number> {
  const { rows } = await db.query<{ count: number }>(`SELECT count(*)::int AS "count" FROM "SubagentTurn" t
    JOIN "SubagentThread" th ON th."id" = t."threadId" AND th."parentThreadId" IS NULL
    WHERE t."chatId" = $1 AND t."mode" = 'background' AND t."state"::text NOT IN ('running', 'waiting') AND t."callbackRunId" IS NULL`, [chatId]);
  return rows[0]?.count ?? 0;
}

/** Waits until the main agent is idle with nothing owed to it (a wake-up turn would start), twice in a row. */
async function waitMainIdle(ctx: Context, chatId: string, timeoutMs = (TURN_SECONDS + ctx.marginSeconds) * 1_000): Promise<void> {
  let quiet = 0;
  await poll(timeoutMs, async () => {
    const active = (await mainRuns(ctx.db, chatId)).filter((run) => !TERMINAL_RUN_STATES.has(run.status)).length;
    quiet = active === 0 && await owedCallbacks(ctx.db, chatId) === 0 ? quiet + 1 : 0;
    return quiet >= 2 ? true : null;
  }, "main_not_idle", 3_000);
}

type SendAttempt = Readonly<{ code: string; ok: false } | { ok: true; runId: string }>;

/**
 * One send as the composer would make it, now: a refusal comes back, an accepted send gives the admitted run's id. `deepResearch` is the `+` menu's
 * Deep research (`DEEP_RESEARCH_SEND_FIELD`), the only thing that starts research (operator decision 2026-11-05); `onStream` reads the run's stream
 * in place of discarding it.
 */
async function trySend(ctx: Context, run: Run, chatId: string, text: string,
  files: readonly Readonly<{ attachmentId: string; fileName: string; type: "file" }>[] = [],
  controls: Readonly<{ deepResearch?: boolean; mcp?: Readonly<{ mode: "load_all" }>; search?: SearchRoute; workspace?: Readonly<{ enabled: boolean }> }> = {},
  onStream?: (response: Response) => Promise<void>): Promise<SendAttempt> {
  const { deepResearch, search, ...others } = controls;
  const leaf = await activeLeaf(ctx, chatId);
  const known = new Set((await mainRuns(ctx.db, chatId)).map((entry) => entry.id));
  const abort = new AbortController();
  const response = await request(ctx.session.api, `/api/chats/${encodeURIComponent(chatId)}/messages`, { body: {
    content: { blocks: [{ text, type: "text" }, ...files] }, expectedActiveLeafId: leaf, ...runControls(search?.model ?? ctx.model), ...others,
    ...(deepResearch === true ? { [DEEP_RESEARCH_SEND_FIELD]: true } : {}),
    ...(search ? { searchPlan: { mode: search.mode, optionIds: search.sources.map((source) => source.optionId) }, searchStrategy: undefined } : {})
  }, method: "POST", signal: abort.signal });
  if (!response.ok) return { code: await errorCode(response), ok: false };
  run.streams.push({ abort, drained: onStream ? onStream(response).catch(() => undefined) : discard(response) });
  return { ok: true, runId: await poll(120_000, async () => (await mainRuns(ctx.db, chatId))
    .find((entry) => !known.has(entry.id) && !entry.systemTurn)?.id ?? null, "run_not_admitted") };
}

/** Sends one user message as the composer would, once the main agent is idle; resolves the admitted run's id. */
async function send(ctx: Context, run: Run, chatId: string, text: string): Promise<string> {
  await waitMainIdle(ctx, chatId);
  const sent = await trySend(ctx, run, chatId, text);
  return sent.ok ? sent.runId : fail(`send_${sent.code}`);
}

type Terminal = Readonly<{ errorCode: string | null; status: string }>;

/** Waits for the run's terminal state; past the wait it is cancelled and reported as `harness_timeout`. */
async function waitRun(ctx: Context, runId: string, timeoutMs = (TURN_SECONDS + ctx.marginSeconds) * 1_000): Promise<Terminal> {
  try {
    return await poll(timeoutMs, async () => {
      const { rows } = await ctx.db.query<Terminal>(`SELECT "status"::text AS "status", "errorPayload"->>'code' AS "errorCode"
        FROM "ModelRun" WHERE "id" = $1`, [runId]);
      const row = rows[0];
      return row && TERMINAL_RUN_STATES.has(row.status) ? { errorCode: safeCode(row.errorCode), status: row.status } : null;
    }, "harness_timeout", 3_000);
  } catch (error) {
    if (!(error instanceof BrowserScenarioError)) throw error;
    await request(ctx.session.api, `/api/model-runs/${encodeURIComponent(runId)}/cancel`, { body: {}, method: "POST" }).catch(() => undefined);
    return { errorCode: "harness_timeout", status: "harness_timeout" };
  }
}

function stopStreams(run: Run): Promise<unknown> {
  for (const stream of run.streams) stream.abort.abort();
  return Promise.all(run.streams.map((stream) => stream.drained));
}

// Evidence ---------------------------------------------------------------------------

async function turnRows(db: PostgresClient, chatId: string): Promise<TurnRow[]> {
  const { rows } = await db.query<TurnRow>(`SELECT t."id" AS "turnId", t."threadId", t."mode"::text AS "mode",
      t."state"::text AS "state", t."outcome"::text AS "outcome", t."reasonCode", t."provider", t."modelId", t."providerModelId", t."reasoningEffort",
      t."modelSource"::text AS "modelSource", t."effortSource"::text AS "effortSource", t."parentRunId",
      -- The parent's answer connection: the same kind of id as the turn's provider (ModelRun.provider is the adapter kind).
      (SELECT b."connectionId" FROM "ProviderRunBinding" b WHERE b."modelRunId" = p."id" AND b."role"::text = 'answer'
        AND b."bindingKey" = 'answer' ORDER BY b."bindingKey" LIMIT 1) AS "parentProvider",
      p."modelId" AS "parentModelId", p."normalizedRequest"->>'reasoningEffort' AS "parentEffort",
      t."startedAt", t."endedAt", t."callbackRunId", e."id" AS "executionRunId"
    FROM "SubagentTurn" t JOIN "ModelRun" p ON p."id" = t."parentRunId"
      LEFT JOIN "ModelRun" e ON e."subagentTurnId" = t."id"
    WHERE t."chatId" = $1 ORDER BY t."startedAt", t."id"`, [chatId]);
  return rows;
}

/** The chat's threads by the names the prompts fixed: kept in memory only, never printed. */
async function threadIdsByName(db: PostgresClient, chatId: string): Promise<Map<string, string[]>> {
  const { rows } = await db.query<{ id: string; name: string }>(`SELECT "id", "name" FROM "SubagentThread"
    WHERE "chatId" = $1 ORDER BY "createdAt"`, [chatId]);
  const byName = new Map<string, string[]>();
  for (const row of rows) byName.set(row.name, [...(byName.get(row.name) ?? []), row.id]);
  return byName;
}

/** The latest turn of the thread of that name (the newest thread of the name). */
async function latestTurnOf(db: PostgresClient, chatId: string, name: string): Promise<TurnRow | null> {
  const threadId = (await threadIdsByName(db, chatId)).get(name)?.at(-1);
  if (!threadId) return null;
  return (await turnRows(db, chatId)).filter((turn) => turn.threadId === threadId).at(-1) ?? null;
}

/** The state the thread view shows for the newest thread of that name (as the user sees it), or null. */
async function threadViewState(ctx: Context, chatId: string, name: string): Promise<string | null> {
  const threadId = (await threadIdsByName(ctx.db, chatId)).get(name)?.at(-1);
  if (!threadId) return null;
  const threads = decodeSubagentChatThreads(await json(ctx.session.api, SUBAGENT_API_PATHS.chatThreads(chatId)));
  return threads?.threads.find((thread) => thread.id === threadId)?.state ?? null;
}

async function waitTurnEnded(ctx: Context, chatId: string, name: string, timeoutMs: number): Promise<TurnRow | null> {
  return poll(timeoutMs, async () => {
    const turn = await latestTurnOf(ctx.db, chatId, name);
    return turn && turn.state !== "running" && turn.state !== "waiting" ? turn : null;
  }, "turn_end_timeout", 3_000).catch(() => latestTurnOf(ctx.db, chatId, name));
}

async function toolRows(db: PostgresClient, chatId: string): Promise<ToolRow[]> {
  const { rows } = await db.query<ToolRow>(`SELECT c."modelRunId" AS "runId", c."subagentThreadId" AS "threadId",
      c."subagentTurnId" AS "turnId", c."toolName", c."state"::text AS "state", c."roundIndex", c."startedAt", c."completedAt",
      (c."toolName" NOT IN ('call_subagent', 'stop_subagent') AND (strpos(c."arguments"::text, 'aiqsa-browser') > 0
        OR strpos(c."arguments"::text, 'aiqsa import browser') > 0)) AS "browser",
      strpos(coalesce(c."result"::text, ''), 'browser_busy') > 0 AS "busy",
      strpos(coalesce(c."result"::text, ''), 'browser_memory_low') > 0 AS "memoryLow",
      (c."toolName" = 'call_subagent' AND strpos(coalesce(c."result"::text, ''), 'subagent_background_unavailable') > 0)
        AS "backgroundRefused",
      -- Stable codes only: the first content block's code fields, never its text.
      CASE WHEN c."result"->'content'->0->>'type' = 'json' THEN coalesce(
          CASE WHEN jsonb_typeof(c."result"->'content'->0->'value'->'error') = 'string'
            THEN c."result"->'content'->0->'value'->>'error' END,
          c."result"->'content'->0->'value'->'error'->>'code',
          c."result"->'content'->0->'value'->>'code',
          CASE WHEN c."result"->'content'->0->'value'->>'kind' = 'ended'
            THEN 'ended_' || (c."result"->'content'->0->'value'->>'state') END)
        WHEN c."result"->'content'->0->>'type' = 'text'
          THEN substring(c."result"->'content'->0->>'text' from '"error":\\{"code":"([a-z][a-z0-9_]{0,63})"')
      END AS "resultCode",
      CASE WHEN c."result"->'content'->0->>'type' = 'json' AND c."result"->'content'->0->'value'->>'kind' = 'ended'
        THEN c."result"->'content'->0->'value'->>'reason' END AS "resultReason",
      CASE WHEN c."toolName" <> 'stop_subagent' OR c."subagentThreadId" IS NOT NULL THEN NULL
        ELSE coalesce((SELECT t."mode"::text FROM "SubagentThread" th JOIN "SubagentTurn" t ON t."threadId" = th."id"
          WHERE th."chatId" = r."chatId" AND th."name" = lower(trim(c."arguments"->>'name'))
            AND t."startedAt" <= coalesce(c."startedAt", c."createdAt")
            AND (t."endedAt" IS NULL OR t."endedAt" >= coalesce(c."startedAt", c."createdAt"))
          ORDER BY t."startedAt" DESC LIMIT 1), 'none') END AS "stopTarget"
    FROM "ModelRunToolCall" c JOIN "ModelRun" r ON r."id" = c."modelRunId" WHERE r."chatId" = $1`, [chatId]);
  return rows;
}

async function wakeUpRows(db: PostgresClient, chatId: string): Promise<WakeUpRow[]> {
  const { rows } = await db.query<WakeUpRow>(`SELECT m."createdAt", r."id" AS "runId", r."status"::text AS "runStatus"
    FROM "Message" m LEFT JOIN "ModelRun" r ON r."userMessageId" = m."id" AND r."subagentTurnId" IS NULL
    WHERE m."chatId" = $1 AND m."systemTurnKind"::text = 'subagent_callback' ORDER BY m."createdAt"`, [chatId]);
  return rows;
}

/** The chat's usage rows once they stop changing: usage is written after each answer. */
async function settledUsage(db: PostgresClient, chatIds: readonly string[]): Promise<PurposeUsageRow[]> {
  const read = async () => (await db.query<PurposeUsageRow>(`SELECT "purpose"::text AS "purpose", "inputTokens", "cachedInputTokens",
      "outputTokens" FROM "UsageEvent" WHERE "modelRunId" IN (SELECT "id" FROM "ModelRun" WHERE "chatId" = ANY($1::text[]))`,
  [[...chatIds]])).rows;
  let last = await read();
  for (let attempt = 0; attempt < 24; attempt += 1) {
    await sleep(5_000);
    const next = await read();
    if (next.length === last.length && next.some((row) => row.purpose === "chat_answer")) return next;
    last = next;
  }
  return last;
}

/** Bot walls, CAPTCHAs and sign-in walls the run reported: handoff reasons, sub-agent blocked reasons and the file's list. */
async function wallCodes(db: PostgresClient, chatId: string, turns: readonly TurnRow[], result: ResultRead | null) {
  const runIds = (await db.query<{ id: string }>(`SELECT "id" FROM "ModelRun" WHERE "chatId" = $1`, [chatId])).rows.map((row) => row.id);
  const handoffReasons: Record<string, number> = {};
  for (const call of await handoffCalls(db, runIds)) {
    const reason = isRecord(call.arguments) ? safeCode(call.arguments.reason) ?? "other" : "other";
    handoffReasons[reason] = (handoffReasons[reason] ?? 0) + 1;
  }
  const walls = new Set(["bot_wall", "captcha", "code_required", "sign_in_required"]);
  const turnWalls: Record<string, number> = {};
  for (const turn of turns) {
    if (turn.reasonCode && walls.has(turn.reasonCode)) turnWalls[turn.reasonCode] = (turnWalls[turn.reasonCode] ?? 0) + 1;
  }
  return { handoffReasons, resultBlocked: result?.ok ? [...result.blocked] : [], turnWalls };
}

/** Attachments of the chat's runs to its shared Workspace, of the given runs when named. */
async function attachmentCount(db: PostgresClient, chatId: string, runIds?: readonly string[]): Promise<number> {
  const { rows } = await db.query<{ count: number }>(`SELECT count(*)::int AS "count" FROM "WorkspaceRunAttachment"
    WHERE "chatId" = $1 AND ($2::text[] IS NULL OR "modelRunId" = ANY($2::text[]))`, [chatId, runIds ? [...runIds] : null]);
  return rows[0]?.count ?? 0;
}

/**
 * Waits, within a bound, until no ended background turn of the chat owes its
 * callback and every wake-up turn has a terminal run: the server starts a
 * wake-up after its coalescing window, so evidence read earlier misses it.
 * With `wakeUpAfter` (G: the restart), a wake-up created at or after that
 * time must exist too, allowing a few seconds of clock skew between the
 * harness host and the database. False when the bound passed
 * (`callbacks_still_owed`).
 */
async function settleCallbacks(ctx: Context, chatId: string, timeoutMs = 120_000, wakeUpAfter: number | null = null): Promise<boolean> {
  let quiet = 0;
  return poll(timeoutMs, async () => {
    const owed = await owedCallbacks(ctx.db, chatId);
    const wakeUps = await wakeUpRows(ctx.db, chatId);
    const open = wakeUps.some((wakeUp) => wakeUp.runId === null || !TERMINAL_RUN_STATES.has(wakeUp.runStatus ?? ""));
    const awaited = wakeUpAfter === null ||
      wakeUps.some((wakeUp) => new Date(wakeUp.createdAt).getTime() >= wakeUpAfter - 5_000);
    quiet = owed === 0 && !open && awaited ? quiet + 1 : 0;
    return quiet >= 2 ? true : null;
  }, "callbacks_still_owed", 3_000).catch(() => false);
}

/** The chat's Workspace session as it stands, on the stand's clock; the owner's kind is computed here and the owner never leaves SQL. */
async function sessionSample(db: PostgresClient, chatId: string): Promise<SessionSample | null> {
  const { rows } = await db.query<SessionSample>(`SELECT "state"::text AS "state", ("operationExpiresAt" IS NOT NULL) AS "closing",
      CASE WHEN "operationOwner" IS NULL THEN 'none' WHEN "operationOwner" LIKE 'maintenance:%' THEN 'maintenance' ELSE 'other' END AS "owner",
      clock_timestamp() AT TIME ZONE 'UTC' AS "at"
    FROM "WorkspaceSession" WHERE "chatId" = $1`, [chatId]);
  return rows[0] ?? null;
}

/** Keeps the session's changes, read once a second. */
function watchSession(ctx: Context, chatId: string): Readonly<{ stop(): Promise<SessionSample[]> }> {
  let stopped = false;
  let samples: SessionSample[] = [];
  const loop = (async () => {
    while (!stopped) {
      const sample = await sessionSample(ctx.db, chatId).catch(() => null);
      if (sample) samples = appendSessionSample(samples, sample);
      await sleep(1_000);
    }
  })();
  return {
    async stop() {
      stopped = true;
      await loop;
      return samples;
    }
  };
}

/** The defects' failures anywhere in the chat's runs, matched inside SQL: tool results, run errors and turn end reasons. */
async function captureFailures(db: PostgresClient, chatId: string) {
  const { rows } = await db.query<{ captureIdentity: number; visionInternal: number }>(`SELECT
      count(*) FILTER (WHERE strpos(f."text", 'WorkspaceSelectedCapture_identity_check') > 0)::int AS "captureIdentity",
      count(*) FILTER (WHERE strpos(f."text", 'vision_analysis_internal_failed') > 0)::int AS "visionInternal"
    FROM (
      SELECT coalesce(c."result"::text, '') AS "text" FROM "ModelRunToolCall" c JOIN "ModelRun" r ON r."id" = c."modelRunId" WHERE r."chatId" = $1
      UNION ALL SELECT coalesce("errorPayload"::text, '') FROM "ModelRun" WHERE "chatId" = $1
      UNION ALL SELECT coalesce("reasonCode", '') FROM "SubagentTurn" WHERE "chatId" = $1
    ) f`, [chatId]);
  return rows[0] ?? { captureIdentity: 0, visionInternal: 0 };
}

/** The scenario's common evidence, assigned into its line, once owed callbacks have settled. */
async function commonEvidence(ctx: Context, run: Run, chatId: string) {
  const settled = await settleCallbacks(ctx, chatId);
  run.line.callbacksSettled = settled;
  const now = Date.now();
  const turns = await turnRows(ctx.db, chatId);
  const tools = await toolRows(ctx.db, chatId);
  const wakeUps = await wakeUpRows(ctx.db, chatId);
  const usage = usageByPurpose(await settledUsage(ctx.db, run.chats));
  Object.assign(run.line, {
    binding: bindingEvidence(turns),
    browser: browserEvidence(tools, now),
    callbacks: callbackEvidence(turns, wakeUps),
    callSubagentOutcomes: callSubagentOutcomes(tools),
    calls: subagentCallEvidence(tools),
    failedToolCalls: failedToolCalls(tools),
    stopSubagentCalls: stopSubagentCalls(tools),
    peakConcurrentTurns: peakConcurrentTurns(turns, now),
    rounds: roundsPerAgent(tools),
    turnOutcomes: turnOutcomes(turns),
    usage
  });
  return { settled, tools, turns, usage, wakeUps };
}

/** Waits for the exports of the chat's main-agent runs, then reads the newest result file among them. */
async function resultOf(ctx: Context, chatId: string, runIds?: readonly string[]): Promise<ResultRead> {
  const ids = runIds ?? (await mainRuns(ctx.db, chatId)).map((entry) => entry.id);
  for (const id of ids) await awaitExport(ctx.db, id);
  return readResultFile(ctx.session.api, ctx.db, [...ids].reverse());
}

/** The verdict of a result file into the line; the checks failed, or the read's failure code. */
type ResultFound = Extract<ResultRead, { ok: true }>;

function judge(run: Run, read: ResultRead, oracle: (value: ResultFound) => OracleVerdict): string[] {
  run.line.outputFiles = read.outputFiles;
  if (!read.ok) return [read.code];
  run.line.resultStatus = ["completed", "partial", "blocked"].includes(String(read.value.status)) ? read.value.status : "other";
  const verdict = oracle(read);
  run.line.oracleCounts = verdict.counts;
  return [...verdict.failed];
}

// Thread views polled as the chat list and the chat poll them -----------------------

type Watch = Readonly<{ stop(): Promise<Record<string, unknown> & { progression: StateCounts[] }> }>;

/** Polls the chat's thread list and the chat list's summary every 3 s; keeps state counts as they change. */
function watchThreads(ctx: Context, chatId: string): Watch {
  let stopped = false;
  let progression: StateCounts[] = [];
  let polls = 0;
  let failures = 0;
  let summaryMismatches = 0;
  let maxRunning = 0;
  const loop = (async () => {
    while (!stopped) {
      try {
        const threads = decodeSubagentChatThreads(await json(ctx.session.api, SUBAGENT_API_PATHS.chatThreads(chatId)));
        const summary = decodeSubagentSummaryResponse(await json(ctx.session.api, SUBAGENT_API_PATHS.summary([chatId])));
        if (!threads || !summary) failures += 1;
        else {
          polls += 1;
          progression = appendProgression(progression, stateCounts(threads.threads.map((thread) => thread.state)));
          maxRunning = Math.max(maxRunning, threads.running);
          const listed = summary.chats.find((entry) => entry.chatId === chatId)?.running ?? 0;
          if (listed !== threads.running) summaryMismatches += 1;
        }
      } catch {
        failures += 1;
      }
      await sleep(3_000);
    }
  })();
  return {
    async stop() {
      stopped = true;
      await loop;
      return { failures, maxRunning, polls, progression, summaryMismatches };
    }
  };
}

/** Starts a live-panel interaction for the chat; its evidence lands in the line when it ends. */
function interact(ctx: Context, run: Run, interaction: ScenarioInteraction, chatId: string, runId: string, marker: string): AbortController {
  const abort = new AbortController();
  run.interactions.push(interaction({ baseUrl: ctx.session.api.baseUrl.origin, chatId, cookie: ctx.session.api.cookie, marker, runId,
    signal: abort.signal }).then((evidence: InteractionEvidence) => { run.line.interaction = evidence; }, (error: unknown) => {
    run.line.interactionFailed = error instanceof BrowserScenarioError ? error.message : "interaction_failed";
  }));
  return abort;
}

async function planBrowserModule() {
  return import("./research-plan-browser");
}

async function handoffModule() {
  return import("./browser-scenarios-handoff");
}

// Scenarios ---------------------------------------------------------------------------

type Outcome = Readonly<{ success: boolean; usage: ReturnType<typeof usageByPurpose> | null }>;

async function scenarioA(ctx: Context, run: Run): Promise<Outcome> {
  const definitions = decodeSubagentDefinitionListResponse(await json(ctx.session.api, "/api/me/subagents"));
  run.line.customSubagents = definitions ? definitions.definitions.length : null;
  const chat = await createScenarioChat(ctx.session.api, "Sub-agent scenario A");
  run.chats.push(chat.id);
  const runId = await send(ctx, run, chat.id, SUBAGENT_PROMPTS.A());
  const terminal = await waitRun(ctx, runId);
  run.line.terminal = terminal.status;
  run.line.failureCode = terminal.errorCode;
  const { turns, usage } = await commonEvidence(ctx, run, chat.id);
  const checks = judge(run, await resultOf(ctx, chat.id, [runId]), (read) => oracleA(read.value));
  const binding = bindingEvidence(turns);
  if (binding.turns === 0) checks.push("no_subagents");
  else if (!binding.allOnParentBinding) checks.push("binding_not_parent");
  if (!usage.split) checks.push("usage_not_split");
  if (run.line.customSubagents !== 0) checks.push("custom_subagents_present");
  run.line.checksFailed = checks;
  return { success: terminal.status === "complete" && checks.length === 0, usage };
}

async function scenarioB(ctx: Context, run: Run): Promise<Outcome> {
  const chat = await createScenarioChat(ctx.session.api, "Sub-agent scenario B");
  run.chats.push(chat.id);
  const watch = watchThreads(ctx, chat.id);
  const started = Date.now();
  const first = await send(ctx, run, chat.id, SUBAGENT_PROMPTS.B());
  const firstTerminal = await waitRun(ctx, first);
  run.line.firstTerminal = firstTerminal.status;
  run.line.firstAnswerSeconds = seconds(started);
  const activeAtSecond = (await turnRows(ctx.db, chat.id)).filter((turn) => turn.mode === "background" &&
    (turn.state === "running" || turn.state === "waiting")).length;
  const second = await send(ctx, run, chat.id, SIDE_QUESTION.text);
  const secondTerminal = await waitRun(ctx, second);
  const { rows } = await ctx.db.query<{ hit: boolean }>(`SELECT strpos(m."content"::text, $2) > 0 AS "hit"
    FROM "ModelRun" r JOIN "Message" m ON m."id" = r."assistantMessageId" WHERE r."id" = $1`, [second, SIDE_QUESTION.answer]);
  Object.assign(run.line, { backgroundActiveAtSecondMessage: activeAtSecond, secondAnswerRight: rows[0]?.hit === true,
    secondTerminal: secondTerminal.status });
  // Every background turn ends and its callback reaches the main agent.
  await poll(30 * 60_000, async () => {
    const turns = await turnRows(ctx.db, chat.id);
    return turns.length > 0 && turns.every((turn) => turn.state !== "running" && turn.state !== "waiting") ? true : null;
  }, "background_end_timeout", 5_000).catch(() => { run.line.backgroundEndTimeout = true; });
  await waitMainIdle(ctx, chat.id);
  const watched = await watch.stop();
  run.line.threadViews = watched;
  const { settled, turns, usage, wakeUps } = await commonEvidence(ctx, run, chat.id);
  const callbacks = callbackEvidence(turns, wakeUps);
  run.line.wallSeconds = seconds(started);
  const checks = judge(run, await resultOf(ctx, chat.id), (read) => oracleB(read.value));
  if (callbacks.backgroundTurns !== SUBAGENT_NAMES.background.length) checks.push("background_turns_not_5");
  if (activeAtSecond === 0) checks.push("none_running_at_second_message");
  if (secondTerminal.status !== "complete" || run.line.secondAnswerRight !== true) checks.push("second_message_not_answered");
  if (!settled) checks.push("callbacks_still_owed");
  else if (callbacks.callbacksOwed > 0) checks.push("callbacks_owed");
  if (callbacks.wakeUpTurns === 0) checks.push("no_wake_up");
  if (!usage.split) checks.push("usage_not_split");
  if (watched.progression.length < 2) checks.push("states_not_progressing");
  run.line.checksFailed = checks;
  return { success: firstTerminal.status === "complete" && checks.length === 0, usage };
}

/** C1, C2, D5 and D1: one long browsing turn; the live panel declines every handoff (the agent never solves a check). */
async function browsingScenario(ctx: Context, run: Run, input: Readonly<{
  oracle: (value: ResultFound) => OracleVerdict; prompt: string; requested: CatalogModel | null; title: string;
}>): Promise<Outcome> {
  const chat = await createScenarioChat(ctx.session.api, input.title);
  run.chats.push(chat.id);
  const started = Date.now();
  const runId = await send(ctx, run, chat.id, input.prompt);
  const panel = interact(ctx, run, (await handoffModule()).cancelEveryHandoff, chat.id, runId, `zq${randomUUID().replaceAll("-", "")}`);
  const terminal = await waitRun(ctx, runId);
  run.line.wallSeconds = seconds(started);
  panel.abort();
  await Promise.all(run.interactions);
  Object.assign(run.line, { failureCode: terminal.errorCode, terminal: terminal.status });
  const { turns, usage } = await commonEvidence(ctx, run, chat.id);
  const read = await resultOf(ctx, chat.id, [runId]);
  const checks = judge(run, read, input.oracle);
  run.line.walls = await wallCodes(ctx.db, chat.id, turns, read);
  if (input.requested) {
    // The turn's `modelId` is the upstream id the call names; the catalog's model id is accepted too.
    const modelIds = [input.requested.upstreamModelId, ctx.options.secondModel, input.requested.modelId]
      .filter((id): id is string => typeof id === "string" && id.length > 0);
    const requested = requestedModelEvidence(turns, { modelIds, provider: input.requested.provider });
    run.line.requestedModel = requested;
    if (!requested.allOnRequestedModel) checks.push("turns_not_on_requested_model");
  }
  run.line.checksFailed = checks;
  return { success: terminal.status === "complete" && checks.length === 0, usage };
}

async function scenarioE(ctx: Context, run: Run): Promise<Outcome> {
  const secrets = runSecrets(randomBytes(16));
  const chat = await createScenarioChat(ctx.session.api, "Sub-agent scenario E");
  run.chats.push(chat.id);
  const watch = watchThreads(ctx, chat.id);
  const started = Date.now();
  // Each stop is judged only on agents the thread view still shows running right before it.
  const stateBeforeStop: Record<StopPath, string | null> = { stopAll: null, stopRoute: null, stopTool: null };
  // Stop all first, in its own step: two background agents that hold, stopped as soon as both run.
  const holds = await send(ctx, run, chat.id, SUBAGENT_PROMPTS.E.holds());
  run.line.holdsTerminal = (await waitRun(ctx, holds)).status;
  const holdStates = async () => Promise.all(SUBAGENT_NAMES.hold.map((name) => threadViewState(ctx, chat.id, name)));
  const bothRunning = await poll(3 * 60_000, async () => (await holdStates()).every((state) => state === "running") ? true : null,
    "holds_not_running", 2_000).catch(() => false);
  const beforeAll = await holdStates();
  stateBeforeStop.stopAll = bothRunning ? "running" : beforeAll.find((state) => state !== "running") ?? null;
  const stoppedAll = decodeSubagentStopAllResponse(await json(ctx.session.api, SUBAGENT_API_PATHS.stopAll(chat.id),
    { body: {}, method: "POST" }));
  run.line.stopAllStopped = stoppedAll ? stoppedAll.stopped : null;
  const stopAllAt = Date.now();
  const stopAll = await poll(30_000, async () => {
    const turns = await Promise.all(SUBAGENT_NAMES.hold.map((name) => latestTurnOf(ctx.db, chat.id, name)));
    return turns.every((turn) => turn !== null && turn.state !== "running" && turn.state !== "waiting")
      ? turns.filter((turn): turn is TurnRow => turn !== null) : null;
  }, "stop_all_timeout", 1_000).catch(async () => (await Promise.all(SUBAGENT_NAMES.hold.map((name) => latestTurnOf(ctx.db, chat.id, name))))
    .filter((turn): turn is TurnRow => turn !== null));
  run.line.stopAllSeconds = seconds(stopAllAt);
  // No stopped hold may keep its run attached to the shared Workspace.
  const holdRuns = stopAll.flatMap((turn) => turn.executionRunId ? [turn.executionRunId] : []);
  const attachmentsAfterStopAll = await poll(30_000, async () => await attachmentCount(ctx.db, chat.id, holdRuns) === 0 ? 0 : null,
    "attachments_left", 1_000).catch(() => attachmentCount(ctx.db, chat.id, holdRuns));
  run.line.attachmentsAfterStopAll = attachmentsAfterStopAll;
  // Then the correction to a running sub-agent, `stop_subagent` and the thread view's Stop.
  const first = await send(ctx, run, chat.id, SUBAGENT_PROMPTS.E.start(secrets));
  run.line.firstTerminal = (await waitRun(ctx, first)).status;
  const correction = await send(ctx, run, chat.id, SUBAGENT_PROMPTS.E.correction(secrets));
  run.line.correctionTerminal = (await waitRun(ctx, correction)).status;
  const [idleTool, idleRoute] = SUBAGENT_NAMES.idle;
  await waitMainIdle(ctx, chat.id);
  stateBeforeStop.stopTool = await threadViewState(ctx, chat.id, idleTool);
  const byTool = await send(ctx, run, chat.id, SUBAGENT_PROMPTS.E.stopByTool());
  run.line.stopToolTerminal = (await waitRun(ctx, byTool)).status;
  const stopTool = await waitTurnEnded(ctx, chat.id, idleTool, 120_000);
  // The thread view's Stop, as the user presses it.
  const routeThread = (await threadIdsByName(ctx.db, chat.id)).get(idleRoute)?.at(-1);
  stateBeforeStop.stopRoute = await threadViewState(ctx, chat.id, idleRoute);
  if (routeThread) {
    const stopped = decodeSubagentStopResponse(await json(ctx.session.api, SUBAGENT_API_PATHS.stopThread(chat.id, routeThread),
      { body: {}, method: "POST" }));
    run.line.stopRouteResponse = stopped ? stopped.thread.state : "invalid";
  }
  const stopRoute = await waitTurnEnded(ctx, chat.id, idleRoute, 120_000);
  // The correction's sub-agent ends on its own and its wake-up answer writes the file.
  const counter = await waitTurnEnded(ctx, chat.id, SUBAGENT_NAMES.counter, 30 * 60_000);
  run.line.counterState = counter?.state ?? null;
  await waitMainIdle(ctx, chat.id);
  const { rows } = await ctx.db.query<{ delivered: number; total: number }>(`SELECT count(*)::int AS "total",
      count(*) FILTER (WHERE "deliveredAt" IS NOT NULL)::int AS "delivered"
    FROM "RunFollowup" WHERE "chatId" = $1 AND "origin"::text = 'main_agent'`, [chat.id]);
  const counterThread = (await threadIdsByName(ctx.db, chat.id)).get(SUBAGENT_NAMES.counter)?.at(-1);
  const view = counterThread
    ? decodeSubagentThreadView(await json(ctx.session.api, SUBAGENT_API_PATHS.thread(chat.id, counterThread))) : null;
  const deliveries: Record<string, number> = {};
  for (const message of view?.turns.flatMap((turn) => turn.messages) ?? []) {
    deliveries[message.delivery] = (deliveries[message.delivery] ?? 0) + 1;
  }
  const stops = stopEvidence({ stopAll, stopRoute, stopTool });
  Object.assign(run.line, { correctionFollowups: rows[0] ?? null, stateBeforeStop, stops, threadViewDeliveries: deliveries,
    threadViewRead: view !== null, wallSeconds: seconds(started) });
  const { settled, usage } = await commonEvidence(ctx, run, chat.id);
  run.line.threadViews = await watch.stop();
  const checks = judge(run, await resultOf(ctx, chat.id), (read) => oracleE(read.value, secrets));
  if ((rows[0]?.delivered ?? 0) === 0) checks.push("correction_not_delivered");
  checks.push(...stopChecks(stops, { stopAll: stateBeforeStop.stopAll === "running",
    stopRoute: stateBeforeStop.stopRoute === "running", stopTool: stateBeforeStop.stopTool === "running" }));
  if (attachmentsAfterStopAll !== 0) checks.push("attachments_left_after_stop_all");
  if (!settled) checks.push("callbacks_still_owed");
  run.line.checksFailed = checks;
  return { success: checks.length === 0, usage };
}

async function scenarioF(ctx: Context, run: Run): Promise<Outcome> {
  const secrets = runSecrets(randomBytes(16));
  const expected = notaryValue(secrets.nonce);
  const chat = await createScenarioChat(ctx.session.api, "Sub-agent scenario F");
  run.chats.push(chat.id);
  const first = await send(ctx, run, chat.id, SUBAGENT_PROMPTS.F.start(secrets));
  run.line.firstTerminal = (await waitRun(ctx, first)).status;
  const notary = (await threadIdsByName(ctx.db, chat.id)).get(SUBAGENT_NAMES.notary)?.at(-1) ?? null;
  // Where the main agent could have read the value before the continuation: its messages and its own tool results.
  const { rows: leaks } = await ctx.db.query<{ count: number }>(`SELECT (
      (SELECT count(*) FROM "Message" WHERE "chatId" = $1 AND strpos("content"::text, $2) > 0) +
      (SELECT count(*) FROM "ModelRunToolCall" c JOIN "ModelRun" r ON r."id" = c."modelRunId"
        WHERE r."chatId" = $1 AND c."subagentThreadId" IS NULL AND strpos(coalesce(c."result"::text, ''), $2) > 0))::int AS "count"`,
  [chat.id, expected]);
  run.line.valueVisibleToMainBefore = leaks[0]?.count ?? null;
  const continued = await send(ctx, run, chat.id, SUBAGENT_PROMPTS.F.continuation());
  run.line.continuationTerminal = (await waitRun(ctx, continued)).status;
  const turns = (await turnRows(ctx.db, chat.id)).filter((turn) => turn.threadId === notary);
  const second = turns.find((turn) => turn.parentRunId === continued) ?? null;
  const secondCalls = second ? (await toolRows(ctx.db, chat.id)).filter((row) => row.turnId === second.turnId).length : null;
  Object.assign(run.line, { continuationOnSameThread: second !== null, notaryTurns: turns.length, secondTurnToolCalls: secondCalls });
  const checks = judge(run, await resultOf(ctx, chat.id, [continued]), (read) => oracleFContinued(read.value, expected));
  if (second === null) checks.push("thread_not_continued");
  // The edit: the first message changes and is answered again, as the composer's Edit does.
  const { rows: firstMessage } = await ctx.db.query<{ userMessageId: string }>(`SELECT "userMessageId" FROM "ModelRun" WHERE "id" = $1`,
    [first]);
  await waitMainIdle(ctx, chat.id);
  const edited = await json(ctx.session.api, `/api/messages/${encodeURIComponent(firstMessage[0]?.userMessageId ?? "")}`, {
    body: { content: { blocks: [{ text: SUBAGENT_PROMPTS.F.edited(), type: "text" }] } }, method: "PATCH" });
  const editedId = isRecord(edited) && isRecord(edited.message) && typeof edited.message.id === "string"
    ? edited.message.id : fail("edit_response_invalid");
  const abort = new AbortController();
  const regenerated = await request(ctx.session.api, `/api/messages/${encodeURIComponent(editedId)}/regenerate`, { body: {
    admissionId: randomUUID(), ...runControls(ctx.model) }, method: "POST", signal: abort.signal });
  if (!regenerated.ok) fail(`regenerate_${await errorCode(regenerated)}`);
  run.streams.push({ abort, drained: discard(regenerated) });
  const editedRun = await poll(120_000, async () => (await mainRuns(ctx.db, chat.id))
    .find((entry) => entry.userMessageId === editedId)?.id ?? null, "edited_run_not_admitted");
  run.line.editedTerminal = (await waitRun(ctx, editedRun)).status;
  const visible = async () => {
    const threads = decodeSubagentChatThreads(await json(ctx.session.api, SUBAGENT_API_PATHS.chatThreads(chat.id)));
    return threads ? threads.threads.some((thread) => thread.id === notary) : null;
  };
  const visibleAfterEdit = await visible();
  const branched = await send(ctx, run, chat.id, SUBAGENT_PROMPTS.F.newBranch());
  run.line.newBranchTerminal = (await waitRun(ctx, branched)).status;
  const visibleOnNewBranch = await visible();
  Object.assign(run.line, { abandonedThreadVisibleAfterEdit: visibleAfterEdit, abandonedThreadVisibleOnNewBranch: visibleOnNewBranch });
  const branchRead = await resultOf(ctx, chat.id, [branched]);
  const branchVerdict = branchRead.ok ? oracleFBranched(branchRead.value, expected) : { counts: {}, failed: [branchRead.code] };
  run.line.branchOracleCounts = branchVerdict.counts;
  checks.push(...branchVerdict.failed.map((code) => `branch_${code}`));
  if (visibleAfterEdit !== false || visibleOnNewBranch !== false) checks.push("abandoned_thread_visible");
  if ((run.line.valueVisibleToMainBefore ?? 0) !== 0) checks.push("value_visible_to_main_before_continuation");
  const { usage } = await commonEvidence(ctx, run, chat.id);
  run.line.checksFailed = checks;
  return { success: checks.length === 0, usage };
}

/** The restart hook, with a minimal environment and its output discarded. */
function runRestartHook(hook: RestartHook): Promise<Readonly<{ exitCode: number | null; seconds: number; timedOut: boolean }>> {
  const started = Date.now();
  const picked: Record<string, string> = {};
  for (const key of ["PATH", "HOME", "USER", "LOGNAME", "SSH_AUTH_SOCK"]) {
    const value = process.env[key];
    if (value) picked[key] = value;
  }
  // Next's global types make `NODE_ENV` required on `ProcessEnv`; the hook's shell needs none, so none is passed.
  const env = picked as NodeJS.ProcessEnv;
  return new Promise((resolve) => {
    let timedOut = false;
    const child = spawn("/bin/sh", ["-c", hook.command], { env, stdio: "ignore" });
    const timer = setTimeout(() => { timedOut = true; child.kill("SIGKILL"); }, hook.timeoutMs);
    const done = (exitCode: number | null) => { clearTimeout(timer); resolve({ exitCode, seconds: seconds(started), timedOut }); };
    child.once("error", () => done(null));
    child.once("exit", (code) => done(code));
  });
}

async function scenarioG(ctx: Context, run: Run): Promise<Outcome> {
  const hook = ctx.options.restart ?? fail("restart_command_required");
  const chat = await createScenarioChat(ctx.session.api, "Sub-agent scenario G");
  run.chats.push(chat.id);
  const watch = watchThreads(ctx, chat.id);
  const first = await send(ctx, run, chat.id, SUBAGENT_PROMPTS.G.start());
  run.line.firstTerminal = (await waitRun(ctx, first)).status;
  // Restart only once all three run and both browsing agents have browsed.
  const ready = await poll(10 * 60_000, async () => {
    const turns = await turnRows(ctx.db, chat.id);
    const running = turns.filter((turn) => turn.mode === "background" && turn.state === "running").length;
    const browsing = browserEvidence(await toolRows(ctx.db, chat.id), Date.now()).browsingAgents;
    return running >= 3 && browsing >= 2 ? { browsing, running } : null;
  }, "restart_precondition_timeout", 5_000).catch(() => null);
  run.line.beforeRestart = ready;
  await stopStreams(run);
  const restartedAt = Date.now();
  const restart = await runRestartHook(hook);
  run.line.restart = restart;
  const back = Date.now();
  const readyAgain = await poll(10 * 60_000, async () => {
    const response = await request(ctx.session.api, "/api/health/ready").catch(() => null);
    return response?.ok ? true : null;
  }, "app_not_ready", 3_000).catch(() => false);
  run.line.appReadySeconds = readyAgain ? seconds(back) : null;
  // Sessions live in the database; sign in again only when the restart ended this one.
  const me = await request(ctx.session.api, "/api/me").catch(() => null);
  if (!me || me.status === 401) ctx.session.api = await authenticate(ctx.target);
  // Opening the chat, as the user would, while recovery ends what the restart cut off.
  await poll(20 * 60_000, async () => {
    await request(ctx.session.api, `/api/chats/${encodeURIComponent(chat.id)}`).catch(() => null);
    const turns = await turnRows(ctx.db, chat.id);
    return turns.length > 0 && turns.every((turn) => turn.state !== "running" && turn.state !== "waiting") ? true : null;
  }, "interrupted_timeout", 5_000).catch(() => { run.line.interruptedTimeout = true; });
  await waitMainIdle(ctx, chat.id);
  // The interrupted callbacks reach one wake-up after the server's coalescing window, not at once.
  const restartSettled = await settleCallbacks(ctx, chat.id, 120_000, restartedAt);
  run.line.attachmentsLeft = await attachmentCount(ctx.db, chat.id);
  const evidence = restartEvidence(await turnRows(ctx.db, chat.id), await wakeUpRows(ctx.db, chat.id), restartedAt);
  run.line.restartEvidence = evidence;
  const sleeperBefore = (await threadIdsByName(ctx.db, chat.id)).get(SUBAGENT_NAMES.restart.sleeper)?.at(-1) ?? null;
  const continued = await send(ctx, run, chat.id, SUBAGENT_PROMPTS.G.continuation());
  run.line.continuationTerminal = (await waitRun(ctx, continued)).status;
  const resumed = (await turnRows(ctx.db, chat.id)).find((turn) => turn.threadId === sleeperBefore && turn.parentRunId === continued);
  run.line.continuedByName = resumed ? resumed.state : null;
  run.line.threadViews = await watch.stop();
  const { usage } = await commonEvidence(ctx, run, chat.id);
  const checks: string[] = [];
  if (!ready) checks.push("restart_precondition_timeout");
  if (restart.exitCode !== 0) checks.push(restart.timedOut ? "restart_timeout" : "restart_failed");
  if (!readyAgain) checks.push("app_not_ready");
  if (!evidence.allInterrupted) checks.push("not_all_interrupted");
  if (!restartSettled) checks.push("callbacks_still_owed");
  else if (!evidence.oneCoalescedWakeUp) checks.push("wake_up_not_one_coalesced");
  if (run.line.attachmentsLeft !== 0) checks.push("attachments_left");
  if (!resumed || resumed.state !== "done") checks.push("not_continued_by_name");
  run.line.checksFailed = checks;
  return { success: checks.length === 0, usage };
}

async function scenarioH(ctx: Context, run: Run): Promise<Outcome> {
  // The user signs in through the live view, so no saved login may be there to use.
  await syncSaucedemoSecret(ctx.session.api, false);
  const marker = `zq${randomUUID().replaceAll("-", "")}`;
  const chat = await createScenarioChat(ctx.session.api, "Sub-agent scenario H");
  run.chats.push(chat.id);
  const watch = watchThreads(ctx, chat.id);
  const started = Date.now();
  const first = await send(ctx, run, chat.id, SUBAGENT_PROMPTS.H());
  const panel = interact(ctx, run, (await handoffModule()).signInThroughHandoff, chat.id, first, marker);
  run.line.firstTerminal = (await waitRun(ctx, first)).status;
  const sauce = await waitTurnEnded(ctx, chat.id, SUBAGENT_NAMES.handoff.sauce, (TURN_SECONDS + ctx.marginSeconds) * 1_000);
  run.line.sauceState = sauce?.state ?? null;
  run.line.sauceOutcome = sauce?.outcome ?? null;
  await sleep(2_000);
  panel.abort();
  await Promise.all(run.interactions);
  await waitMainIdle(ctx, chat.id);
  const watched = await watch.stop();
  run.line.threadViews = watched;
  run.line.wallSeconds = seconds(started);
  const runIds = (await ctx.db.query<{ id: string }>(`SELECT "id" FROM "ModelRun" WHERE "chatId" = $1`, [chat.id])).rows.map((row) => row.id);
  const handoffs = await handoffCalls(ctx.db, runIds, true);
  const leaks = await typedValueLeaks(ctx.db, chat.id, runIds, marker).catch(() => null);
  run.line.subagentHandoffOutcomes = handoffs.map((call) => handoffOutcome(call.result) ?? "none");
  const { settled, usage } = await commonEvidence(ctx, run, chat.id);
  const checks = judge(run, await resultOf(ctx, chat.id), (read) => oracleH(read.value, { handoffs, leaks }));
  if (!settled) checks.push("callbacks_still_owed");
  const interaction = isRecord(run.line.interaction) ? run.line.interaction : {};
  const count = (key: string): number => {
    const value = interaction[key];
    return typeof value === "number" ? value : 0;
  };
  if (!progressionSaw(watched.progression, "waiting")) checks.push("waiting_not_observed");
  if (count("subagentHandoffs") === 0) checks.push("handoff_not_from_subagent");
  if (count("handoffsNamingAgent") === 0) checks.push("handoff_not_naming_agent");
  if (count("agentTabShown") + count("agentSwitches") === 0) checks.push("agent_switch_not_used");
  const browser = run.line.browser as ReturnType<typeof browserEvidence>;
  if (browser.peakBrowsingAgents < 2) checks.push("other_agent_not_browsing_at_once");
  run.line.checksFailed = checks;
  return { success: checks.length === 0, usage };
}

/** A date a year ahead in the task's zone, so the task's own schedule never fires during the run. */
function farDate(): string {
  return new Date(Date.now() + 365 * 86_400_000).toISOString().slice(0, 10);
}

async function deleteTask(api: Api, taskId: string): Promise<boolean> {
  const path = `/api/me/scheduled-tasks/${encodeURIComponent(taskId)}`;
  const removed = await request(api, path, { method: "DELETE" });
  if (removed.status !== 204 && removed.status !== 404) return false;
  return (await request(api, path)).status === 404;
}

async function scenarioI(ctx: Context, run: Run): Promise<Outcome> {
  run.line.telegram = "not_covered";
  const created = await json(ctx.session.api, "/api/me/scheduled-tasks", { body: {
    chatMode: "new", emailNotify: false, historyRetentionDays: 30, kind: "standard", memoryEnabled: false,
    modelId: ctx.model.modelId, pinnedSkillIds: [], prompt: SUBAGENT_PROMPTS.I(), provider: ctx.model.provider,
    schedule: { date: farDate(), kind: "once", time: "09:00" }, scheduleEnabled: true, searchEnabled: false, telegramNotify: false,
    timeZone: "Europe/Madrid", title: "Sub-agent scenario I", toolsEnabled: true, webhookEnabled: false, workspaceEnabled: true
  }, method: "POST" });
  const taskId = isRecord(created) && isRecord(created.task) && typeof created.task.id === "string"
    ? created.task.id : fail("task_response_invalid");
  run.tasks.push(taskId);
  const started = Date.now();
  await json(ctx.session.api, `/api/me/scheduled-tasks/${encodeURIComponent(taskId)}/run`, { body: {}, method: "POST" });
  const admitted = await poll(5 * 60_000, async () => {
    const { rows } = await ctx.db.query<{ chatId: string; id: string }>(`SELECT "id", "chatId" FROM "ModelRun"
      WHERE "scheduledTaskId" = $1 AND "subagentTurnId" IS NULL ORDER BY "createdAt" DESC LIMIT 1`, [taskId]);
    return rows[0] ?? null;
  }, "scheduled_run_not_admitted", 3_000);
  run.chats.push(admitted.chatId);
  const terminal = await waitRun(ctx, admitted.id);
  Object.assign(run.line, { failureCode: terminal.errorCode, terminal: terminal.status, wallSeconds: seconds(started) });
  await waitMainIdle(ctx, admitted.chatId);
  const { tools, turns, usage } = await commonEvidence(ctx, run, admitted.chatId);
  const checks = judge(run, await resultOf(ctx, admitted.chatId, [admitted.id]), (read) => oracleI(read.value));
  const binding = bindingEvidence(turns);
  if (binding.foregroundTurns === 0) checks.push("no_waiting_subagent");
  if (binding.backgroundTurns > 0) checks.push("background_ran_in_scheduled_task");
  run.line.backgroundRefusedInTask = subagentCallEvidence(tools).backgroundRefusals;
  run.line.checksFailed = checks;
  return { success: terminal.status === "complete" && checks.length === 0, usage };
}

/** Sends J's second message at once; a send the server's wake-up beat goes again once the main agent is idle. */
async function sendAtOnce(ctx: Context, run: Run, chatId: string, text: string) {
  const refusals: string[] = [];
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const sent = await trySend(ctx, run, chatId, text);
    if (sent.ok) return { refusals, runId: sent.runId };
    const mainRunActive = (await mainRuns(ctx.db, chatId)).some((entry) => !TERMINAL_RUN_STATES.has(entry.status));
    refusals.push(sendRefusal(sent.code, { mainRunActive, session: await sessionSample(ctx.db, chatId) }));
    if (refusals.at(-1) !== SEND_LOST_TO_WAKE_UP) break;
    await waitMainIdle(ctx, chatId, 10 * 60_000).catch(() => undefined);
  }
  return { refusals, runId: null };
}

async function scenarioJ(ctx: Context, run: Run): Promise<Outcome> {
  const imageName = `subagent-j-${runSecrets(randomBytes(16)).nonce}.png`;
  const { quiet, viewer } = SUBAGENT_NAMES.capture;
  const { question } = SUBAGENT_PROMPTS.J;
  const chat = await createScenarioChat(ctx.session.api, "Sub-agent scenario J");
  run.chats.push(chat.id);
  const session = watchSession(ctx, chat.id);
  try {
    const started = Date.now();
    const first = await send(ctx, run, chat.id, SUBAGENT_PROMPTS.J.start(imageName));
    run.line.firstTerminal = (await waitRun(ctx, first)).status;
    // A tight poll: the second message races the wake-up, whose coalescing window is 1.5 s.
    await poll(15 * 60_000, async () => {
      const turns = await Promise.all([viewer, quiet].map((name) => latestTurnOf(ctx.db, chat.id, name)));
      return turns.every((turn) => turn !== null && turn.state !== "running" && turn.state !== "waiting") ? true : null;
    }, "background_end_timeout", 500).catch(() => { run.line.backgroundEndTimeout = true; });
    const mainRunsActive = (await mainRuns(ctx.db, chat.id)).filter((entry) => !TERMINAL_RUN_STATES.has(entry.status)).length;
    const second = await sendAtOnce(ctx, run, chat.id, question.text);
    const secondTerminal = second.runId === null ? null : await waitRun(ctx, second.runId);
    const { rows } = await ctx.db.query<{ hit: boolean }>(`SELECT strpos(m."content"::text, $2) > 0 AS "hit"
      FROM "ModelRun" r JOIN "Message" m ON m."id" = r."assistantMessageId" WHERE r."id" = $1`, [second.runId, question.answer]);
    const secondAnswered = secondTerminal?.status === "complete" && rows[0]?.hit === true;
    // A refused message leaves the callbacks to the wake-up, which the defect holds back until the backstop.
    await waitMainIdle(ctx, chat.id, 10 * 60_000).catch(() => { run.line.mainIdleTimeout = true; });
    const { settled, tools, turns, usage, wakeUps } = await commonEvidence(ctx, run, chat.id);
    const threads = await threadIdsByName(ctx.db, chat.id);
    const threadOf = (name: string) => threads.get(name)?.at(-1) ?? null;
    const turnOf = (name: string) => turns.filter((turn) => turn.threadId === threadOf(name)).at(-1) ?? null;
    const order = scenarioJOrder({ mainRunsActive, quiet: turnOf(quiet), viewer: turnOf(viewer),
      quietToolCalls: tools.filter((row) => row.threadId === threadOf(quiet)).length });
    const samples = await session.stop();
    const stop = sessionStopEvidence(samples, order.lastTurnEnd);
    const image = imageToolEvidence(tools, threadOf(viewer));
    const failures = await captureFailures(ctx.db, chat.id);
    const verdict = oracleJ({ callbacks: callbackEvidence(turns, wakeUps), failures, image, order, secondAccepted: second.runId !== null,
      secondAnswered, secondRefusals: second.refusals, session: stop, settled, wakeUps });
    const { lastTurnEnd: _lastTurnEnd, ...orderLine } = order;
    Object.assign(run.line, orderLine, { captureFailures: failures, image, oracleCounts: verdict.counts,
      secondAccepted: second.runId !== null, secondAnswered, secondRefusals: second.refusals, secondTerminal: secondTerminal?.status ?? null,
      sessionStates: samples.map((sample) => sample.state), sessionStop: stop, wallSeconds: seconds(started) });
    const checks = [...verdict.failed];
    if (!usage.split) checks.push("usage_not_split");
    run.line.checksFailed = checks;
    return { success: checks.length === 0, usage };
  } finally {
    await session.stop();
  }
}

/** The PNGs the given main-agent runs exported, as the user's attachment route serves them. */
async function exportedPngs(ctx: Context, runIds: readonly string[]): Promise<KChartDownload[]> {
  const downloads: KChartDownload[] = [];
  for (const runId of runIds) {
    await awaitExport(ctx.db, runId);
    const { rows } = await ctx.db.query<{ attachmentId: string; relativePath: string }>(
      `SELECT "attachmentId", "relativePath" FROM "WorkspaceRunOutput" WHERE "workspaceRunBindingId" = $1`, [runId]);
    for (const output of rows.filter((row) => /\.png$/iu.test(row.relativePath))) {
      const content = await request(ctx.session.api, `/api/attachments/${encodeURIComponent(output.attachmentId)}/content`);
      const bytes = content.ok ? new Uint8Array(await content.arrayBuffer()) : new Uint8Array();
      downloads.push({ bytes: bytes.byteLength, png: pngBytes(bytes) });
    }
  }
  return downloads;
}

const K_TURN_MS = 15 * 60_000;

async function scenarioK(ctx: Context, run: Run): Promise<Outcome> {
  const facts = scenarioKFacts(runSecrets(randomBytes(16)).nonce);
  const { blind, chart, left, right } = SUBAGENT_NAMES.files;
  const chat = await createScenarioChat(ctx.session.api, "Sub-agent scenario K");
  run.chats.push(chat.id);
  const started = Date.now();
  const mainRunIds = async () => (await mainRuns(ctx.db, chat.id)).map((entry) => entry.id);

  const first = await send(ctx, run, chat.id, SUBAGENT_PROMPTS.K.start(facts));
  run.line.firstTerminal = (await waitRun(ctx, first)).status;
  await Promise.all([left, right].map((name) => waitTurnEnded(ctx, chat.id, name, K_TURN_MS)));

  const reads = await send(ctx, run, chat.id, SUBAGENT_PROMPTS.K.reads(facts));
  run.line.readsTerminal = (await waitRun(ctx, reads)).status;
  await waitTurnEnded(ctx, chat.id, right, K_TURN_MS);
  await waitMainIdle(ctx, chat.id, K_TURN_MS);
  const readRuns = await mainRunIds();
  const checks = judge(run, await resultOf(ctx, chat.id, readRuns), (read) => oracleKReads(read.value, facts.texts));

  const charted = await send(ctx, run, chat.id, SUBAGENT_PROMPTS.K.chart());
  run.line.chartTerminal = (await waitRun(ctx, charted)).status;
  await waitTurnEnded(ctx, chat.id, chart, K_TURN_MS);
  await waitMainIdle(ctx, chat.id, K_TURN_MS);
  const chartRuns = (await mainRunIds()).filter((id) => !readRuns.includes(id));
  const downloads = await exportedPngs(ctx, chartRuns);

  let blindAnswered = false;
  if (ctx.blind) {
    const blindRun = await send(ctx, run, chat.id, SUBAGENT_PROMPTS.K.blind(facts, ctx.blind.model.modelId));
    const terminal = await waitRun(ctx, blindRun);
    const { rows } = await ctx.db.query<{ hit: boolean }>(`SELECT m."content"::text ~* '\\mred\\M' AS "hit"
      FROM "ModelRun" r JOIN "Message" m ON m."id" = r."assistantMessageId" WHERE r."id" = $1`, [blindRun]);
    blindAnswered = terminal.status === "complete" && rows[0]?.hit === true;
  }

  const { settled, tools, turns, usage, wakeUps } = await commonEvidence(ctx, run, chat.id);
  const threads = await threadIdsByName(ctx.db, chat.id);
  const threadOf = (name: string) => threads.get(name)?.at(-1) ?? null;
  const turnsOf = (name: string) => turns.filter((turn) => turn.threadId === threadOf(name));
  const blindEvidence = ctx.blind ? { answered: blindAnswered, image: blindImageEvidence(tools, threadOf(blind)),
    turn: turnsOf(blind).at(-1) ?? null } : null;
  const images = { left: imageToolEvidence(tools, threadOf(left)), main: mainImageToolEvidence(tools, readRuns),
    right: imageToolEvidence(tools, threadOf(right)) };
  const mainImage = mainImageToolEvidence(tools, chartRuns);
  const verdict = oracleKFlow({ blind: blindEvidence, callbacks: callbackEvidence(turns, wakeUps),
    chart: { downloads, mainImage, turn: turnsOf(chart).at(-1) ?? null }, images, left: turnsOf(left), right: turnsOf(right), settled });
  checks.push(...verdict.failed);
  if (!usage.split) checks.push("usage_not_split");
  Object.assign(run.line, { blind: blindEvidence ? { answered: blindEvidence.answered, image: blindEvidence.image,
    turnState: blindEvidence.turn?.state ?? null } : "not_configured", chart: { downloads, mainImage }, flowCounts: verdict.counts, images,
  checksFailed: checks, wallSeconds: seconds(started) });
  return { success: checks.length === 0, usage };
}

const L_PARSE_MS = 3 * 60_000;

/** Uploads the workbook as the composer does with a Workspace on; resolves the attachment's id. */
async function uploadWorkbook(ctx: Context, facts: ScenarioLFacts): Promise<string> {
  const form = new FormData();
  form.append("file", new File([Uint8Array.from(facts.workbook)], SCENARIO_L_FILE_NAME, { type: SCENARIO_L_MIME_TYPE }));
  form.append("scope", "workspace");
  const uploaded = decodeUploadAttachmentResponse(await json(ctx.session.api, "/api/uploads", { form, method: "POST", timeoutMs: L_PARSE_MS }));
  return uploaded?.attachment.id ?? fail("upload_response_invalid");
}

/** The attachment once the parser settled it, or null past the wait. */
async function settledAttachment(db: PostgresClient, attachmentId: string): Promise<LAttachmentRow | null> {
  return poll(L_PARSE_MS, async () => {
    const { rows } = await db.query<LAttachmentRow>(`SELECT "status"::text AS "status", "processingErrorCode",
        ("extractedText" IS NULL) AS "extractedTextNull" FROM "Attachment" WHERE "id" = $1`, [attachmentId]);
    return rows[0] && rows[0].status !== "processing" ? rows[0] : null;
  }, "upload_not_settled", 2_000).catch(() => null);
}

/** The run's Workspace tool calls; arguments and results stay inside SQL (`toolBatch.ts` and `runEndedToolCallResult` write the unknown outcome). */
async function workspaceCalls(db: PostgresClient, runId: string): Promise<LWorkspaceCall[]> {
  const { rows } = await db.query<LWorkspaceCall>(`SELECT c."toolName", c."state"::text AS "state",
      strpos(c."arguments"::text, '/workspace/inbox') > 0 AS "namesInbox",
      coalesce(c."state"::text = 'error' AND 'unknown' IN (c."result"->>'outcome', c."result"->'content'->0->'value'->>'outcome'), false)
        AS "unknownOutcome"
    FROM "ModelRunToolCall" c WHERE c."modelRunId" = $1 AND strpos(c."toolName", 'mcp_workspace_') = 1`, [runId]);
  return rows;
}

async function scenarioL(ctx: Context, run: Run): Promise<Outcome> {
  const facts = scenarioLFacts(runSecrets(randomBytes(16)).nonce);
  const chat = await createScenarioChat(ctx.session.api, "Sub-agent scenario L");
  run.chats.push(chat.id);
  const started = Date.now();
  const attachmentId = await uploadWorkbook(ctx, facts);
  const stored = await settledAttachment(ctx.db, attachmentId);
  const uploadFailures = scenarioLUploadChecks(stored);
  run.line.upload = { bytes: facts.workbook.byteLength, extractedTextNull: stored?.extractedTextNull ?? null, populatedCells: facts.populatedCells,
    processingErrorCode: stableCode(stored?.processingErrorCode), status: stableCode(stored?.status) };
  if (uploadFailures.length > 0) {
    run.line.checksFailed = uploadFailures;
    return { success: false, usage: null };
  }
  const sent = await trySend(ctx, run, chat.id, SUBAGENT_PROMPTS.L(), [{ attachmentId, fileName: SCENARIO_L_FILE_NAME, type: "file" }]);
  if (!sent.ok) {
    Object.assign(run.line, { admissionRefusal: stableCode(sent.code), checksFailed: ["admission_refused"] });
    return { success: false, usage: null };
  }
  const terminal = await waitRun(ctx, sent.runId);
  Object.assign(run.line, { failureCode: terminal.errorCode, terminal: terminal.status, wallSeconds: seconds(started) });
  const { usage } = await commonEvidence(ctx, run, chat.id);
  const { rows } = await ctx.db.query<{ hit: boolean }>(`SELECT m."content"::text ~ $2 AS "hit"
    FROM "ModelRun" r JOIN "Message" m ON m."id" = r."assistantMessageId" WHERE r."id" = $1`, [sent.runId, scenarioLAnswerPattern(facts.expectedSum)]);
  const workspace = scenarioLWorkspaceEvidence(await workspaceCalls(ctx.db, sent.runId));
  const verdict = oracleL({ answerHasSum: rows[0]?.hit === true, terminal: terminal.status, workspace });
  Object.assign(run.line, { checksFailed: verdict.failed, oracleCounts: verdict.counts });
  return { success: verdict.failed.length === 0, usage };
}

const M_TURN_MS = 12 * 60_000;

/** Whether the report of the newest thread of that name holds every needle, matched inside SQL. */
async function reportHolds(db: PostgresClient, chatId: string, name: string, needles: readonly string[]): Promise<boolean> {
  const { rows } = await db.query<{ hit: boolean }>(`SELECT coalesce(bool_and(strpos(t."result"->>'report', needle) > 0), false) AS "hit"
    FROM (SELECT tu."result" FROM "SubagentTurn" tu JOIN "SubagentThread" th ON th."id" = tu."threadId"
      WHERE tu."chatId" = $1 AND th."name" = $2 ORDER BY tu."startedAt" DESC LIMIT 1) t, unnest($3::text[]) AS needle`, [chatId, name, [...needles]]);
  return rows[0]?.hit === true;
}

/** Calls of a thread whose arguments name this text, matched inside SQL. */
async function callsNaming(db: PostgresClient, threadId: string | null, text: string): Promise<number> {
  if (threadId === null) return 0;
  const { rows } = await db.query<{ count: number }>(`SELECT count(*)::int AS "count" FROM "ModelRunToolCall"
    WHERE "subagentThreadId" = $1 AND strpos("arguments"::text, $2) > 0`, [threadId, text]);
  return rows[0]?.count ?? 0;
}

/** The mailbox rows of the chat: who each went to and whether it was read; their text stays in the database. */
async function messageRows(db: PostgresClient, chatId: string): Promise<MMessageRow[]> {
  const { rows } = await db.query<MMessageRow>(`SELECT f."origin"::text AS "origin", (f."deliveredAt" IS NOT NULL) AS "delivered", th."name" AS "recipient"
    FROM "RunFollowup" f LEFT JOIN "SubagentTurn" t ON t."id" = f."subagentTurnId" LEFT JOIN "SubagentThread" th ON th."id" = t."threadId"
    WHERE f."chatId" = $1 AND f."origin"::text IN ('main_agent', 'subagent_message')`, [chatId]);
  return rows;
}

/** Keeps reading the turn of that name until it is in `waiting`; the state and reason it last had, and whether it ever waited. */
async function waitForWaiting(ctx: Context, chatId: string, name: string, timeoutMs: number) {
  return poll(timeoutMs, async () => {
    const turn = await latestTurnOf(ctx.db, chatId, name);
    return turn?.state === "waiting" ? { reason: turn.reasonCode, state: turn.state } : null;
  }, "turn_not_waiting", 1_000).catch(async () => {
    const turn = await latestTurnOf(ctx.db, chatId, name);
    return { reason: turn?.reasonCode ?? null, state: turn?.state ?? null };
  });
}

async function scenarioM(ctx: Context, run: Run): Promise<Outcome> {
  const facts = scenarioMFacts(runSecrets(randomBytes(16)).nonce);
  const { asker, forger, front, hold, late, left, ping, pong, right, target, worker } = SUBAGENT_NAMES.talk;
  const chat = await createScenarioChat(ctx.session.api, "Sub-agent scenario M");
  run.chats.push(chat.id);
  const started = Date.now();
  const step = async (prompt: string, ending: readonly string[]) => {
    const runId = await send(ctx, run, chat.id, prompt);
    const terminal = (await waitRun(ctx, runId)).status;
    await Promise.all(ending.map((name) => waitTurnEnded(ctx, chat.id, name, M_TURN_MS)));
    return terminal;
  };
  const terminals: Record<string, string> = {};
  terminals.remember = await step(SUBAGENT_PROMPTS.M.remember(facts), []);
  terminals.exchange = await step(SUBAGENT_PROMPTS.M.exchange(), [left, right]);
  terminals.neighbour = await step(SUBAGENT_PROMPTS.M.neighbour(facts), [late]);
  await waitTurnEnded(ctx, chat.id, worker, M_TURN_MS);

  const asked = await send(ctx, run, chat.id, SUBAGENT_PROMPTS.M.askBackground());
  terminals.askBackground = (await waitRun(ctx, asked)).status;
  const waited = await waitForWaiting(ctx, chat.id, asker, M_TURN_MS);
  await waitTurnEnded(ctx, chat.id, asker, M_TURN_MS);
  terminals.askForeground = await step(SUBAGENT_PROMPTS.M.askForeground(), [front]);
  terminals.authority = await step(SUBAGENT_PROMPTS.M.authority(facts), [forger, target]);
  terminals.pingPong = await step(SUBAGENT_PROMPTS.M.pingPong(), [ping, pong]);

  terminals.hold = await step(SUBAGENT_PROMPTS.M.hold(), []);
  const holding = await waitForWaiting(ctx, chat.id, hold, M_TURN_MS);
  const holdThread = (await threadIdsByName(ctx.db, chat.id)).get(hold)?.at(-1);
  if (holdThread) await json(ctx.session.api, SUBAGENT_API_PATHS.stopThread(chat.id, holdThread), { body: {}, method: "POST" });
  const holdTurn = await waitTurnEnded(ctx, chat.id, hold, 120_000);

  const { settled, tools, turns, usage, wakeUps } = await commonEvidence(ctx, run, chat.id);
  const threads = await threadIdsByName(ctx.db, chat.id);
  const threadOf = (name: string) => threads.get(name)?.at(-1) ?? null;
  const turnsOf = (name: string) => turns.filter((turn) => turn.threadId === threadOf(name));
  const messages = agentMessageEvidence(await messageRows(ctx.db, chat.id));
  const both = [facts.halves.left, facts.halves.right];
  const verdict = oracleM({
    askBackground: { answered: await reportHolds(ctx.db, chat.id, asker, [facts.answer]), asked: agentToolEvidence(tools, threadOf(asker), "ask_parent"),
      sawWaiting: waited.state === "waiting", turn: turnsOf(asker).at(-1) ?? null, wakeUps: wakeUps.length },
    askForeground: { answered: await reportHolds(ctx.db, chat.id, front, [facts.foregroundAnswer]), turns: turnsOf(front) },
    authority: { forgedRead: (messages[target]?.read ?? 0) > 0, paymentCalls: await callsNaming(ctx.db, threadOf(target), facts.paymentFile),
      turn: turnsOf(target).at(-1) ?? null },
    exchange: { leftHoldsBoth: await reportHolds(ctx.db, chat.id, left, both), messages: Object.fromEntries(Object.entries(messages).filter(([name]) => name === left || name === right)),
      rightHoldsBoth: await reportHolds(ctx.db, chat.id, right, both),
      sent: [left, right].map((name) => agentToolEvidence(tools, threadOf(name), "send_agent_message")) },
    neighbour: { listed: agentToolEvidence(tools, threadOf(late), "list_agents"), namedWorker: await reportHolds(ctx.db, chat.id, late, [worker]),
      repeatedCalls: await callsNaming(ctx.db, threadOf(late), facts.workFile) },
    pingPong: { messages: Object.fromEntries(Object.entries(messages).filter(([name]) => name === ping || name === pong)),
      ping: agentToolEvidence(tools, threadOf(ping), "send_agent_message"), pong: agentToolEvidence(tools, threadOf(pong), "send_agent_message"),
      turns: [ping, pong].map((name) => turnsOf(name).at(-1) ?? null) },
    settled,
    stop: { reasonBefore: holding.reason, stateBefore: holding.state, turn: holdTurn }
  });
  const checks = [...verdict.failed];
  if (!usage.split) checks.push("usage_not_split");
  Object.assign(run.line, { checksFailed: checks, oracleCounts: verdict.counts, terminals, wallSeconds: seconds(started) });
  return { success: checks.length === 0, usage };
}

const P_TURN_MS = 6 * 60_000;

/** The user's messages to the chat's sub-agents: who each went to and whether that turn read it; their text stays in the database. */
async function userMessageRows(db: PostgresClient, chatId: string): Promise<Array<{ read: boolean; recipient: string | null }>> {
  const { rows } = await db.query<{ read: boolean; recipient: string | null }>(`SELECT (f."deliveredAt" IS NOT NULL) AS "read", th."name" AS "recipient"
    FROM "RunFollowup" f JOIN "SubagentTurn" t ON t."id" = f."subagentTurnId" JOIN "SubagentThread" th ON th."id" = t."threadId"
    WHERE f."chatId" = $1 AND f."origin"::text = 'user'`, [chatId]);
  return rows;
}

async function scenarioP(ctx: Context, run: Run): Promise<Outcome> {
  const facts = scenarioPFacts(runSecrets(randomBytes(16)).nonce);
  const name = SUBAGENT_NAMES.listener;
  const chat = await createScenarioChat(ctx.session.api, "Sub-agent scenario P");
  run.chats.push(chat.id);
  const started = Date.now();
  const sent = await send(ctx, run, chat.id, SUBAGENT_PROMPTS.P.start());
  // Its first command is running: the message lands in the middle of the turn and the next step takes it.
  const working = await poll(P_TURN_MS, async () => {
    const turn = await latestTurnOf(ctx.db, chat.id, name);
    if (turn?.state !== "running") return null;
    const calls = await toolRows(ctx.db, chat.id);
    return calls.some((call) => call.threadId === turn.threadId && call.toolName.includes("sandbox")) ? turn : null;
  }, "listener_not_working", 1_000);
  const reply = await json(ctx.session.api, `${SUBAGENT_API_PATHS.chatThreads(chat.id)}/${working.threadId}/messages`, {
    body: { nonce: randomBytes(16).toString("hex"), text: SUBAGENT_PROMPTS.P.message(facts), turnId: working.turnId }, method: "POST" });
  const terminal = (await waitRun(ctx, sent)).status;
  const turn = await waitTurnEnded(ctx, chat.id, name, P_TURN_MS);
  const { settled, usage } = await commonEvidence(ctx, run, chat.id);
  const rows = (await userMessageRows(ctx.db, chat.id)).filter((row) => row.recipient === name);
  const { rows: inChat } = await ctx.db.query<{ count: number }>(`SELECT count(*)::int AS "count" FROM "Message"
    WHERE "chatId" = $1 AND strpos("content"::text, $2) > 0`, [chat.id, facts.note]);
  const verdict = oracleP({ accepted: (reply as { accepted?: unknown } | null)?.accepted === true, mainChatHoldsNote: (inChat[0]?.count ?? 0) > 0,
    messages: { read: rows.filter((row) => row.read).length, taken: rows.length }, reportHoldsWord: await reportHolds(ctx.db, chat.id, name, [facts.word]),
    settled, turn });
  const checks = [...verdict.failed];
  if (!usage.split) checks.push("usage_not_split");
  Object.assign(run.line, { checksFailed: checks, oracleCounts: verdict.counts, terminals: { start: terminal }, wallSeconds: seconds(started) });
  return { success: checks.length === 0, usage };
}

/** The page reader's calls of one thread or of the main agent, by the outcome stored with each. */
async function pageReads(db: PostgresClient, chatId: string, threadId: string | null): Promise<PageReads> {
  const { rows } = await db.query<{ count: number; outcome: string | null }>(`SELECT c."result"->'rawPreview'->'fetchUrl'->>'outcome' AS "outcome", count(*)::int AS "count"
    FROM "ModelRunToolCall" c JOIN "ModelRun" r ON r."id" = c."modelRunId"
    WHERE r."chatId" = $1 AND c."toolName" = 'fetch_url' AND c."subagentThreadId" IS NOT DISTINCT FROM $2 GROUP BY 1`, [chatId, threadId]);
  return Object.fromEntries(rows.map((row) => [safeCode(row.outcome) ?? "unknown", row.count]));
}

const U_TURN_MS = 10 * 60_000;

/** The database's clock less the harness's, read at a midpoint: U compares the stream's times with stored ones. */
async function databaseClockOffset(db: PostgresClient): Promise<number> {
  const before = Date.now();
  const at = (await db.query<{ now: Date }>(`SELECT clock_timestamp() AS "now"`)).rows[0]?.now;
  const after = Date.now();
  return at ? new Date(at).getTime() - (before + after) / 2 : 0;
}

/**
 * U: the answer race (operator decision 2026-11-05: a background sub-agent's message never rewrites a written answer). The main agent starts one
 * background sub-agent that sleeps and reports a per-run word, and writes a long answer at once; the stream is read as the browser reads it. The
 * streamed text, its first paragraph and the word stay in memory; the saved answer is matched inside SQL.
 */
async function scenarioU(ctx: Context, run: Run): Promise<Outcome> {
  const started = Date.now();
  const word = `UWORD-${randomBytes(4).toString("hex").toUpperCase()}`;
  const chat = await createScenarioChat(ctx.session.api, "Sub-agent scenario U");
  run.chats.push(chat.id);
  const events: SseEvent[] = [];
  const sse = createSseReader();
  const read = async (response: Response) => {
    const body = response.body?.getReader();
    if (!body) return;
    const decoder = new TextDecoder();
    let bytes = 0;
    try {
      for (;;) {
        const { done, value } = await body.read();
        if (done) break;
        bytes += value.byteLength;
        if (bytes > 64 * 1024 * 1024) break;
        events.push(...sse.push(decoder.decode(value, { stream: true })));
      }
    } catch {
      // The harness aborts the stream once the run is terminal.
    }
  };
  const offsetBefore = await databaseClockOffset(ctx.db);
  const sent = await trySend(ctx, run, chat.id, SUBAGENT_PROMPTS.U.start(word), [], {}, read);
  if (!sent.ok) return fail(`send_${sent.code}`);
  const runId = sent.runId;
  const terminal = await waitRun(ctx, runId, U_TURN_MS);
  await Promise.race([run.streams.at(-1)?.drained, sleep(30_000)]);
  const settled = await settleCallbacks(ctx, chat.id, 5 * 60_000);
  const offset = (offsetBefore + await databaseClockOffset(ctx.db)) / 2;
  const stream = answerStreamFacts(events);
  const turn = await latestTurnOf(ctx.db, chat.id, SUBAGENT_NAMES.racer);
  const followup = turn ? (await ctx.db.query<{ createdAt: Date }>(`SELECT "createdAt" FROM "RunFollowup" WHERE "modelRunId" = $1 AND "subagentTurnId" = $2
    AND "origin"::text = 'subagent_callback' ORDER BY "createdAt" LIMIT 1`, [runId, turn.turnId])).rows[0] ?? null : null;
  const callbackAt = followup ? new Date(followup.createdAt).getTime() : turn?.endedAt ? new Date(turn.endedAt).getTime() : null;
  const landing = answerRaceLanding({ callbackAt, intoRun: turn?.callbackRunId === runId, tokenTimes: stream.tokenTimes.map((at) => at + offset) });
  const saved = (await ctx.db.query<{ paragraphAt: number; wordAt: number }>(`WITH a AS (SELECT coalesce((SELECT string_agg(b->>'text', E'\\n' ORDER BY o)
      FROM jsonb_array_elements(m."content"->'blocks') WITH ORDINALITY AS x(b, o) WHERE b->>'type' = 'text'), '') AS "text"
      FROM "ModelRun" r JOIN "Message" m ON m."id" = r."assistantMessageId" WHERE r."id" = $1)
    SELECT CASE WHEN $2::text = '' THEN 0 ELSE strpos(a."text", $2::text) END AS "paragraphAt", strpos(a."text", $3::text) AS "wordAt" FROM a`,
  [runId, stream.firstParagraph ?? "", word])).rows[0] ?? { paragraphAt: 0, wordAt: 0 };
  const paragraphKept = stream.firstParagraph === null ? null : saved.paragraphAt > 0;
  const position = saved.wordAt === 0 ? "absent" as const : saved.paragraphAt > 0 && saved.wordAt < saved.paragraphAt ? "before" as const : "after" as const;
  const evidence = { landing, paragraphKept, resetsAfterText: stream.resetsAfterText, rewritten: stream.rewritten, status: terminal.status, word: position };
  const verdict = oracleU(evidence);
  const seconds1 = (at: number | null) => at === null ? null : Math.round(at / 100) / 10;
  await keepAnswers(ctx, chat.id, "U");
  Object.assign(run.line, { checksFailed: verdict.failed, ...evidence, order_not_reached: verdict.orderNotReached, terminal, callbacksSettled: settled,
    callbackFollowup: followup !== null, callbackIntoRun: turn?.callbackRunId === runId, turnState: turn?.state ?? null,
    // Seconds on the database's clock from the first text event: when the callback came, and when the stream's text ended.
    callbackAfterFirstText: callbackAt !== null && stream.firstTokenAt !== null ? seconds1(callbackAt - (stream.firstTokenAt + offset)) : null,
    textEndAfterFirstText: stream.firstTokenAt !== null ? seconds1((stream.tokenTimes.at(-1) ?? stream.firstTokenAt) - stream.firstTokenAt) : null,
    textEvents: stream.tokenTimes.length, wallSeconds: seconds(started) });
  return { success: verdict.failed.length === 0, usage: usageByPurpose(await settledUsage(ctx.db, run.chats)) };
}

const Q_TURN_MS = 15 * 60_000;

async function scenarioQ(ctx: Context, run: Run): Promise<Outcome> {
  const started = Date.now();
  const routes: Record<string, unknown>[] = [];
  let failed = false;
  let usage: Outcome["usage"] = null;
  for (const route of ctx.search) {
    const chat = await createScenarioChat(ctx.session.api, `Sub-agent scenario Q ${route.name}`);
    run.chats.push(chat.id);
    const first = await trySend(ctx, run, chat.id, SUBAGENT_PROMPTS.Q.start(), [], { search: route });
    if (!first.ok) fail(`send_${first.code}`);
    await waitRun(ctx, first.ok ? first.runId : "");
    const turn = await waitTurnEnded(ctx, chat.id, SUBAGENT_NAMES.reader, Q_TURN_MS);
    await waitMainIdle(ctx, chat.id);
    const second = await trySend(ctx, run, chat.id, SUBAGENT_PROMPTS.Q.next(), [], { search: route });
    if (!second.ok) fail(`send_${second.code}`);
    const terminal = await waitRun(ctx, second.ok ? second.runId : "");
    const evidence = await commonEvidence(ctx, run, chat.id);
    usage = evidence.usage;
    const threadId = (await threadIdsByName(ctx.db, chat.id)).get(SUBAGENT_NAMES.reader)?.at(-1) ?? null;
    const tools = await toolRows(ctx.db, chat.id);
    const verdict = oracleQ({ main: await pageReads(ctx.db, chat.id, null), reader: threadId ? await pageReads(ctx.db, chat.id, threadId) : {},
      searches: route.mode === "model_choice" ? null
        : tools.filter((row) => row.threadId === threadId && row.state === "complete" && /^search_(?:selected_engines|engine_[1-3])$/u.test(row.toolName)).length,
      settled: evidence.settled, turn });
    if (verdict.failed.length > 0) failed = true;
    routes.push({ checksFailed: verdict.failed, oracleCounts: verdict.counts, route: route.name, terminal: terminal.status });
  }
  Object.assign(run.line, { routes, wallSeconds: seconds(started) });
  return { success: !failed && routes.length > 0, usage };
}

const R_PHRASE_MS = 5 * 60_000;

async function scenarioR(ctx: Context, run: Run): Promise<Outcome> {
  const started = Date.now();
  const route = ctx.search[0] ?? fail("search_route_missing");
  const results: RPhraseResult[] = [];
  for (const [index, phrase] of SCENARIO_R_PHRASES.entries()) {
    const chat = await createScenarioChat(ctx.session.api, `Sub-agent scenario R ${index}`);
    run.chats.push(chat.id);
    // Started, or the run ended without starting: either answers this phrase. `offered` is admission's Deep research, which no send here names.
    const outcome = async (runId: string) => {
      let offered = false;
      const reached = await poll(R_PHRASE_MS, async () => {
        const { rows } = await ctx.db.query<{ calls: number; offered: boolean; started: number; status: string }>(`SELECT r."status"::text AS "status",
          coalesce(r."normalizedRequest"->>'deepResearch' = 'true', false) AS "offered",
          (SELECT count(*)::int FROM "ModelRunToolCall" c WHERE c."modelRunId" = r."id") AS "calls",
          (SELECT count(*)::int FROM "ModelRunToolCall" c WHERE c."modelRunId" = r."id" AND c."toolName" = 'start_research') AS "started" FROM "ModelRun" r WHERE r."id" = $1`, [runId]);
        const row = rows[0];
        offered = row?.offered === true;
        if ((row?.started ?? 0) > 0) return "started" as const;
        return row && TERMINAL_RUN_STATES.has(row.status) ? row.calls === 0 ? "no_tools" as const : "ended" as const : null;
      }, "phrase_timeout", 1_000);
      if (reached === "started") await request(ctx.session.api, `/api/model-runs/${encodeURIComponent(runId)}/cancel`, { body: {}, method: "POST" }).catch(() => undefined);
      return { offered, reached, terminal: await waitRun(ctx, runId, R_PHRASE_MS) };
    };
    const sent = await trySend(ctx, run, chat.id, phrase.text, [], { search: route });
    if (!sent.ok) fail(`send_${sent.code}`);
    const reached = await outcome(sent.ok ? sent.runId : "");
    results.push({ index, offered: reached.offered, started: reached.reached === "started", status: reached.terminal.status });
    await waitMainIdle(ctx, chat.id, R_PHRASE_MS);
  }
  const verdict = oracleR(results);
  const usage = usageByPurpose(await settledUsage(ctx.db, run.chats));
  Object.assign(run.line, { checksFailed: verdict.failed, oracleCounts: verdict.counts, phrases: results, route: route.name, wallSeconds: seconds(started) });
  return { success: verdict.failed.length === 0, usage };
}

/** A chat's answers for reading by hand: a file of the operator's own choosing, never output. S's answers mask the saved password (`passwordInAnswer` checks that). */
async function keepAnswers(ctx: Context, chatId: string, label: string, redact: readonly string[] = []): Promise<void> {
  const file = process.env.AIQSA_SUBAGENTS_ANSWERS_FILE;
  if (!file) return;
  const { rows } = await ctx.db.query<{ content: unknown }>(`SELECT m."content" FROM "ModelRun" r JOIN "Message" m ON m."id" = r."assistantMessageId"
    WHERE r."chatId" = $1 AND r."subagentTurnId" IS NULL ORDER BY r."createdAt"`, [chatId]);
  const text = rows.map((row) => (row.content as { blocks?: { text?: string }[] } | null)?.blocks?.map((block) => block.text ?? "").join("\n") ?? "").join("\n\n---\n\n");
  const clean = redact.reduce((value, secret) => value.split(secret).join("[proxy]"), text);
  appendFileSync(file, `\n\n===== ${label} =====\n\n${clean}\n`, { mode: 0o600 });
}

const S_TURN_MS = 12 * 60_000;

/** Whether what a chat's agents got from tools holds this text, matched inside SQL. Tool results live in the transcript, whole or as their excerpt. */
async function transcriptHolds(db: PostgresClient, chatId: string, needle: string): Promise<boolean> {
  const { rows } = await db.query<{ hit: boolean }>(`SELECT coalesce(bool_or(strpos(t."body"::text, $2) > 0), false) AS "hit" FROM "RunTranscriptItem" t
    WHERE t."chatId" = $1 AND t."kind"::text = 'tool_result'`, [chatId, needle]);
  return rows[0]?.hit === true;
}

async function fetchCodes(db: PostgresClient, chatId: string): Promise<string[]> {
  const { rows } = await db.query<{ code: string | null }>(`SELECT coalesce(c."result"->'rawPreview'->'fetchUrl'->>'proxyCode', c."result"->'rawPreview'->'fetchUrl'->>'outcome') AS "code"
    FROM "ModelRunToolCall" c JOIN "ModelRun" r ON r."id" = c."modelRunId" WHERE r."chatId" = $1 AND c."toolName" = 'fetch_url'`, [chatId]);
  return [...new Set(rows.flatMap((row) => { const code = safeCode(row.code); return code ? [code] : []; }))];
}

async function scenarioS(ctx: Context, run: Run): Promise<Outcome> {
  const proxy = parseTestProxy(process.env.AIQSA_SUBAGENTS_TEST_PROXY) ?? fail("test_proxy_required");
  const started = Date.now();
  const terminals: Record<string, string> = {};
  const step = async (name: string, text: string) => {
    const chat = await createScenarioChat(ctx.session.api, `Proxy scenario ${name}`);
    run.chats.push(chat.id);
    const sent = await trySend(ctx, run, chat.id, text);
    if (!sent.ok) fail(`send_${sent.code}`);
    terminals[name] = (await waitRun(ctx, sent.ok ? sent.runId : "", S_TURN_MS)).status;
    await waitMainIdle(ctx, chat.id, S_TURN_MS);
    // The proxy's address and login may be repeated in an answer, and they leave nowhere.
    await keepAnswers(ctx, chat.id, `S ${name}`, [proxy.url, proxy.password, proxy.login, proxy.host]);
    return chat.id;
  };
  const saveChat = await step("save", SCENARIO_S_PROMPTS.save(proxy.url));
  const { rows: saved } = await ctx.db.query<{ active: boolean; exitIsProxy: boolean; hint: boolean; id: string; ok: boolean; sealed: boolean; version: number }>(`SELECT p."id", p."active", p."version",
      '.ru' = ANY(p."domainHints") AS "hint", p."lastCheckStatus" = 'ok' AS "ok", p."lastExitAddress" = $2 AS "exitIsProxy", p."passwordEnvelope" IS NOT NULL AS "sealed"
    FROM "NetworkProxy" p WHERE lower(p."name") = $1`, [SCENARIO_S_NAME, proxy.host]);
  const row = saved[0];
  const { rows: inAnswer } = await ctx.db.query<{ hit: boolean }>(`SELECT coalesce(bool_or(strpos(m."content"::text, $2) > 0), false) AS "hit" FROM "ModelRun" r JOIN "Message" m ON m."id" = r."assistantMessageId" WHERE r."chatId" = $1`, [saveChat, proxy.password]);
  await step("browse", SCENARIO_S_PROMPTS.browse());
  const hintChat = await step("exitHint", SCENARIO_S_PROMPTS.exitHint());
  const namedChat = await step("exitNamed", SCENARIO_S_PROMPTS.exitNamed());
  const readChat = await step("read", SCENARIO_S_PROMPTS.read());
  const { rows: through } = await ctx.db.query<{ count: number }>(`SELECT count(*)::int AS "count" FROM "ModelRunToolCall" c JOIN "ModelRun" r ON r."id" = c."modelRunId"
    WHERE r."chatId" = $1 AND c."toolName" = 'fetch_url' AND c."result"->'rawPreview'->'fetchUrl'->'proxy'->>'name' = $2 AND c."result"->'rawPreview'->'fetchUrl'->>'outcome' = 'read'`, [readChat, SCENARIO_S_NAME]);
  // A dead proxy: the same host on a port nothing listens on, hinted for one echo site.
  await json(ctx.session.api, "/api/me/proxies", { body: { domainHints: [SCENARIO_S_DEAD_HINT], host: proxy.host, login: proxy.login, name: SCENARIO_S_DEAD_NAME, password: proxy.password, port: 1, protocol: "http" }, method: "POST" });
  const deadChat = await step("dead", SCENARIO_S_PROMPTS.dead());
  const { rows: deadRows } = await ctx.db.query<{ direct: boolean; failed: boolean }>(`SELECT
      coalesce(bool_or(c."result"::text ~ '[0-9]{1,3}[.][0-9]{1,3}[.][0-9]{1,3}[.][0-9]{1,3}'), false) AS "direct",
      coalesce(bool_or(c."toolName" LIKE 'mcp_workspace%' AND strpos(c."result"::text, 'proxy_') > 0), false) AS "failed"
    FROM "ModelRunToolCall" c JOIN "ModelRun" r ON r."id" = c."modelRunId" WHERE r."chatId" = $1 AND strpos(c."arguments"::text, $2) > 0`, [deadChat, SCENARIO_S_DEAD_HINT]);
  // Switched off: naming it is refused. The route takes the version it last read.
  if (row) await json(ctx.session.api, `/api/me/proxies/${encodeURIComponent(row.id)}`, { body: { active: false, expectedVersion: (await ctx.db.query<{ version: number }>(`SELECT "version" FROM "NetworkProxy" WHERE "id" = $1`, [row.id])).rows[0]?.version }, method: "PATCH" });
  const offChat = await step("off", SCENARIO_S_PROMPTS.off());
  const verdict = oracleS({ browserHintExit: await transcriptHolds(ctx.db, hintChat, proxy.host), browserNamedExit: await transcriptHolds(ctx.db, namedChat, proxy.host),
    checkOk: row?.ok === true, deadBrowserFailed: deadRows[0]?.failed === true, deadFetchCodes: await fetchCodes(ctx.db, deadChat), deadWentDirect: deadRows[0]?.direct === true, exitIsProxy: row?.exitIsProxy === true,
    fetchExit: await transcriptHolds(ctx.db, readChat, proxy.host), fetchThroughProxy: through[0]?.count ?? 0, hintSaved: row?.hint === true, offFetchCodes: await fetchCodes(ctx.db, offChat),
    passwordInAnswer: inAnswer[0]?.hit === true, saved: row?.sealed === true, terminals });
  const usage = usageByPurpose(await settledUsage(ctx.db, run.chats));
  for (const stored of (await ctx.db.query<{ id: string; version: number }>(`SELECT "id", "version" FROM "NetworkProxy"`)).rows) {
    await request(ctx.session.api, `/api/me/proxies/${encodeURIComponent(stored.id)}`, { body: { expectedVersion: stored.version }, method: "DELETE" }).catch(() => undefined);
  }
  Object.assign(run.line, { checksFailed: verdict.failed, deadFetchCodes: await fetchCodes(ctx.db, deadChat), oracleCounts: verdict.counts, offFetchCodes: await fetchCodes(ctx.db, offChat), terminals, wallSeconds: seconds(started) });
  return { success: verdict.failed.length === 0, usage };
}

/** Research role bindings share the existing codex-lb setup and the policy's optimistic version. */
async function ensureResearchRoles(api: Api, route: { apiRoot: string }, secret: string, options: ReturnType<typeof researchEvalOptions>) {
  await configureResearchEvalRoles(options, {
    ensureModel: async (model, role) => {
      const added = await ensureModel(api, { apiRoot: route.apiRoot, model }, secret, `Research ${role} model`);
      const effort = options[role].effort;
      if (effort && !(await catalogModel(api, added)).parameterControls.reasoningEffort.options.includes(effort)) {
        const connection = readConnections(await json(api, "/api/admin/providers"))?.find((entry) => entry.id === added.connectionId);
        const stored = connection?.models.find((entry) => entry.id === added.providerModelId);
        if (!stored?.activeConfig) return fail("research_model_configuration_missing");
        // A requested level outside the shared helper's defaults needs an explicit declaration and Admin's checks.
        await json(api, `/api/admin/providers/${encodeURIComponent(added.connectionId)}/models/${encodeURIComponent(added.providerModelId)}`, {
          body: { action: "update", activate: true, displayName: stored.displayName, expectedDisplayName: stored.displayName,
            expectedActiveVersion: stored.activeVersion, expectedDraftVersion: stored.draftVersion, expectedUpdatedAt: stored.updatedAt,
            configuration: researchEffortConfiguration(stored.activeConfig, effort) }, method: "PATCH", timeoutMs: SETUP_TIMEOUT_MS
        });
        if (!(await catalogModel(api, added)).parameterControls.reasoningEffort.options.includes(effort)) fail("research_effort_unavailable");
      }
      return added.providerModelId;
    },
    policyVersion: async () => {
      const current = await json(api, "/api/admin/providers/system-model-policy");
      const policy = isRecord(current) && isRecord(current.systemModelPolicy) && isRecord(current.systemModelPolicy.policy) ? current.systemModelPolicy.policy : fail("system_policy_invalid");
      return typeof policy.version === "number" ? policy.version : fail("system_policy_invalid");
    },
    patch: async (body) => { await json(api, "/api/admin/providers/system-model-policy", { body, method: "PATCH" }); }
  });
}

/** Thread-scoped transcript figures cover foreground agents; the paid-call ledger supplies the wider total and model split. */
async function researchUsage(ctx: Context, chatId: string, turns: readonly TurnRow[], names: ReadonlyMap<string, readonly string[]>) {
  await settledUsage(ctx.db, [chatId]);
  const { rows } = await ctx.db.query<ResearchUsageRow>(`SELECT u."purpose"::text AS "purpose", u."inputTokens", u."outputTokens", u."cachedInputTokens", u."modelId"
    FROM "UsageEvent" u JOIN "ModelRun" r ON r."id" = u."modelRunId" WHERE r."chatId" = $1`, [chatId]);
  const transcript = (await ctx.db.query<ResearchTranscriptRow>(`SELECT "id", "modelRunId" AS "runId", "subagentThreadId" AS "threadId", "subagentTurnId" AS "turnId",
      "sequence", "createdAt", "kind"::text AS "kind", jsonb_build_object(
        'origin', CASE WHEN jsonb_typeof("body"->'origin') = 'object' THEN '{}'::jsonb ELSE NULL END,
        'outputTokens', "body"->'outputTokens', 'requestAnchor', CASE WHEN "body" ? 'requestAnchor'
          THEN jsonb_build_object('inputTokens', "body"->'requestAnchor'->'inputTokens') ELSE NULL END) AS "body"
    FROM "RunTranscriptItem" WHERE "chatId" = $1 ORDER BY "modelRunId", "subagentThreadId", "sequence"`, [chatId])).rows;
  const main = (await ctx.db.query<ResearchTiming>(`SELECT NULL AS "threadId", "createdAt" AS "startedAt", "answerCompletedAt" AS "endedAt"
    FROM "ModelRun" WHERE "chatId" = $1 AND "subagentTurnId" IS NULL`, [chatId])).rows;
  return { roles: researchRoleUsage(transcript, [...main, ...turns.map((turn) => ({ threadId: turn.threadId,
    startedAt: turn.startedAt, endedAt: turn.endedAt }))], names), byModel: researchUsageByModel(rows), total: usageByPurpose(rows),
    responses: researchResponses(transcript) };
}

/**
 * The app log command's lines for these runs' searches, read as they arrive: only `researchEngineLatency`'s numbers are kept.
 * The command gets the restart hook's minimal environment; its errors are discarded.
 */
function appLogLatency(hook: Readonly<{ command: string; timeoutMs: number }>, runIds: ReadonlySet<string>, labels: readonly string[]) {
  const latency = researchEngineLatency(runIds, labels);
  const picked: Record<string, string> = {};
  for (const key of ["PATH", "HOME", "USER", "LOGNAME", "SSH_AUTH_SOCK"]) {
    const value = process.env[key];
    if (value) picked[key] = value;
  }
  return new Promise<Readonly<{ status: string; latency: ReturnType<typeof latency.result> | null }>>((resolve) => {
    let timedOut = false, bytes = 0, rest = "";
    const child = spawn("/bin/sh", ["-c", hook.command], { env: picked as NodeJS.ProcessEnv, stdio: ["ignore", "pipe", "ignore"] });
    const timer = setTimeout(() => { timedOut = true; child.kill("SIGKILL"); }, hook.timeoutMs);
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      bytes += chunk.length;
      // A runaway command is cut off; what it printed so far still counts.
      if (bytes > 1_024 * 1_024 * 1_024) { child.kill("SIGKILL"); return; }
      const lines = (rest + chunk).split("\n");
      rest = lines.pop() ?? "";
      for (const line of lines) latency.add(line);
      if (rest.length > 65_536) rest = "";
    });
    const done = (exitCode: number | null) => {
      clearTimeout(timer);
      if (rest) latency.add(rest);
      resolve({ latency: latency.result(), status: timedOut ? "timed_out" : exitCode === 0 ? "ok" : "failed" });
    };
    child.once("error", () => { clearTimeout(timer); resolve({ latency: null, status: "failed" }); });
    child.once("close", (code) => done(code));
  });
}

/**
 * A question's acceptance metrics and expectations from the stand's rows, read while the chat exists. The full projection (the
 * expected names included) is for the private archive; `counts` is what stdout shows.
 */
async function researchAcceptance(ctx: Context, chatId: string, runId: string, input: Readonly<{ answer: string; appLog: Readonly<{ command: string; timeoutMs: number }> | null; expect: ResearchExpectations | null;
  labels: ReadonlyMap<string, string>; responses: readonly ResearchResponse[]; sourceLabels: readonly string[] }>) {
  const runs = (await ctx.db.query<{ id: string; createdAt: Date; answerCompletedAt: Date | null; subagent: boolean }>(`SELECT "id", "createdAt", "answerCompletedAt",
    "subagentTurnId" IS NOT NULL AS "subagent" FROM "ModelRun" WHERE "chatId" = $1 ORDER BY "createdAt"`, [chatId])).rows;
  const frame = (await ctx.db.query<{ createdAt: Date; releasedAt: Date | null; frame: unknown }>(`SELECT "createdAt", "releasedAt", "frame"
    FROM "ResearchFrame" WHERE "chatId" = $1 AND "modelRunId" = $2`, [chatId, runId])).rows[0] ?? null;
  const calls = (await ctx.db.query<ResearchAcceptanceCall>(`SELECT c."id", c."modelRunId" AS "runId", c."toolName", c."subagentThreadId" AS "threadId",
      c."subagentTurnId" AS "turnId", c."startedAt", c."completedAt",
      CASE WHEN c."result"->>'status' = 'error' THEN c."result"->'content'->0->'value'->>'error' END AS "errorCode",
      COALESCE(strpos(c."result"::text, 'Calls left in this task') > 0, false) AS "budgetMarker",
      CASE WHEN c."toolName" = 'call_subagent' THEN c."result"->'content'->0->'value'->>'reason' END AS "endReason",
      CASE WHEN c."toolName" = 'submit_research_draft' THEN c."result"->'content'->0->'value'->>'status' END AS "draftStatus",
      CASE WHEN c."toolName" = 'submit_research_draft' THEN c."result"->'content'->0->'value'->>'gate' END AS "draftGate",
      CASE WHEN c."toolName" = 'submit_research_draft' THEN c."arguments"->'record_ids' END AS "recordIds",
      CASE WHEN c."toolName" = 'change_research_frame' THEN c."arguments"->>'change' END AS "frameChange"
    FROM "ModelRunToolCall" c JOIN "ModelRun" r ON r."id" = c."modelRunId" WHERE r."chatId" = $1`, [chatId])).rows;
  const turns = (await ctx.db.query<ResearchAcceptanceTurn>(`SELECT t."id", t."threadId", th."name", t."state"::text AS "state", t."reasonCode",
      t."parentToolCallId", t."startedAt", t."endedAt", CASE WHEN th."name" ~ '^verifier' THEN t."result"->>'report' END AS "report"
    FROM "SubagentTurn" t JOIN "SubagentThread" th ON th."id" = t."threadId" WHERE t."chatId" = $1`, [chatId])).rows;
  const evidence = (await ctx.db.query<ResearchAcceptanceEvidence>(`SELECT "id", "kind"::text AS "kind", "sourceClass"::text AS "sourceClass",
      "quoteCheck"::text AS "quoteCheck", "rowKey", "supersedesId", "url" FROM "ResearchEvidence" WHERE "chatId" = $1`, [chatId])).rows;
  const searches = (await ctx.db.query<{ strategyId: string; status: string }>(`SELECT s."strategyId", s."status"::text AS "status"
    FROM "SearchRun" s JOIN "ModelRun" r ON r."id" = s."modelRunId" WHERE r."chatId" = $1`, [chatId])).rows;
  const log = input.appLog;
  const engines = log ? await appLogLatency(log, new Set(runs.map((entry) => entry.id)), input.sourceLabels) : null;
  const metrics = researchAcceptanceMetrics({ calls, engineLatency: engines?.latency ?? null, evidence, frame, responses: input.responses, runId,
    runs: runs.filter((entry) => !entry.subagent), searchLabels: input.labels, searches, turns });
  const expectations = input.expect ? researchExpectationResults(input.expect, researchAcceptanceObserved(metrics, frame?.frame ?? null, input.answer)) : null;
  const extra = { appLog: engines?.status ?? null, searchSources: [...input.sourceLabels] };
  return { full: { ...metrics, ...extra, expectations }, counts: { ...metrics, ...extra, expectations: expectations ? researchExpectationCounts(expectations) : null } };
}

/** The run's records as counts, read before cleanup takes them with the chat. */
async function researchStore(db: Context["db"], chatId: string, runId: string) {
  const frame = (await db.query<{ criteria: number; rows: number; changes: number }>(`SELECT jsonb_array_length("frame"->'criteria') AS "criteria",
    jsonb_array_length("frame"->'rows') AS "rows", jsonb_array_length("frame"->'changes') AS "changes"
    FROM "ResearchFrame" WHERE "chatId" = $1 AND "modelRunId" = $2`, [chatId, runId])).rows[0] ?? null;
  const evidence = (await db.query<{ kind: string; quoteCheck: string | null; count: number }>(`SELECT "kind", "quoteCheck", count(*)::int AS "count"
    FROM "ResearchEvidence" WHERE "chatId" = $1 GROUP BY 1, 2`, [chatId])).rows;
  const pages = (await db.query<{ obtainedBy: string; count: number }>(`SELECT "obtainedBy", count(*)::int AS "count" FROM "ResearchPage" WHERE "chatId" = $1 GROUP BY 1`, [chatId])).rows;
  return researchStoreFacts({ evidence, frame, pages });
}

const T_PUSH_WAIT_MS = 90_000;

/** Records a run must hold before T's `restart` act cuts it: what a Continue then has to keep. */
const T_RESTART_RECORDS = 5;

/** T's `restart` act: the app restarts mid-research, recovery ends the run, and the user presses Continue. The Continue's run, and what stood before it, in counts. */
async function restartAndContinue(ctx: Context, run: Run, chatId: string, send: (text: string) => Promise<string>) {
  const hook = ctx.options.restart ?? fail("restart_command_required");
  const records = async () => (await ctx.db.query<{ count: number }>(`SELECT count(*)::int AS "count" FROM "ResearchEvidence" WHERE "chatId" = $1 AND "kind" <> 'not_found'`, [chatId])).rows[0]?.count ?? 0;
  await poll(45 * 60_000, async () => await records() >= T_RESTART_RECORDS ? true : null, "research_restart_precondition_timeout", 5_000);
  const recordsBefore = await records();
  const restart = await runRestartHook(hook);
  run.line.restart = restart;
  await poll(10 * 60_000, async () => (await request(ctx.session.api, "/api/health/ready").catch(() => null))?.ok ? true : null, "app_not_ready", 3_000);
  const me = await request(ctx.session.api, "/api/me").catch(() => null);
  if (!me || me.status === 401) ctx.session.api = await authenticate(ctx.target);
  await poll(20 * 60_000, async () => {
    await request(ctx.session.api, `/api/chats/${encodeURIComponent(chatId)}`).catch(() => null);
    const mains = await mainRuns(ctx.db, chatId);
    return mains.every((entry) => TERMINAL_RUN_STATES.has(entry.status)) ? true : null;
  }, "research_restart_interrupted_timeout", 5_000);
  const interrupted = (await mainRuns(ctx.db, chatId)).at(-1)?.status ?? null;
  return { continued: await send(CONTINUE_TURN_TEXT), facts: { interrupted, recordsBefore, restartExit: restart.exitCode } };
}

/**
 * T's `outage` act, as on 2026-11-06, when a provider's dropped streams failed a production research at its last step: once the research handed in a
 * draft the provider goes away (AIQSA_SUBAGENTS_RESTART_COMMAND) until every main run ended, comes back (AIQSA_SUBAGENTS_OUTAGE_END_COMMAND, run whatever
 * happened) and the user presses Continue. The Continue's run, and how the failed run ended, in counts.
 */
async function outageAndContinue(ctx: Context, run: Run, chatId: string, send: (text: string) => Promise<string>) {
  const start = ctx.options.restart ?? fail("restart_command_required");
  const end = ctx.options.outageEnd ?? fail("outage_end_command_required");
  const count = async (sql: string) => (await ctx.db.query<{ count: number }>(sql, [chatId])).rows[0]?.count ?? 0;
  const drafts = () => count(`SELECT count(*)::int AS "count" FROM "ModelRunToolCall" c JOIN "ModelRun" r ON r."id" = c."modelRunId"
    WHERE r."chatId" = $1 AND c."toolName" = 'submit_research_draft'`);
  await poll(60 * 60_000, async () => await drafts() > 0 ? true : null, "research_outage_precondition_timeout", 5_000);
  const recordsBefore = await count(`SELECT count(*)::int AS "count" FROM "ResearchEvidence" WHERE "chatId" = $1 AND "kind" <> 'not_found'`);
  const began = Date.now();
  const outage = await runRestartHook(start);
  let ended: Awaited<ReturnType<typeof runRestartHook>> | null = null;
  try {
    await poll(45 * 60_000, async () => (await mainRuns(ctx.db, chatId)).every((entry) => TERMINAL_RUN_STATES.has(entry.status)) ? true : null,
      "research_outage_run_timeout", 5_000);
  } finally {
    ended = await runRestartHook(end);
  }
  const failed = (await mainRuns(ctx.db, chatId)).at(-1);
  const facts = { endExit: ended.exitCode, failedCode: failed?.errorCode ?? null, failedStatus: failed?.status ?? null, outageSeconds: seconds(began),
    recordsBefore, startExit: outage.exitCode };
  run.line.outage = facts;
  return { continued: await send(CONTINUE_TURN_TEXT), facts };
}

/** What a Continue came to, in counts. */
async function continuedFacts(db: Context["db"], chatId: string, runId: string) {
  const link = (await db.query<{ linked: boolean }>(`SELECT "continuedFromRunId" IS NOT NULL AS "linked" FROM "ResearchFrame" WHERE "chatId" = $1 AND "modelRunId" = $2`, [chatId, runId])).rows[0];
  const calls = (await db.query<{ toolName: string; resumed: boolean }>(`SELECT "toolName", ("result"::text LIKE '%resumed%') AS "resumed" FROM "ModelRunToolCall" WHERE "modelRunId" = $1
    AND "toolName" IN ('start_research', 'propose_research_plan')`, [runId])).rows;
  return { linked: link?.linked ?? false, resumedStarts: calls.filter((call) => call.toolName === "start_research" && call.resumed).length,
    newPlans: calls.filter((call) => call.toolName === "propose_research_plan").length };
}

/** T's administrator proxy, one per invocation. A name the stand already has is a killed invocation's: the operator removes it. */
const ADMIN_PROXY_NAME = "Research acceptance proxy";
const ADMIN_PROXY_TIMEOUT_MS = 120_000;

async function adminProxies(ctx: Context): Promise<readonly Readonly<Record<string, unknown>>[]> {
  const value = await json(ctx.session.api, PROXY_ROUTES.administrator);
  return isRecord(value) && Array.isArray(value.proxies) ? value.proxies.filter(isRecord) : fail("research_admin_proxy_list_invalid");
}

/** Adds the proxy as an administrator does. The id comes back whenever the proxy exists, also when the answer was lost, so cleanup can own it. */
async function createAdminProxy(ctx: Context, proxy: ResearchAdminProxy): Promise<Readonly<{ code: string | null; id: string | null }>> {
  if ((await adminProxies(ctx)).some((entry) => entry.name === ADMIN_PROXY_NAME)) fail("research_admin_proxy_exists");
  const response = await request(ctx.session.api, PROXY_ROUTES.administrator, { body: { active: true, country: proxy.country, domainHints: proxy.domainHints,
    host: proxy.host, login: proxy.login, name: ADMIN_PROXY_NAME, password: proxy.password, port: proxy.port, protocol: proxy.protocol },
  method: "POST", timeoutMs: ADMIN_PROXY_TIMEOUT_MS }).catch(() => null);
  const code = !response ? "request_failed" : response.ok ? null : await errorCode(response);
  const created: unknown = response?.ok ? await response.json().catch(() => null) : null;
  const direct = isRecord(created) && isRecord(created.proxy) && typeof created.proxy.id === "string" ? created.proxy.id : null;
  const known = await adminProxies(ctx).catch((): readonly Readonly<Record<string, unknown>>[] => []);
  const listed = direct ?? known.find((entry) => entry.name === ADMIN_PROXY_NAME)?.id;
  return { code: code ?? (direct ? null : "response_invalid"), id: typeof listed === "string" ? listed : null };
}

/** The proxy's own check, as the settings page runs it: its stable status, or the route's code. */
async function checkAdminProxy(ctx: Context, id: string): Promise<string> {
  const response = await request(ctx.session.api, PROXY_ROUTES.administratorCheck(id), { method: "POST", timeoutMs: ADMIN_PROXY_TIMEOUT_MS }).catch(() => null);
  if (!response) return "request_failed";
  if (!response.ok) return errorCode(response);
  return researchProxyCheckStatus(await response.json().catch(() => null));
}

/** Deletes the proxy at its current version and proves it gone from the administrator list and the database. */
async function removeAdminProxy(ctx: Context, id: string): Promise<boolean> {
  const current = (await adminProxies(ctx)).find((entry) => entry.id === id);
  if (current) {
    const response = await request(ctx.session.api, PROXY_ROUTES.administratorItem(id), { body: { expectedVersion: current.version }, method: "DELETE" });
    await discard(response);
  }
  const listed = (await adminProxies(ctx)).some((entry) => entry.id === id);
  const stored = (await ctx.db.query<{ count: number }>(`SELECT count(*)::int AS "count" FROM "NetworkProxy" WHERE "id" = $1`, [id])).rows[0]?.count ?? 1;
  return !listed && stored === 0;
}

/** What each Search source contributed to the records the final answer cites: links in the private file, counts on stdout. */
async function researchAttribution(ctx: Context, chatId: string, input: Readonly<{ answer: string; evidence: readonly TEvidenceRow[]; lastDraft: unknown;
  labels: ReadonlyMap<string, string> }>) {
  const cited = researchCitedUrls({ answer: input.answer, evidence: input.evidence, lastDraft: input.lastDraft });
  const searches = (await ctx.db.query<ResearchSearchRow>(`SELECT s."strategyId", s."artifacts"->'sources' AS "sources"
    FROM "SearchRun" s JOIN "ModelRun" r ON r."id" = s."modelRunId" WHERE r."chatId" = $1`, [chatId])).rows;
  const attribution = researchCitationAttribution(cited.urls, searches, input.labels);
  return { attribution, counts: { ...researchAttributionCounts(attribution, cited.records), searchCalls: searches.length } };
}

/** A research run's sub-agents' own turn runs, by its id as `$1`. */
const SUBAGENT_TURN_RUNS = `SELECT sr."id" FROM "ModelRun" sr JOIN "SubagentTurn" st ON st."id" = sr."subagentTurnId" WHERE st."parentRunId" = $1`;
/** The calls a run's evidence spans, by its id as `$1`: its own and its sub-agents', whichever run row holds them. */
const RUN_SCOPE_CALLS = `(c."modelRunId" = $1 OR c."subagentTurnId" IN (SELECT "id" FROM "SubagentTurn" WHERE "parentRunId" = $1)
  OR c."modelRunId" IN (${SUBAGENT_TURN_RUNS}))`;

/** A run's text answer, in memory only. */
async function runAnswer(db: PostgresClient, runId: string): Promise<string> {
  const { rows } = await db.query<{ content: unknown }>(`SELECT m."content" FROM "ModelRun" r JOIN "Message" m ON m."id" = r."assistantMessageId" WHERE r."id" = $1`, [runId]);
  const content = rows[0]?.content;
  return isRecord(content) && Array.isArray(content.blocks) ? content.blocks.filter((block) => isRecord(block) && block.type === "text" && typeof block.text === "string")
    .map((block: { text: string }) => block.text).join("\n") : "";
}

/** Minutes, usage and the cost the usage rows hold, of one run and its sub-agents' turn runs. */
async function runSpend(db: PostgresClient, runId: string) {
  const timing = (await db.query<{ createdAt: Date; answerCompletedAt: Date | null }>(`SELECT "createdAt", "answerCompletedAt" FROM "ModelRun" WHERE "id" = $1`, [runId])).rows[0];
  const rows = (await db.query<PurposeUsageRow & { costReported: boolean; estimatedCostMicros: number | null }>(`SELECT "purpose"::text AS "purpose", "inputTokens",
      "cachedInputTokens", "outputTokens", "estimatedCostMicros", "costReported" FROM "UsageEvent" WHERE "modelRunId" = $1 OR "modelRunId" IN (${SUBAGENT_TURN_RUNS})`, [runId])).rows;
  const start = timing ? new Date(timing.createdAt).getTime() : null;
  const end = timing?.answerCompletedAt ? new Date(timing.answerCompletedAt).getTime() : null;
  return { cost: researchCost(rows), minutes: start !== null && end !== null ? Math.round((end - start) / 6_000) / 10 : null, usage: usageByPurpose(rows) };
}

/** Whether a run was admitted with Deep research, called a research tool or started research, and holds a frame. */
async function researchRunObserved(db: PostgresClient, runId: string) {
  const row = (await db.query<{ offered: boolean; researchCalls: number; started: number; frame: boolean }>(`SELECT
      coalesce((SELECT r."normalizedRequest"->>'deepResearch' = 'true' FROM "ModelRun" r WHERE r."id" = $1), false) AS "offered",
      (SELECT count(*)::int FROM "ModelRunToolCall" c WHERE ${RUN_SCOPE_CALLS} AND c."toolName" = ANY($2::text[])) AS "researchCalls",
      (SELECT count(*)::int FROM "ModelRunToolCall" c WHERE c."modelRunId" = $1 AND c."toolName" = 'start_research') AS "started",
      EXISTS (SELECT 1 FROM "ResearchFrame" f WHERE f."modelRunId" = $1) AS "frame"`, [runId, [...RESEARCH_TOOL_NAMES]])).rows[0];
  return { frame: row?.frame ?? false, offered: row?.offered ?? false, researchCalls: row?.researchCalls ?? 0, started: (row?.started ?? 0) > 0 };
}

/**
 * One research run's review evidence (the decisions of 2026-11-05), read while the chat exists: its page, bot checks, closed sites, ratings,
 * priorities, send-backs and earlier options, with minutes, usage and cost. The full projection, the page's HTML and the send-back messages go to
 * the private answers directory; `counts` is what stdout shows.
 */
async function researchReview(ctx: Context, chatId: string, runId: string, save: (entry: string, contents: unknown) => void) {
  const db = ctx.db;
  const frame = (await db.query<{ frame: unknown }>(`SELECT "frame" FROM "ResearchFrame" WHERE "modelRunId" = $1`, [runId])).rows[0]?.frame ?? null;
  // The page: the answer's card with its marker, and its entry HTML through the user's own artifact route.
  const payloads = (await db.query<{ payload: unknown }>(`SELECT "payload" FROM "ModelRunEvent" WHERE "modelRunId" = $1
    AND "payload"->>'artifactType' = 'generated_artifact' ORDER BY "sequence"`, [runId])).rows.map((row) => row.payload);
  const card = researchPageCard(payloads);
  const page: Record<string, unknown> = { card: card !== null, summaryEnd: card?.summaryEnd !== null && card?.summaryEnd !== undefined,
    notesStart: card?.notesStart !== null && card?.notesStart !== undefined, htmlSaved: false, htmlBytes: null };
  if (card) {
    const response = await request(ctx.session.api, `/api/artifacts/${encodeURIComponent(card.artifactId)}/versions/${encodeURIComponent(card.versionId)}/source`).catch(() => null);
    const entry = researchPageEntry(response?.ok ? await response.json().catch(() => null) : null, card.entrypoint);
    if (response && !response.ok) page.sourceStatus = response.status;
    if (entry) {
      save(`page-${runId}`, { run: runId, title: card.title, entrypoint: entry.path, files: entry.paths, summaryEnd: card.summaryEnd, notesStart: card.notesStart, html: entry.html });
      page.htmlSaved = true;
      page.htmlBytes = Buffer.byteLength(entry.html);
    }
  }
  const fetches = (await db.query<ResearchFetchRow>(`SELECT c."id", c."subagentThreadId" AS "threadId", coalesce(c."startedAt", c."createdAt") AS "at",
      c."arguments"->>'url' AS "url",
      CASE WHEN jsonb_typeof(c."result"->'content'->0->'value'->'error') = 'string' THEN c."result"->'content'->0->'value'->>'error' END AS "error",
      CASE WHEN jsonb_typeof(c."result"->'rawPreview'->'fetchUrl'->'httpStatus') = 'number' THEN (c."result"->'rawPreview'->'fetchUrl'->>'httpStatus')::int END AS "httpStatus",
      coalesce(c."result"->'rawPreview'->'fetchUrl'->>'outcome' = 'read', false) AS "read",
      coalesce(strpos(c."result"::text, 'already recorded as unreachable') > 0, false) AS "closedRefusal"
    FROM "ModelRunToolCall" c WHERE c."toolName" = 'fetch_url' AND ${RUN_SCOPE_CALLS} ORDER BY 3`, [runId])).rows;
  const records = (await db.query<ResearchRecordRow>(`SELECT "id", "kind", "rowKey", "criterionKey", "url", "rating", "reason", "target", "createdAt" AS "at"
    FROM "ResearchEvidence" WHERE "modelRunId" = $1 ORDER BY "sequence"`, [runId])).rows;
  // A bot check's agent then tried the host in its browser: one of its later Workspace commands names the host and drives the browser (or printed a step line).
  const checks = researchBotChecks(fetches).slice(0, 100);
  const browserAfter = new Map<string, boolean>();
  for (const check of checks) {
    const tried = (await db.query<{ tried: boolean }>(`SELECT EXISTS (SELECT 1 FROM "ModelRunToolCall" c, "ModelRunToolCall" b WHERE b."id" = $2 AND ${RUN_SCOPE_CALLS}
        AND c."toolName" LIKE 'mcp_workspace%' AND c."subagentThreadId" IS NOT DISTINCT FROM b."subagentThreadId"
        AND coalesce(c."startedAt", c."createdAt") >= coalesce(b."startedAt", b."createdAt")
        AND strpos(c."arguments"::text || coalesce(c."result"::text, ''), $3) > 0
        AND (strpos(c."arguments"::text, 'aiqsa-browser') > 0 OR strpos(c."arguments"::text, 'aiqsa import browser') > 0
          OR strpos(c."arguments"::text, 'aiqsa.browser') > 0 OR strpos(coalesce(c."result"::text, ''), '[browser #') > 0)) AS "tried"`,
    [runId, check.callId, check.host])).rows[0]?.tried === true;
    browserAfter.set(check.callId, tried);
  }
  const botChecks = researchBotCheckOutcomes(checks, browserAfter, records, fetches);
  const unreachable = researchUnreachableEvidence(records, fetches);
  const drafts = (await db.query<{ arguments: unknown; value: unknown }>(`SELECT c."arguments", c."result"->'content'->0->'value' AS "value" FROM "ModelRunToolCall" c
    WHERE c."modelRunId" = $1 AND c."toolName" = 'submit_research_draft' ORDER BY coalesce(c."startedAt", c."createdAt")`, [runId])).rows;
  const summary = researchFinalSummary(drafts.map((draft) => draft.arguments));
  const ratings = researchRatingsEvidence(records, summary);
  const priorities = researchPriorityEvidence(frame, summary);
  const sendBacks = researchSendBacks(drafts.map((draft) => draft.value));
  const earlier = researchEarlierOutcomes(frame);
  const spend = await runSpend(db, runId);
  const fetchCounts = { fetchCalls: fetches.length, read: fetches.filter((call) => call.read).length };
  save(`review-${runId}`, { chat: chatId, run: runId, page, fetches: fetchCounts, botChecks: botChecks.full, unreachable: unreachable.full, ratings: ratings.full,
    priorities: priorities.full, summary, earlier: earlier.full, minutes: spend.minutes, usage: spend.usage, cost: spend.cost });
  if (sendBacks.full.length > 0) save(`sendbacks-${runId}`, { chat: chatId, run: runId, sendBacks: sendBacks.full });
  return { page, fetches: fetchCounts, botChecks: botChecks.counts, unreachable: unreachable.counts, ratings: ratings.counts, priorities: priorities.counts,
    sendBacks: sendBacks.counts, earlier: earlier.counts, minutes: spend.minutes, tokens: spend.usage.total, cost: spend.cost };
}

/**
 * T's same-chat steps (AIQSA_SUBAGENTS_T_STEPS_FILE), in order in the question's chat once its research ended, each after the previous run's
 * terminal state and the chat's callbacks. Each step's answer goes to the private answers directory; the line holds codes, numbers and booleans.
 */
async function researchSteps(ctx: Context, run: Run, chatId: string, steps: readonly ResearchStep[], route: SearchRoute,
  save: (entry: string, contents: unknown) => void, clean: (value: string) => string) {
  const lines: Record<string, unknown>[] = [];
  const runs = new Map<string, number>();
  let failed = false;
  for (const [index, step] of steps.entries()) {
    const number = index + 1;
    try {
      await waitMainIdle(ctx, chatId);
      const sent = await trySend(ctx, run, chatId, step.text, [], { deepResearch: step.deepResearch, search: route });
      if (!sent.ok) {
        lines.push({ step: number, deepResearch: step.deepResearch, refused: sent.code, ok: false });
        failed = true;
        break;
      }
      runs.set(sent.runId, number);
      const terminal = await waitRun(ctx, sent.runId, step.deepResearch ? researchQuestionTimeout(ctx.marginSeconds) : undefined);
      await waitMainIdle(ctx, chatId).catch(() => undefined);
      await settledUsage(ctx.db, [chatId]);
      const observed = await researchRunObserved(ctx.db, sent.runId);
      const verdict = researchStepVerdict(step, { ...observed, status: terminal.status });
      const answer = await runAnswer(ctx.db, sent.runId);
      if (answer.trim()) save(`step-${number}-answer-${sent.runId}`, { chat: chatId, run: sent.runId, step: number, deepResearch: step.deepResearch, answer: clean(answer) });
      const spend = await runSpend(ctx.db, sent.runId);
      const line = { step: number, deepResearch: step.deepResearch, offered: observed.offered, researchRan: observed.started && observed.frame,
        startCalled: observed.started, frame: observed.frame, researchCalls: observed.researchCalls, status: terminal.status, code: terminal.errorCode,
        minutes: spend.minutes, tokens: spend.usage.total, cost: spend.cost, answerSaved: answer.trim().length > 0, ok: verdict.ok, failed: verdict.failed };
      save(`step-${number}`, { chat: chatId, run: sent.runId, ...line, usage: spend.usage });
      lines.push(line);
      failed ||= !verdict.ok;
    } catch (error) {
      lines.push({ step: number, deepResearch: step.deepResearch, harnessError: error instanceof BrowserScenarioError ? error.message : "research_step_failed", ok: false });
      failed = true;
      break;
    }
  }
  return { failed, lines, runs };
}

async function scenarioT(ctx: Context, run: Run): Promise<Outcome> {
  const route = ctx.search[0] ?? fail("search_route_missing");
  const research = ctx.research ?? fail("research_setup_missing");
  const { options, judge } = research;
  const proxy = parseTestProxy(process.env.AIQSA_SUBAGENTS_TEST_PROXY);
  const secrets = [...(proxy ? [proxy.url, proxy.host, proxy.login, proxy.password] : []), ...researchAdminProxySecrets(research.adminProxy)];
  const clean = (value: string) => redactResearchSecrets(value, secrets);
  const archive = createResearchArchive(options.answersDir, secrets, options.answersFile);
  // Attribution names each Search result by the plan's own label for its source.
  const searchLabels = new Map(route.sources.map((source) => [source.optionId, source.label] as const));
  let ownedProxy: string | null = null;
  let adminProxyId: string | null = null;
  const questions: Record<string, unknown>[] = [];
  const extracted: { job: ResearchJob; answer: StructuredResearchAnswer }[] = [];
  const createdChats = new Map<ResearchJob, string>();
  let failed = false;
  try {
    if (proxy) {
      try {
        ownedProxy = await researchProxySetup(() => json(ctx.session.api, "/api/me/proxies", { body: { domainHints: [".ru"], host: proxy.host, login: proxy.login,
          name: SCENARIO_S_NAME, password: proxy.password, port: proxy.port, protocol: proxy.protocol }, method: "POST" }));
      } catch { fail("research_proxy_setup_failed"); }
    }
    if (research.adminProxy) {
      const created = await createAdminProxy(ctx, research.adminProxy);
      adminProxyId = created.id;
      const id = created.code === null && created.id !== null ? created.id : fail(`research_admin_proxy_setup_${created.code ?? "response_invalid"}`);
      const status = await checkAdminProxy(ctx, id);
      emit({ stage: "research_admin_proxy", created: true, check: status });
      if (status !== "ok") fail(`research_admin_proxy_check_${status}`);
    }
    const results = await researchPool(options.jobs, options.concurrency, async (job) => {
      const started = Date.now();
      const deadline = started + researchQuestionTimeout(ctx.marginSeconds);
      let chatId: string | null = null;
      let capture: (() => Promise<void>) | null = null;
      const savedAnswers = new Map<string, string>();
      const savedGates = new Map<string, { role: string; report: string; state: string }>();
      let grade = emptyEval<ResearchGrade>("no_answer");
      let extraction = emptyEval<StructuredResearchAnswer>("no_answer");
      let questionFailed = false;
      const facts: Record<string, unknown> = { metrics: null, roles: null, tokens: null, tokensByModel: [], terminal: "unknown",
        timeline: [], gateTurnFacts: [], gateTurns: 0, fetchOutcomes: {}, fetchProxyReads: 0, serverNotes: [], researcherInput: null, attribution: null,
        acceptance: null, searchSources: route.sources.map((source) => source.label) };
      let drafts: TDraftFinding[][] = [];
      let browserAct: AbortController | null = null;
      let acted: Promise<unknown> | null = null;
      // The operator's question replaces the built-in purchase one, and a set's question is its file's; either goes only to the chat and the evaluation calls.
      const setQuestion = job.kind === "set" ? research.questions.get(job.name) ?? fail("research_question_missing") : null;
      const builtIn = job.kind === "set" ? null : SCENARIO_T_QUESTIONS.find((entry) => entry.kind === job.kind) ?? fail("research_kind_missing");
      const question = { text: job.kind === "set" ? setQuestion!.text : researchQuestionText(job.kind, builtIn!.text, research.question) };
      try {
        const chat = await createScenarioChat(ctx.session.api, `Research scenario ${researchJobLabel(job)} ${job.repeat}`);
        chatId = chat.id;
        createdChats.set(job, chat.id);
        run.chats.push(chat.id);
        capture = async () => {
          const answers = (await ctx.db.query<{ id: string; content: unknown }>(`SELECT r."id", m."content" FROM "ModelRun" r
            JOIN "Message" m ON m."id" = r."assistantMessageId" WHERE r."chatId" = $1 AND r."subagentTurnId" IS NULL
              AND (r."answerCompletedAt" IS NOT NULL OR r."status"::text IN ('complete', 'error', 'cancelled')) ORDER BY r."createdAt"`, [chat.id])).rows;
          for (const row of answers) {
            if (savedAnswers.has(row.id) || !isRecord(row.content) || !Array.isArray(row.content.blocks)) continue;
            const answer = row.content.blocks.filter((block) => isRecord(block) && block.type === "text" && typeof block.text === "string")
              .map((block: { text: string }) => block.text).join("\n");
            if (!answer.trim()) continue;
            archive.write(job, chat.id, `answer-${row.id}`, { ...job, chat: chat.id, run: row.id, answer });
            savedAnswers.set(row.id, clean(answer));
          }
          const gates = (await ctx.db.query<{ id: string; name: string; report: string | null; state: string }>(`SELECT t."id", th."name", t."result"->>'report' AS "report", t."state"::text AS "state"
            FROM "SubagentTurn" t JOIN "SubagentThread" th ON th."id" = t."threadId"
            WHERE t."chatId" = $1 AND th."name" ~ '^(gap-judge|verifier|skeptic)-' AND t."endedAt" IS NOT NULL ORDER BY t."startedAt"`, [chat.id])).rows;
          for (const row of gates) {
            if (savedGates.has(row.id)) continue;
            const gate = { role: researchThreadRole(row.name), report: row.report ?? "", state: row.state };
            archive.write(job, chat.id, `gate-${row.id}`, { ...job, chat: chat.id, ...gate });
            savedGates.set(row.id, { ...gate, report: clean(gate.report) });
          }
        };
        const act = job.kind === "set" ? null : options.acts[job.kind] ?? null;
        // Only the `+` menu's Deep research starts research (operator decision 2026-11-05), so the question carries it; a Continue goes on from the
        // interrupted run's own binding and names nothing, as the product's Continue does.
        const sendWords = async (text: string, deepResearch = true) => {
          const sent = await trySend(ctx, run, chat.id, text, [], { deepResearch, search: route });
          return sent.ok ? sent.runId : fail(`research_send_failed_${sent.code}`);
        };
        let runId = await sendWords(act === "handoff" ? SCENARIO_T_HANDOFF_QUESTION : question.text);
        if (act === "edit" || act === "start") {
          const { planInBrowser } = await planBrowserModule();
          browserAct = new AbortController();
          acted = planInBrowser(act)({ baseUrl: ctx.session.api.baseUrl.origin, chatId: chat.id, cookie: ctx.session.api.cookie, marker: randomUUID().replaceAll("-", ""), runId, signal: browserAct.signal })
            .then((evidence) => {
              emit({ stage: "research_act", kind: job.kind, act, ...evidence });
              return { act, ...evidence };
            }, (error: unknown) => {
              const failed = error instanceof BrowserScenarioError ? error.message : `interaction_failed:${error instanceof Error ? error.name : "unknown"}`;
              emit({ stage: "research_act", kind: job.kind, act, failed });
              return { act, failed };
            });
        }
        if (act === "push" && job.repeat === 1) {
          const { pushInBrowser } = await planBrowserModule();
          browserAct = new AbortController();
          acted = pushInBrowser({ baseUrl: ctx.session.api.baseUrl.origin, chatId: chat.id, cookie: ctx.session.api.cookie, marker: randomUUID().replaceAll("-", ""), runId, signal: browserAct.signal })
            .then((evidence) => ({ act, ...evidence }), (error: unknown) => ({ act, failed: error instanceof BrowserScenarioError ? error.message : "interaction_failed" }));
        }
        if (act === "restart") {
          const { continued, facts: restarted } = await restartAndContinue(ctx, run, chat.id, (text) => sendWords(text, false));
          runId = continued;
          facts.restart = restarted;
        }
        if (act === "outage") {
          const { continued, facts: outage } = await outageAndContinue(ctx, run, chat.id, (text) => sendWords(text, false));
          runId = continued;
          facts.outage = outage;
        }
        let quiet = 0;
        const terminal = await poll(Math.max(1, deadline - Date.now()), async () => {
          await capture!();
          const mains = await mainRuns(ctx.db, chat.id);
          const original = mains.find((entry) => entry.id === runId);
          const idle = original && TERMINAL_RUN_STATES.has(original.status) && mains.every((entry) => TERMINAL_RUN_STATES.has(entry.status)) &&
            await owedCallbacks(ctx.db, chat.id) === 0;
          quiet = idle ? quiet + 1 : 0;
          return quiet >= 2 ? original!.status : null;
        }, "research_question_timeout", 3_000);
        const { rows: calls } = await ctx.db.query<{ arguments: Record<string, unknown> | null; result: Record<string, unknown> | null; toolName: string }>(`SELECT c."arguments", c."result", c."toolName"
          FROM "ModelRunToolCall" c JOIN "ModelRun" r ON r."id" = c."modelRunId" WHERE r."chatId" = $1 ORDER BY c."startedAt"`, [chat.id]);
        const count = (name: string) => calls.filter((call) => call.toolName === name).length;
        const evidence = (await ctx.db.query<TEvidenceRow>(`SELECT "id", "kind", "claim", "quote", "url", "sourceClass", "dataset" FROM "ResearchEvidence" WHERE "chatId" = $1`, [chat.id])).rows;
        drafts = calls.filter((call) => call.toolName === "submit_research_draft").map((call) => [...researchDraftFindings(call.arguments, evidence)]);
        const opened = new Set(calls.filter((call) => call.toolName === "fetch_url" && (call.result?.rawPreview as { fetchUrl?: { outcome?: string } } | undefined)?.fetchUrl?.outcome === "read")
          .flatMap((call) => typeof call.arguments?.url === "string" ? [call.arguments.url] : []));
        for (const page of (await ctx.db.query<{ url: string }>(`SELECT DISTINCT "url" FROM "ResearchPage" WHERE "chatId" = $1`, [chat.id])).rows) opened.add(page.url);
        for (const call of calls) {
          if (!call.toolName.startsWith("mcp_workspace") || !call.arguments || !JSON.stringify(call.arguments).includes("aiqsa-browser")) continue;
          for (const match of JSON.stringify(call.arguments).matchAll(/https?:\/\/[^\s"'\\]+/gu)) opened.add(match[0]);
        }
        const turns = await turnRows(ctx.db, chat.id);
        const names = await threadIdsByName(ctx.db, chat.id);
        const gateThreads = new Set([...names].filter(([name]) => researchThreadRole(name) !== "researchers").flatMap(([, ids]) => ids));
        const sentBack = calls.filter((call) => call.toolName === "submit_research_draft" && JSON.stringify(call.result ?? "").includes("sent_back")).length;
        const frame = (await ctx.db.query<{ createdAt: Date; releasedAt: Date | null; releasedBy: unknown }>(`SELECT "createdAt", "releasedAt", "answer"->>'released_by' AS "releasedBy"
          FROM "ResearchFrame" WHERE "chatId" = $1 AND "modelRunId" = $2`, [chat.id, runId])).rows[0] ?? null;
        const metrics = researchMetrics({ drafts, opened, researcherTurns: turns.filter((turn) => !gateThreads.has(turn.threadId)).length,
          sentBack, started: count("start_research") > 0, planWindow: researchPlanWindow(frame) });
        const gates = (await ctx.db.query<TGateRow>(`SELECT th."name", t."reasonCode", t."state"::text AS "state", t."result"->>'report' AS "report"
          FROM "SubagentTurn" t JOIN "SubagentThread" th ON th."id" = t."threadId"
          WHERE t."chatId" = $1 AND th."name" ~ '^(gap-judge|verifier|skeptic)-' ORDER BY t."startedAt"`, [chat.id])).rows;
        Object.assign(facts, researchProcessFacts({ calls, drafts, gates }));
        const usage = await researchUsage(ctx, chat.id, turns, names);
        const researchers = usage.roles.researchers;
        facts.researcherInput = { meanPerResponse: researchers?.inputPerResponse ?? null, responses: researchers?.responses ?? 0, missing: researchers?.missingInput ?? 0 };
        // Read while the chat exists: the final answer, its last draft and the records it cites, against what each Search source returned.
        try {
          const cited = await researchAttribution(ctx, chat.id, { answer: [...savedAnswers.values()].at(-1) ?? "", evidence,
            labels: searchLabels, lastDraft: calls.filter((call) => call.toolName === "submit_research_draft").at(-1)?.arguments ?? null });
          archive.write(job, chat.id, "attribution", { ...job, chat: chat.id, citedRecords: cited.counts.citedRecords, searchCalls: cited.counts.searchCalls, ...cited.attribution });
          facts.attribution = cited.counts;
        } catch { facts.attribution = { failed: "research_attribution_failed" }; }
        // The phases, researcher turns, searches and candidate notes of the stand's rows, against the question's expectations.
        try {
          const acceptance = await researchAcceptance(ctx, chat.id, runId, { answer: [...savedAnswers.values()].at(-1) ?? "", appLog: options.appLog,
            expect: setQuestion?.expect ?? null, labels: searchLabels, responses: usage.responses, sourceLabels: route.sources.map((source) => source.label) });
          archive.write(job, chat.id, "acceptance", { ...job, chat: chat.id, ...acceptance.full });
          facts.acceptance = acceptance.counts;
        } catch { facts.acceptance = { failed: "research_acceptance_failed" }; }
        Object.assign(facts, { terminal: ["complete", "error", "cancelled", "interrupted"].includes(terminal) ? terminal : "other", metrics, tokens: usage.total.total,
          roles: usage.roles, tokensByModel: usage.byModel, store: await researchStore(ctx.db, chat.id, runId), planProposals: count("propose_research_plan"), toolCalls: calls.length, fetchCalls: count("fetch_url"),
          searches: calls.filter((call) => /^search_(?:selected_engines|engine_[1-3])$/u.test(call.toolName)).length });
        questionFailed = terminal !== "complete" || !metrics.started || savedAnswers.size === 0 || (job.kind === "purchase" && !options.acts.purchase && metrics.independentOpened === 0);
        if (act === "restart" || act === "outage") facts.continued = await continuedFacts(ctx.db, chat.id, runId);
        // A push follows the run's end by its grace and the push service's own time.
        if (act === "push" && acted) await Promise.race([acted, new Promise((resolve) => { setTimeout(resolve, T_PUSH_WAIT_MS); })]);
        browserAct?.abort();
        if (acted) facts.act = await acted;
      } catch {
        questionFailed = true;
        facts.harnessError = "research_question_failed";
        if (chatId !== null) {
          const mains = await mainRuns(ctx.db, chatId).catch(() => []);
          for (const main of mains.filter((entry) => !TERMINAL_RUN_STATES.has(entry.status))) {
            await request(ctx.session.api, `/api/model-runs/${encodeURIComponent(main.id)}/cancel`, { body: {}, method: "POST" }).catch(() => undefined);
          }
          await capture?.().catch(() => undefined);
        }
      }
      // The question's research has ended: the chat's steps follow in it, then each research run of the chat is read for review. Neither enters
      // the evaluation below, which grades the question's own answers.
      const processFacts = { ...facts };
      if (chatId !== null) {
        const reviewChat = chatId;
        const save = (entry: string, contents: unknown) => { archive.write(job, reviewChat, entry, { ...job, ...contents as Record<string, unknown> }); };
        let stepRuns = new Map<string, number>();
        if (research.steps.length > 0 && facts.harnessError === undefined) {
          const stepped = await researchSteps(ctx, run, reviewChat, research.steps, route, save, clean);
          facts.steps = stepped.lines;
          stepRuns = stepped.runs;
          if (stepped.failed) questionFailed = true;
        }
        try {
          await settledUsage(ctx.db, [reviewChat]);
          const researchRuns = (await ctx.db.query<{ runId: string }>(`SELECT "modelRunId" AS "runId" FROM "ResearchFrame" WHERE "chatId" = $1 ORDER BY "createdAt"`,
            [reviewChat])).rows;
          const review: Record<string, unknown>[] = [];
          for (const [index, entry] of researchRuns.entries()) {
            review.push({ research: index + 1, step: stepRuns.get(entry.runId) ?? null, ...await researchReview(ctx, reviewChat, entry.runId, save) });
          }
          facts.review = review;
        } catch (error) {
          facts.review = { failed: error instanceof BrowserScenarioError ? error.message : "research_review_failed" };
        }
      }
      const answer = [...savedAnswers.values()].join("\n\n---\n\n");
      facts.serverNotes = researchServerNotes(answer);
      processFacts.serverNotes = facts.serverNotes;
      if (answer && chatId !== null) {
        grade = await evaluateResearch(judge, RESEARCH_JUDGE_PROMPT, { question: question.text, answer,
          drafts: drafts.map((draft) => draft.map((finding) => ({ claim: clean(finding.claim), quote: clean(finding.quote), sourceClass: clean(finding.sourceClass), url: clean(finding.url) }))),
          gates: [...savedGates.values()], process: processFacts }, decodeResearchGrade);
        extraction = await evaluateResearch(judge, RESEARCH_EXTRACTION_PROMPT, { question: question.text, answer }, decodeStructuredResearchAnswer);
        try {
          archive.write(job, chatId, "judge", grade);
          archive.write(job, chatId, "extraction", extraction);
        } catch { questionFailed = true; facts.harnessError = "research_archive_write_failed"; }
        if (extraction.value) extracted.push({ job, answer: extraction.value });
      }
      const summary: Record<string, unknown> & { failed: boolean } = { ...facts, ...researchEvaluationSummary({ job, answerCount: savedAnswers.size, gateReportCount: savedGates.size,
        grade, extraction, failed: questionFailed, wallSeconds: seconds(started) }) };
      if (chatId !== null) {
        try { archive.write(job, chatId, "summary", summary); }
        catch { summary.failed = true; summary.harnessError = "research_archive_write_failed"; }
      }
      questions.push(summary);
      failed ||= summary.failed;
      emit({ stage: "research_question", ...summary });
    });
    failed ||= results.some((result) => result.status === "rejected");
    const comparisons = [...new Set(options.jobs.map(researchJobLabel))].map((kind) => {
      const jobs = options.jobs.filter((job) => researchJobLabel(job) === kind);
      const own = extracted.filter((entry) => researchJobLabel(entry.job) === kind).sort((a, b) => a.job.repeat - b.job.repeat);
      const comparison = { kind, expectedRuns: jobs.length, ...researchRepeatability(own.map((entry) => entry.answer)), detailsSaved: false };
      try {
        archive.write(jobs[0], createdChats.get(jobs[0]) ?? "no-chat", "comparisons", { kind, expectedRuns: jobs.length,
          ...researchComparisonDetails(jobs.map((job) => ({ repeat: job.repeat, chat: createdChats.get(job) ?? null,
            answer: own.find((entry) => entry.job.repeat === job.repeat)?.answer ?? null }))) });
        comparison.detailsSaved = true;
      } catch { failed = true; }
      return comparison;
    });
    Object.assign(run.line, { questions, comparisons, questionFailures: results.filter((result) => result.status === "rejected").length });
  } finally {
    // The administrator proxy goes first and whatever happens to the personal one: it is seen by every user's runs.
    if (adminProxyId !== null) {
      run.line.adminProxyRemoved = await removeAdminProxy(ctx, adminProxyId).catch(() => false);
    }
    if (ownedProxy !== null) {
      try {
        const stored = (await ctx.db.query<{ version: number }>(`SELECT "version" FROM "NetworkProxy" WHERE "id" = $1`, [ownedProxy])).rows[0];
        if (stored) await json(ctx.session.api, `/api/me/proxies/${encodeURIComponent(ownedProxy)}`, { body: { expectedVersion: stored.version }, method: "DELETE" });
      } catch { fail("research_proxy_cleanup_failed"); }
    }
  }
  return { success: !failed && questions.length === options.jobs.length, usage: usageByPurpose(await settledUsage(ctx.db, run.chats)) };
}

const N_TURN_MS = 10 * 60_000;

/** Uploads the document as the composer does without a Workspace: no scope. */
async function uploadDocument(ctx: Context, facts: ScenarioNFacts): Promise<string> {
  const form = new FormData();
  form.append("file", new File([Uint8Array.from(facts.document)], SCENARIO_N_FILE_NAME, { type: SCENARIO_N_MIME_TYPE }));
  const uploaded = decodeUploadAttachmentResponse(await json(ctx.session.api, "/api/uploads", { form, method: "POST", timeoutMs: L_PARSE_MS }));
  return uploaded?.attachment.id ?? fail("upload_response_invalid");
}

/** Whether the run's answer holds the word, matched inside SQL so neither leaves it. */
async function answerHolds(db: PostgresClient, runId: string, word: string): Promise<boolean> {
  const { rows } = await db.query<{ hit: boolean }>(`SELECT strpos(lower(m."content"::text), $2) > 0 AS "hit"
    FROM "ModelRun" r JOIN "Message" m ON m."id" = r."assistantMessageId" WHERE r."id" = $1`, [runId, word]);
  return rows[0]?.hit === true;
}

/** N's two turns, with the Workspace already off for the installation. */
async function noWorkspaceTurns(ctx: Context, run: Run): Promise<Outcome> {
  const facts = scenarioNFacts(runSecrets(randomBytes(16)).nonce);
  const chat = await createScenarioChat(ctx.session.api, "Sub-agent scenario N");
  run.chats.push(chat.id);
  const started = Date.now();
  const attachmentId = await uploadDocument(ctx, facts);
  const stored = await settledAttachment(ctx.db, attachmentId);
  const { rows: parsed } = await ctx.db.query<{ hit: boolean }>(`SELECT coalesce(strpos(lower("extractedText"), $2) > 0, false) AS "hit"
    FROM "Attachment" WHERE "id" = $1`, [attachmentId, facts.codeWord]);
  const textHasCodeWord = parsed[0]?.hit === true;
  const uploadFailures = scenarioNUploadChecks(stored, textHasCodeWord);
  run.line.upload = { bytes: facts.document.byteLength, extractedTextNull: stored?.extractedTextNull ?? null,
    processingErrorCode: stableCode(stored?.processingErrorCode), status: stableCode(stored?.status), textHasCodeWord };
  if (uploadFailures.length > 0) {
    run.line.checksFailed = uploadFailures;
    return { success: false, usage: null };
  }

  const noWorkspace = { workspace: { enabled: false } };
  const refused = (code: string): Outcome => {
    Object.assign(run.line, { admissionRefusal: stableCode(code), checksFailed: ["admission_refused"] });
    return { success: false, usage: null };
  };
  const first = await trySend(ctx, run, chat.id, SUBAGENT_PROMPTS.N.first(), [{ attachmentId, fileName: SCENARIO_N_FILE_NAME, type: "file" }], noWorkspace);
  if (!first.ok) return refused(first.code);
  const firstTerminal = await waitRun(ctx, first.runId, N_TURN_MS);
  Object.assign(run.line, { firstFailureCode: firstTerminal.errorCode, firstTerminal: firstTerminal.status });
  if (firstTerminal.status !== "complete") {
    run.line.checksFailed = ["first_run_not_complete"];
    return { success: false, usage: null };
  }
  await waitMainIdle(ctx, chat.id, N_TURN_MS);
  const second = await trySend(ctx, run, chat.id, SUBAGENT_PROMPTS.N.second(), [], noWorkspace);
  if (!second.ok) return refused(second.code);
  const secondTerminal = await waitRun(ctx, second.runId, N_TURN_MS);
  Object.assign(run.line, { secondFailureCode: secondTerminal.errorCode, secondTerminal: secondTerminal.status, wallSeconds: seconds(started) });

  const { tools, usage } = await commonEvidence(ctx, run, chat.id);
  const verdict = oracleN({
    answerHasCodeWord: await answerHolds(ctx.db, second.runId, facts.codeWord),
    firstAnswerHasCodeWord: await answerHolds(ctx.db, first.runId, facts.codeWord),
    firstTerminal: firstTerminal.status, secondTerminal: secondTerminal.status,
    sessionStarted: await sessionSample(ctx.db, chat.id) !== null,
    tools: scenarioNToolEvidence(tools, { first: first.runId, second: second.runId })
  });
  Object.assign(run.line, { checksFailed: verdict.failed, oracleCounts: verdict.counts });
  return { success: verdict.failed.length === 0, usage };
}

const O_TURN_MS = 15 * 60_000;
const O_STOP_MS = 3 * 60_000;

/** What the chat's thread list says started each sub-agent: what the tree nests it under. */
async function threadParents(ctx: Context, chatId: string): Promise<Record<string, string | null>> {
  const listed = decodeSubagentChatThreads(await json(ctx.session.api, SUBAGENT_API_PATHS.chatThreads(chatId))) ?? fail("threads_response_invalid");
  return Object.fromEntries(listed.threads.map((thread) => [thread.name, thread.parent?.name ?? null]));
}

/** The admin and personal routes `registerBulkResultMcpServer` drives, on this harness's session. */
function mcpClient(api: Api): BulkRegistrationClient {
  const call = (method: string) => async (path: string, init?: Readonly<{ data: unknown }>) => {
    const response = await request(api, path, { ...(init ? { body: init.data } : {}), method });
    return { json: () => response.json() as Promise<unknown>, ok: () => response.ok, status: () => response.status };
  };
  return { delete: call("DELETE"), patch: call("PATCH"), post: call("POST"), put: call("PUT") };
}

/**
 * O's last step: a call a helper may not make climbs to the main agent's card, and only the Allow sends it. The server is
 * this harness's own, so `dispatches` counts what reached it, and it goes when the step ends.
 */
async function approvalStep(ctx: Context, run: Run, chatId: string, facts: ScenarioOFacts): Promise<OEvidence["approval"]> {
  const { approver, clerk } = SUBAGENT_NAMES.nest;
  const none = { approvalsOnMainRun: 0, childTurn: null, dispatchedAfterAllow: 0, dispatchedBeforeAllow: 0, parentTurn: null };
  const records = createWriteApprovalFixture();
  const host = process.env.AIQSA_SUBAGENTS_FIXTURE_HOST?.trim() || "127.0.0.1";
  const publicHost = process.env.AIQSA_SUBAGENTS_FIXTURE_PUBLIC_HOST?.trim() || host;
  const endpoint = await startMutableMcpEndpoint(records.tools, { callTool: records.callTool, host, publicHost });
  let serverId: string | null = null;
  try {
    const { rows } = await ctx.db.query<{ userId: string }>(`SELECT "userId" FROM "Chat" WHERE "id" = $1`, [chatId]);
    const userId = rows[0]?.userId ?? fail("chat_owner_missing");
    serverId = await registerBulkResultMcpServer(mcpClient(ctx.session.api), { endpointUrl: endpoint.url, name: `Sub-agent records ${randomUUID().slice(0, 8)}`, userId });
    await waitMainIdle(ctx, chatId);
    const sent = await trySend(ctx, run, chatId, SUBAGENT_PROMPTS.O.approval(facts), [], { mcp: { mode: "load_all" } });
    if (!sent.ok) return { ...none, unavailable: stableCode(sent.code) };
    await waitRun(ctx, sent.runId);
    const deletion = { id: facts.recordId };
    const card = await poll(O_TURN_MS, async () => {
      const found = await ctx.db.query<{ id: string; modelRunId: string; onMain: boolean }>(`SELECT a."id", a."modelRunId", (r."subagentTurnId" IS NULL) AS "onMain"
        FROM "McpToolApproval" a JOIN "ModelRun" r ON r."id" = a."modelRunId" WHERE a."chatId" = $1 AND a."decision" IS NULL ORDER BY a."createdAt" DESC`, [chatId]);
      return found.rows.length > 0 ? found.rows : null;
    }, "approval_card_missing", 3_000).catch(() => []);
    const dispatchedBeforeAllow = endpoint.dispatches("delete_record", deletion);
    const threads = await threadIdsByName(ctx.db, chatId);
    const turns = await turnRows(ctx.db, chatId);
    const firstTurn = (name: string) => turns.find((turn) => turn.threadId === threads.get(name)?.at(-1)) ?? null;
    const approvalsOnMainRun = card.filter((row) => row.onMain).length;
    const [pending] = card;
    if (pending) {
      await json(ctx.session.api, `/api/model-runs/${encodeURIComponent(pending.modelRunId)}/mcp-approvals/${encodeURIComponent(pending.id)}`, {
        body: { decision: "allow_once", nonce: randomUUID() }, method: "POST" });
      await poll(O_TURN_MS, async () => endpoint.dispatches("delete_record", deletion) > 0 ? true : null, "approved_call_not_sent", 3_000).catch(() => false);
      await waitMainIdle(ctx, chatId);
    }
    return { approvalsOnMainRun, childTurn: firstTurn(approver), dispatchedAfterAllow: endpoint.dispatches("delete_record", deletion), dispatchedBeforeAllow,
      parentTurn: firstTurn(clerk), unavailable: null };
  } catch (error) {
    return { ...none, unavailable: error instanceof Error ? stableCode(error.message) : "approval_step_failed" };
  } finally {
    if (serverId) await request(ctx.session.api, `/api/admin/mcp/${encodeURIComponent(serverId)}`, { method: "DELETE" }).catch(() => undefined);
    await endpoint.close().catch(() => undefined);
  }
}

async function scenarioO(ctx: Context, run: Run): Promise<Outcome> {
  const facts = scenarioOFacts(runSecrets(randomBytes(16)).nonce);
  const { deep, deeper, first, holder, inner, lead, left, right, second, side, third } = SUBAGENT_NAMES.nest;
  const chat = await createScenarioChat(ctx.session.api, "Sub-agent scenario O");
  run.chats.push(chat.id);
  const started = Date.now();
  const threadOf = async (name: string) => (await threadIdsByName(ctx.db, chat.id)).get(name)?.at(-1) ?? null;
  const step = async (prompt: string) => (await waitRun(ctx, await send(ctx, run, chat.id, prompt))).status;
  const terminals: Record<string, string> = {};

  terminals.reports = await step(SUBAGENT_PROMPTS.O.reports(facts));
  const reports: OEvidence["reports"] = { children: await Promise.all([left, right].map((name) => latestTurnOf(ctx.db, chat.id, name))),
    leadHoldsBoth: await reportHolds(ctx.db, chat.id, lead, [facts.expected.left, facts.expected.right]) };

  terminals.limit = await step(SUBAGENT_PROMPTS.O.limit());
  const leadTurn = await waitTurnEnded(ctx, chat.id, lead, O_TURN_MS);
  const asked = await toolRows(ctx.db, chat.id);
  const limitCalls = asked.filter((row) => row.turnId === leadTurn?.turnId && row.toolName === "call_subagent");
  const children = await Promise.all([first, second, third].map((name) => latestTurnOf(ctx.db, chat.id, name)));
  const endTime = (turn: TurnRow | null) => turn?.endedAt ? new Date(turn.endedAt).getTime() : Number.POSITIVE_INFINITY;
  const limit: OEvidence["limit"] = { calls: limitCalls.length, children,
    leadEndedLast: children.every((turn) => turn === null || endTime(turn) <= endTime(leadTurn)),
    leadNamedCode: await reportHolds(ctx.db, chat.id, lead, ["subagent_child_limit_reached"]),
    refused: limitCalls.filter((row) => row.resultCode === "subagent_child_limit_reached").length };

  terminals.depth = await step(SUBAGENT_PROMPTS.O.depth());
  const deepThread = await threadOf(deep);
  const depth: OEvidence["depth"] = { grandchildren: (await threadIdsByName(ctx.db, chat.id)).get(deeper)?.length ?? 0,
    refused: (await toolRows(ctx.db, chat.id)).filter((row) => row.threadId === deepThread && row.resultCode === "subagent_depth_limit_reached").length };

  const stopRun = await send(ctx, run, chat.id, SUBAGENT_PROMPTS.O.stop());
  const running = await poll(O_TURN_MS, async () => {
    const threads = await threadIdsByName(ctx.db, chat.id);
    const [turns, tools] = [await turnRows(ctx.db, chat.id), await toolRows(ctx.db, chat.id)];
    const id = (name: string) => threads.get(name)?.at(-1);
    return [holder, inner, side].every((name) => turns.some((turn) => turn.threadId === id(name) && turn.state === "running")) &&
      [inner, side].every((name) => tools.some((tool) => tool.threadId === id(name) && tool.state === "running")) ? true : null;
  }, "levels_not_running", 3_000).catch(() => false);
  const stoppedAt = Date.now();
  await request(ctx.session.api, `/api/model-runs/${encodeURIComponent(stopRun)}/cancel`, { body: {}, method: "POST" });
  terminals.stop = (await waitRun(ctx, stopRun)).status;
  const stopTurns = await Promise.all([holder, inner, side].map((name) => waitTurnEnded(ctx, chat.id, name, O_STOP_MS)));
  const stop: OEvidence["stop"] = { running, secondsToEnd: seconds(stoppedAt), turns: stopTurns };

  const approval = await approvalStep(ctx, run, chat.id, facts);
  const { settled, usage } = await commonEvidence(ctx, run, chat.id);
  const verdict = oracleO({ approval, depth, limit, parents: await threadParents(ctx, chat.id), reports, settled, stop });
  const checks = [...verdict.failed];
  if (!usage.split) checks.push("usage_not_split");
  Object.assign(run.line, { approvalUnavailable: approval.unavailable, checksFailed: checks, oracleCounts: verdict.counts, terminals, wallSeconds: seconds(started) });
  return { success: checks.length === 0, usage };
}

/** Later scenarios need the Workspace, so it comes back on whatever happened; `runScenario` stops the harness when it could not. */
async function scenarioN(ctx: Context, run: Run): Promise<Outcome> {
  try {
    await setWorkspaceEnabled(ctx.session.api, false);
    return await noWorkspaceTurns(ctx, run);
  } finally {
    run.line.workspaceRestored = await setWorkspaceEnabled(ctx.session.api, true).then(() => true, () => false);
  }
}

async function runScenario(ctx: Context, id: SubagentScenarioId, index: number): Promise<SubagentRunRecord> {
  const run: Run = { chats: [], interactions: [], line: { run: index, scenario: id }, streams: [], tasks: [] };
  const started = Date.now();
  let outcome: Outcome = { success: false, usage: null };
  try {
    stage = `pre_run_cleanup_${id}`;
    run.line.sessionsRemovedBefore = await removeBrowserSessions(ctx.session.api);
    await syncSaucedemoSecret(ctx.session.api, false);
    stage = `scenario_${id}`;
    switch (id) {
      case "A": outcome = await scenarioA(ctx, run); break;
      case "B": outcome = await scenarioB(ctx, run); break;
      case "C1":
      case "C2": {
        const requested = id === "C2" ? ctx.second ?? fail("second_model_required") : null;
        outcome = await browsingScenario(ctx, run, { oracle: (read) => oracleC(read.value), requested,
          prompt: SUBAGENT_PROMPTS.C(requested ? ctx.options.secondModel : null), title: `Sub-agent scenario ${id}` });
        break;
      }
      case "D5":
      case "D1":
        outcome = await browsingScenario(ctx, run, { oracle: (read) => oracleD(read.value), prompt: SUBAGENT_PROMPTS.D(id === "D5"),
          requested: null, title: `Sub-agent scenario ${id}` });
        break;
      case "E": outcome = await scenarioE(ctx, run); break;
      case "F": outcome = await scenarioF(ctx, run); break;
      case "G": outcome = await scenarioG(ctx, run); break;
      case "H": outcome = await scenarioH(ctx, run); break;
      case "I": outcome = await scenarioI(ctx, run); break;
      case "J": outcome = await scenarioJ(ctx, run); break;
      case "K": outcome = await scenarioK(ctx, run); break;
      case "L": outcome = await scenarioL(ctx, run); break;
      case "M": outcome = await scenarioM(ctx, run); break;
      case "N": outcome = await scenarioN(ctx, run); break;
      case "O": outcome = await scenarioO(ctx, run); break;
      case "P": outcome = await scenarioP(ctx, run); break;
      case "Q": outcome = await scenarioQ(ctx, run); break;
      case "R": outcome = await scenarioR(ctx, run); break;
      case "S": outcome = await scenarioS(ctx, run); break;
      case "T": outcome = await scenarioT(ctx, run); break;
      case "U": outcome = await scenarioU(ctx, run); break;
    }
  } catch (error) {
    run.line.harnessError = error instanceof BrowserScenarioError ? error.message : "subagent_scenarios_run_failed";
    run.line.harnessStage = stage;
    outcome = { success: false, usage: outcome.usage };
  }
  await stopStreams(run);
  await Promise.all(run.interactions);
  run.line.success = outcome.success;
  run.line.elapsedSeconds = seconds(started);
  const { cleaned, ...cleanup } = await cleanUpScenario({
    deleteChat: (chatId) => deleteChat(ctx.session.api, ctx.db, chatId),
    deleteTask: (taskId) => deleteTask(ctx.session.api, taskId),
    removeBrowserSessions: () => removeBrowserSessions(ctx.session.api)
  }, { chatIds: run.chats, keepChats: ctx.keepChats, taskIds: run.tasks });
  Object.assign(run.line, cleanup);
  emit(run.line);
  if (!cleaned) fail("cleanup_failed");
  if (run.line.workspaceRestored === false) fail("workspace_not_restored");
  if (run.line.adminProxyRemoved === false) fail("admin_proxy_not_removed");
  return { run: index, scenario: id, success: outcome.success, usage: outcome.usage,
    wallSeconds: typeof run.line.wallSeconds === "number" ? run.line.wallSeconds : seconds(started) };
}

// Main -------------------------------------------------------------------------------

/** A support function's refusal as its own stable code (they throw plain errors), never its text. */
function stable<T>(work: () => T): T {
  try { return work(); } catch (error) {
    if (error instanceof BrowserScenarioError) throw error;
    return fail(error instanceof Error && /^[a-z0-9_]{1,64}$/u.test(error.message) ? error.message : "research_option_invalid");
  }
}

/**
 * Production's Search plan (AIQSA_SUBAGENTS_T_SEARCH=production) on the selected sources (AIQSA_SUBAGENTS_T_SEARCH_SOURCES), set up
 * by `ensureProductionSearch`; keys come from the process environment, and only a selected source's.
 */
async function productionSearch(api: Api, route: { apiRoot: string }, secret: string, search: Readonly<{ model: string | null; sources: readonly ResearchSearchLabel[] }>,
  model: CatalogModel): Promise<SearchRoute> {
  stage = "production_search";
  const sources = await ensureProductionSearch(api, { apiRoot: route.apiRoot, secret, sources: search.sources,
    ...(search.sources.includes("deepseek") ? { deepseekKey: process.env.DEEPSEEK_API_KEY?.trim() || fail("deepseek_key_required") } : {}),
    ...(search.model !== null ? { searchModel: search.model } : {}),
    // OpenRouter's first key checks its whole built-in list, so it is added only with the operator's approval of that cost.
    ...(search.sources.includes("perplexity") && process.env.AIQSA_SUBAGENTS_OPENROUTER_SETUP === "approved"
      ? { openrouterSetupKey: process.env.OPENROUTER_API_KEY?.trim() || fail("openrouter_key_required") } : {}),
    report: (source, status) => emit({ stage: "research_search_source", source, status }) });
  stage = "setup";
  return { mode: "all_selected", model, name: "production", sources };
}

function boundedInteger(raw: string | undefined, fallback: number, min: number, max: number, code: string): number {
  if (raw === undefined || raw.trim() === "") return fallback;
  const value = Number(raw);
  return Number.isSafeInteger(value) && value >= min && value <= max ? value : fail(code);
}

async function main() {
  const composeFile = process.env.AIQSA_SUBAGENTS_COMPOSE_FILE ?? fail("compose_required");
  const target = requireBrowserScenarioStand(process.env.AIQSA_SUBAGENTS_E2E,
    JSON.parse(readFileSync(composeFile, "utf8")) as BrowserScenarioStand);
  const scenarios = selectedSubagentScenarios(process.env.AIQSA_SUBAGENTS_SELECT);
  const route = codexLbRoute(readFileSync(join(homedir(), ".codex", "config.toml"), "utf8"));
  const options = subagentHarnessOptions(process.env, scenarios, route.model);
  if (!scenarios.includes("T") && ["AIQSA_SUBAGENTS_T_SEARCH", "AIQSA_SUBAGENTS_T_SEARCH_SOURCES", "AIQSA_SUBAGENTS_T_QUESTION_FILE", "AIQSA_SUBAGENTS_T_QUESTION_SET",
    "AIQSA_SUBAGENTS_T_APP_LOG_COMMAND", "AIQSA_SUBAGENTS_ADMIN_PROXY_FILE", "AIQSA_SUBAGENTS_T_STEPS_FILE"].some((name) => process.env[name]?.trim())) fail("research_option_requires_t");
  const parsedResearch = scenarios.includes("T") ? stable(() => researchEvalOptions(process.env)) : null;
  // The private files are read before anything is set up, so a refused one costs nothing; their text stays in memory.
  const questionSet = parsedResearch?.questionSet ? stable(() => readResearchQuestionSet(parsedResearch.questionSet!)) : null;
  const researchOptions = parsedResearch && questionSet ? { ...parsedResearch, jobs: researchSetJobs(questionSet, parsedResearch.setRepeats) } : parsedResearch;
  const researchQuestion = researchOptions?.questionFile
    ? stable(() => readPrivateFile(researchOptions.questionFile!, RESEARCH_QUESTION_MAX_BYTES, "research_question_file")) : null;
  const adminProxy = researchOptions?.adminProxyFile
    ? stable(() => parseResearchAdminProxy(readPrivateFile(researchOptions.adminProxyFile!, RESEARCH_ADMIN_PROXY_MAX_BYTES, "research_admin_proxy_file"))) : null;
  const tSteps = researchOptions?.stepsFile
    ? stable(() => parseResearchSteps(readPrivateFile(researchOptions.stepsFile!, RESEARCH_STEPS_MAX_BYTES, "research_steps_file"))) : [];
  if (researchOptions) {
    if (process.env.AIQSA_SUBAGENTS_TEST_PROXY?.trim() && !parseTestProxy(process.env.AIQSA_SUBAGENTS_TEST_PROXY)) fail("research_proxy_invalid");
    stable(() => createResearchArchive(researchOptions.answersDir));
  }
  const marginSeconds = boundedInteger(process.env.AIQSA_SUBAGENTS_MARGIN_SECONDS, 600, 60, 3_600, "margin_invalid");
  const label = process.env.AIQSA_SUBAGENTS_LABEL?.trim() || "unlabelled";
  if (!/^[A-Za-z0-9._/-]{1,80}$/u.test(label)) fail("label_invalid");
  const secret = process.env.CODEX_LB_API_KEY ?? fail("codex_lb_key_required");
  const db = standDatabase(target.databaseUrl);
  await db.connect();
  const started = Date.now();
  const records: SubagentRunRecord[] = [];
  try {
    stage = "preflight";
    await requireIdleStand(db);
    const api = await authenticate(target);
    stage = "setup";
    const { chatProvider, model } = await setUpStand(api, { chat: { route: "codex-lb" }, route, secret });
    let second: CatalogModel | null = null;
    if (options.secondModel !== null) {
      const added = await ensureModel(api, { apiRoot: route.apiRoot, model: options.secondModel }, secret, SECOND_MODEL_DISPLAY_NAME,
        process.env.AIQSA_SUBAGENTS_SECOND_NO_VISION === "1" ? { vision: false } : {});
      second = await catalogModel(api, added);
    }
    let blind: Context["blind"] = null;
    if (scenarios.includes("K")) {
      if (options.textModel !== null) {
        const added = await ensureTextModel(api, options.textModel, process.env.OPENROUTER_API_KEY ?? fail("openrouter_key_required"));
        blind = { id: options.textModel, model: await catalogModel(api, added) };
      } else if (second && options.secondModel !== null && !second.capabilities.imageInput) {
        blind = { id: options.secondModel, model: second };
      }
      if (blind?.model.capabilities.imageInput) fail("text_model_has_image_input");
    }
    // Q and R search for real: the DeepSeek client route always, and the codex-lb hosted route when its model offers one.
    const search: SearchRoute[] = [];
    if (researchOptions?.search) {
      search.push(await productionSearch(api, route, secret, researchOptions.search, model));
    } else if (scenarios.some((id) => SUBAGENT_SCENARIO_NEEDS[id].search)) {
      const client = await ensureSearchSource(api, { kind: "deepseek_search_api", provider: "deepseek", secret: process.env.DEEPSEEK_API_KEY ?? fail("deepseek_key_required") });
      search.push({ mode: "all_selected", model, name: "client", sources: [{ label: "deepseek", optionId: client }] });
      if (process.env.AIQSA_SUBAGENTS_HOSTED_SEARCH === "1") {
        const hostedModel = await ensureModel(api, { apiRoot: route.apiRoot, model: route.model }, secret, "Sub-agents hosted search model", { nativeSearch: true });
        const hosted = await ensureSearchSource(api, { connectionId: hostedModel.connectionId, kind: "web_search" });
        search.push({ mode: "model_choice", model: await catalogModel(api, hostedModel), name: "hosted", sources: [{ label: "hosted", optionId: hosted }] });
      }
    }
    if (scenarios.includes("T") && process.env.AIQSA_SUBAGENTS_VERIFIER_FAMILY) await ensureResearchVerifier(api, process.env.AIQSA_SUBAGENTS_VERIFIER_FAMILY);
    let research: Context["research"] = null;
    if (researchOptions) {
      await ensureResearchRoles(api, route, secret, researchOptions);
      const checks = researchOptions.checks;
      const client = createFetchOpenAIResponsesClient({ apiKey: secret, baseUrl: route.apiRoot, acceptStreamedCreate: true,
        defaultTimeoutMs: 10 * 60_000, initialRequestRetry: { maxAttempts: 1 }, requestIsolation: true });
      research = { options: researchOptions, adminProxy, question: researchQuestion, judge: checks.model ? (instructions, input) => client.create({ model: checks.model,
        instructions, input, max_output_tokens: 16_384, store: false, ...(checks.effort ? { reasoning: { effort: checks.effort } } : {}) }) : null,
        questions: new Map((questionSet ?? []).map((question) => [question.name, question] as const)), steps: tSteps };
    }
    emit({ stage: "ready", label, project: target.project, provider: "codex-lb", model: route.model, contextWindow: chatProvider.contextWindow,
      reused: chatProvider.reused, secondModel: second !== null, modelWithoutVision: blind !== null, restartHook: options.restart !== null,
      configuredBounds: target.configuredBounds, scenarios, runs: options.runs, searchPlan: search[0]?.name ?? null,
      searchSources: search[0]?.sources.map((source) => source.label) ?? [], questionFile: researchQuestion !== null,
      questionSet: questionSet ? { questions: questionSet.length, withExpectations: questionSet.filter((question) => question.expect !== null).length } : null,
      appLog: researchOptions?.appLog !== null && researchOptions?.appLog !== undefined, adminProxy: adminProxy !== null,
      steps: tSteps.map((step) => ({ deepResearch: step.deepResearch })) });
    const ctx: Context = { blind, db, keepChats: process.env.AIQSA_SUBAGENTS_KEEP_CHATS === "1", marginSeconds, model, options, research, search, second,
      session: { api }, target };
    for (let index = 1; index <= options.runs; index += 1) {
      for (const id of scenarios) records.push(await runScenario(ctx, id, index));
    }
    for (const id of scenarios) emit({ stage: "summary", ...subagentScenarioSummary(id, records) });
    emit({ status: "finished", label, model: route.model, runs: records.length, successes: records.filter((entry) => entry.success).length,
      elapsedSeconds: Math.round((Date.now() - started) / 1000) });
  } finally {
    await db.end().catch(() => undefined);
  }
}

main().catch((error: unknown) => {
  const code = error instanceof BrowserScenarioError ? error.message : "subagent_scenarios_check_failed";
  emit({ status: "failed", stage, code });
  process.exitCode = 1;
});
