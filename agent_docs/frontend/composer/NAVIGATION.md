# FRONTEND CHAT NAVIGATION

Owner: Chat interaction maintainers
Scope: Chat/folder navigation, bounded search, command palette, account destinations, and responsive sidebar behavior.
Read when: Changing chat discovery, sidebar actions, folders, archived chat access, command shortcuts, Account, or mobile navigation.
Code owners: `features/navigation-v2/`, the reviewed command-palette leaf, and focused workspace/navigation stores and actions.
Not owned here: Composer input, next-run controls, answer outputs, Branches behavior, or visual token recipes.

## One navigation presentation

The product has one 260px chat-navigation sidebar and one navigation state owner. At `>=1024px` it starts open and may collapse completely; at `900–1023px` it starts collapsed and expands in normal flow; below `900px` the same content is a scrim-backed modal drawer. Collapse leaves adjacent `Open sidebar` and New-chat controls, never an icon rail, alternate chat list, or migrated state.

The sidebar contains:

- a quiet New-chat split row whose mode menu offers the Normal/Memory-off/Temporary choice with the current session's mode marked;
- a quiet `Search ⌘K` row that opens the single shell command palette — the sidebar keeps no permanent inline search field;
- contextual folder creation: a root `New folder` entry inside the New-chat mode menu plus `New subfolder` in folder menus — no permanent New-folder row;
- nested folder/date groups and lightweight chat summaries;
- per-chat active-run and selected-state cues;
- incremental `Show earlier` pagination;
- `Archived chats` (the single archive entry), `Library`, and Settings/account destinations.

The workspace header owns the visible Account menu and command trigger, and it carries no kicker text. Account exposes Library, Settings, entitled Control Center, and Sign out; Archived chats is reached only through the sidebar row. For an active chat the header shows a Share button plus one `⋯` overflow menu (Rename, Move with the complete indented folder picker, Archive, capability-gated `Delete…`, Markdown export, JSON export, Copy thread, Branches); below 900px Share joins that same menu. The header title is inline-renameable through the shared chat-rename owner. It does not create a second sidebar or resource workspace.

## Search and command access

- Ctrl/Cmd+K and the sidebar `Search ⌘K` row open the same reviewed command palette; the shortcut is ignored while a text input, textarea, select, or contenteditable owns focus. Escape closes the top layer; Arrow/Home/End and Enter operate the current result.
- Chat search uses the summary-only navigation boundary: chat title and owned folder name, never message, prompt, model, provider, snippet, or Memory content. Free text is sent through the owner-private search request and does not enter a URL.
- Search loading, no-result, failure, and retry states are distinct. A failed search does not erase the last useful normal navigation projection. Clearing the query — including selecting a chat from results — restores the ordinary groups and the active chat.
- Library is the sole resource destination in navigation. Assistants, Knowledge, Files, and Memory are tabs inside that workspace, not parallel shell routes.

## Chat and folder actions

- A chat row reserves one overflow action. Current actions are Rename, Move, Favorite (showing the current favourite state), one Use-Memory toggle (showing the current retained mode), Share, Export (Markdown default), Archive, and — only while the server-verified `permanentChatDeletionAvailable` capability holds — `Delete…`, which opens the existing permanent-deletion confirm surface directly. Archive and delete are unavailable while that chat has an active run. Temporary remains a creation mode, not a retained-row toggle.
- The Move picker lists every owned folder, nested ones included, as one indented locally scrolling list; a folder's own Move picker excludes itself and its descendants.
- Archive applies immediately without a dialog: the row leaves the live sidebar list at once, and the shared shell notice `Chat moved to archive` offers `Undo`, which restores the chat and its row in place. Chat and folder mutations (create, rename, move, delete/archive) update the live navigation projection without a reload.
- Rename is inline, keeps its draft until exact success/cancel, and uses the current chat revision owner. Move uses explicit owned folder ids; labels never act as authorization.
- A folder row owns expand/collapse, New chat, New subfolder, Project settings, Rename, Move, and Delete. Indentation is bounded; ancestor visibility and active-descendant cues prevent a collapsed hierarchy from hiding the active location ambiguously.
- No chat/folder confirmation uses `window.confirm`, `window.alert`, or `window.prompt`. Destructive surfaces name the exact target and consequence, close on safe Escape/backdrop, and keep focus restoration with their opener.
- Starting a blank chat does not persist a row. The first accepted send creates it with the pending folder and Memory mode. Leaving another chat never stops its run or destroys its keyed draft.

## Archived and permanent deletion

- `Archived chats` opens the existing owner-private archived list with a client-side title filter. Each list row offers Restore and capability-gated permanent deletion directly; selecting a row still opens its read-only preview with bounded older-page loading and the same two actions. A Memory source link to an archived chat resolves to this preview rather than activating an ineligible chat.
- Restore uses the current source-revision fence and returns the chat to active navigation. Duplicate or stale restore attempts stay disabled or refresh the exact target.
- Permanent deletion — whether opened from the archive, a chat row's `Delete…`, or the header `⋯` — rereads exact title/location/revision/leaf before authorization and always passes through the same confirm surface. Admission immediately removes the chat from active/archived navigation and leaves an account-bound progress surface. Forgetting facts sourced from that chat remains an explicit separate choice; external retention and backup limitations stay in the advanced cleanup explanation.

## Focus and responsive behavior

- Hiding focused sidebar content transfers focus to the visible Open control. Re-expansion restores the remembered source only while that fallback still owns focus.
- The mobile drawer traps focus, closes with its explicit control/Escape/backdrop, and restores its opener. Switching viewport composition never creates another query, selection, draft, or run owner.
- Navigation, menus, and move options own local scrolling and never widen the page. Coarse-pointer actions meet the shared minimum target; no primary workflow depends on hover or drag precision.
