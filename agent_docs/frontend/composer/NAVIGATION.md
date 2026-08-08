# FRONTEND CHAT NAVIGATION

Owner: Chat interaction maintainers
Scope: Command palette and left-pane workspace navigation, chat discovery, account access, and responsive navigation behavior.
Read when: Changing the command palette, Workspace pane, chat list/search, navigation shortcuts, account entry, or narrow-screen access.
Code owners: Command-palette, Workspace/left-pane, chat navigation, and account-navigation components.
Not owned here: Composer input, run parameter controls, receipt/details, or visual composition.

## Command palette

- Ctrl/Cmd+K opens.
- Ctrl/Cmd+K is ignored while focus is inside text inputs, textareas, selects, or contenteditable regions.
- Escape closes.
- Arrow up/down wraps through results; Home/End moves to the first/last result.
- Enter executes selected item.
- Filtering covers actions, models, Search options, and the full workspace chat inventory, including provider/category aliases and non-presentational catalog ids in the model search index. A sidebar title/content query filters only workspace navigation and cannot remove chats from command-palette search.
- Results are grouped under readable Actions, Chats, Models, and Search strategies headings with group counts. Current chat/model/search rows use a visible `Current` marker; category and readable provider/capability/search context form the secondary line instead of exposing raw ids. An `Open assistants` action opens the Assistants surface.
- Long labels wrap, results scroll locally, keyboard movement keeps the active row visible, and an unmatched query replaces stale results with a readable `No matching commands` status. Enter does nothing when there is no result.
- The palette is viewport bounded. Arrow/Home/End/Enter operate its current option, and Escape or the backdrop closes it.
- Settings can be opened directly from the desktop icon rail, from either Account presentation, from the compact Workspace drawer, or from the command palette. Assistants is a separate direct rail and Account destination; the composer's Run setup offers the secondary `Use an assistant…` action that opens the quick picker instead.
- The command palette includes a `New chat` action for keyboard and mobile users.

## Left pane

- At `>=1281px`, one named `Primary navigation` icon rail always precedes the
  optional wide pane. Its ordered destinations are New chat, current Chats,
  Assistants, Settings, entitled Control Center, and bottom Account. Every
  entry has an exact accessible name and an associated visible hover/focus
  tooltip; unavailable entries remain focusable with guarded `aria-disabled`.
  Chats restores a hidden pane and is a no-op while it is already visible.
  Rail and pane Account triggers re-anchor one menu rather than duplicating it.
- The header gives the proof-backed primary action to `New Chat`, keeps `New folder` secondary, and places one labeled search field immediately below them. `New Chat` remains the pane's first focusable action.
- Chat search filters lightweight loaded summaries locally by title/provider/model only. Loaded message bodies do not become an accidental second local-content index.
- Non-empty search text also debounces a `/api/chats?q=<query>` request and merges server-side message-content matches, so chats that have never been opened in the current session can appear. The pane distinguishes `Title match`, `Model match`, and `Message match`, announces result/message-match counts, waits before showing empty results, and reports message-search failure while leaving local title/model results usable.
- Search results retain matching ancestor folders and temporarily reveal matches under locally collapsed branches. Clearing search, including Escape from the focused search field, restores the user's stored collapse choices and scrolls the current chat back into view when available.
- Chats with no folder render as plain top-level rows without a synthetic folder header. `No folder` is the row-menu destination label and explanatory copy calls this the `top level`. Folder rows use bounded indentation for nesting, total visible descendant-chat counts, a project-memory cue, and an active-descendant cue; collapsing a folder hides its whole descendant branch without making the active location ambiguous.
- Chat titles may use two lines and always retain the complete value as a tooltip. Provider/model plus update-date metadata appears only for duplicate-looking titles, model-query matches, or chats whose saved model is no longer available for new runs. An unavailable chat keeps exactly one visible availability cue while remaining readable/switchable; archived chats are removed from the active workspace response and therefore do not render as disabled rows.
- Selected chats have one visible selected state; favorites use one quiet star cue; every in-flight chat id from `runLifecycleStore.activeStreams` gets a readable live indicator even while another chat is open. Favorites still sort before non-favorites, and each group stays newest-first within that split.
- Each chat reserves exactly one overflow affordance instead of a permanent delete/favorite icon toolbar. Its named popover contains Favorite, Rename, Move, Share, Export, and confirmation-gated Delete; folder popovers contain New chat, New subfolder, Project settings, Rename, Move, and confirmation-gated Delete. Popovers scroll locally, bring themselves into the navigation viewport, and close on Escape/outside click without activating the row beneath them.
- Chat and folder `Move to folder` controls use the shared finite-option picker rather than a native select. Destination rows show `Current`, preserve `No folder` / `Top level`, indent nested folders to a bounded depth while retaining the readable full path, support Arrow/Home/End/Enter, and scroll their result list locally. The picker expands inside the desktop popover and follows the shared viewport-bounded bottom-sheet contract below `sm`; choosing a different destination applies immediately, then the owning popover closes through the existing successful-move lifecycle.
- All confirmation flows use shell dialogs with Escape/backdrop cancel and appropriate destructive or warning styling; native browser `window.confirm`, `window.alert`, and `window.prompt` are not used for app confirmations. This includes chat, folder, and message deletion plus discard-unsaved-changes prompts.
- `New Chat` opens a blank workspace with no folder and without creating a persisted chat row. Folder-menu `New chat` opens a blank workspace with that pending folder, and persistence happens only on the first send.
- The compact edge-action `Start new chat` is another trigger for that same top-level blank-workspace action, not a second creation path; it preserves keyed drafts and does not stop an active run in the chat being left.
- The rail `New chat` is a third presentation of that owner and uses the pane's
  exact creation/readiness unavailable predicate without native disabling, so
  its status and tooltip remain keyboard reachable.
- Account provisioning creates no synthetic default folder. New chats stay at the top level unless the user explicitly starts or moves them inside a user-created folder; existing folders remain ordinary user-owned workspace data.
- The mobile workspace drawer button is the leftmost edge-action control and the compact route to Account, using the same left-pane icon language and leaving the pipeline and right-side Details controls separated.
- Folder creation hides behind a `New folder` header action that reveals an inline name input on demand; Enter creates, Escape cancels, and the input is not permanently visible.
