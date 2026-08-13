# FRONTEND CHAT NAVIGATION

Owner: Chat interaction maintainers
Scope: Chat/folder navigation, bounded search, command palette, account destinations, and responsive sidebar behavior.
Read when: Changing chat discovery, sidebar actions, folders, archived chat access, command shortcuts, Account, or mobile navigation.
Code owners: `features/navigation-v2/`, the reviewed command-palette leaf, and focused workspace/navigation stores and actions.
Not owned here: Composer input, next-run controls, evidence/inspection, or visual token recipes.

## One navigation presentation

The product has one 260px chat-navigation sidebar and one navigation state owner. At `>=1024px` it starts open and may collapse completely; at `900–1023px` it starts collapsed and expands in normal flow; below `900px` the same content is a scrim-backed modal drawer. Collapse leaves adjacent `Открыть панель` and New-chat controls, never an icon rail, alternate chat list, or migrated state.

The sidebar contains:

- the Normal/Memory-off/Temporary New-chat choice;
- one explicit New-folder task;
- bounded title/folder search;
- nested folder/date groups and lightweight chat summaries;
- per-chat active-run and selected-state cues;
- incremental `Показать раньше` pagination;
- `Архив чатов`, `Библиотека`, and Settings/account destinations.

The workspace header owns the visible Account menu and command trigger. Account exposes Library, Archived chats, Settings, entitled Control Center, and Sign out. It does not create a second sidebar or resource workspace.

## Search and command access

- Ctrl/Cmd+K opens the reviewed command palette and is ignored while a text input, textarea, select, or contenteditable owns focus. Escape closes the top layer; Arrow/Home/End and Enter operate the current result.
- The sidebar and compact chat-search layer use the summary-only navigation boundary: chat title and owned folder name, never message, prompt, model, provider, snippet, or Memory content. Free text is sent through the owner-private search request and does not enter a URL.
- Search loading, no-result, failure, and retry states are distinct. A failed search does not erase the last useful normal navigation projection. Clearing the query restores the ordinary groups and the active chat.
- Library is the sole resource destination in navigation. Assistants, Knowledge, Files, and Memory are tabs inside that workspace, not parallel shell routes.

## Chat and folder actions

- A chat row reserves one overflow action. Current actions are Rename, Move, Favorite, Share, Export, Archive, Use Memory, and Memory-off. Archive is unavailable while that chat has an active run. Temporary remains a creation mode, not a retained-row toggle.
- Archive applies immediately without a dialog: the row leaves the live sidebar list at once, and the shared shell notice `Чат перемещён в архив` offers `Отменить`, which restores the chat and its row in place. Chat and folder mutations (create, rename, move, delete/archive) update the live navigation projection without a reload.
- Rename is inline, keeps its draft until exact success/cancel, and uses the current chat revision owner. Move uses explicit owned folder ids; labels never act as authorization.
- A folder row owns expand/collapse, New chat, New subfolder, Project settings, Rename, Move, and Delete. Indentation is bounded; ancestor visibility and active-descendant cues prevent a collapsed hierarchy from hiding the active location ambiguously.
- No chat/folder confirmation uses `window.confirm`, `window.alert`, or `window.prompt`. Destructive surfaces name the exact target and consequence, close on safe Escape/backdrop, and keep focus restoration with their opener.
- Starting a blank chat does not persist a row. The first accepted send creates it with the pending folder and Memory mode. Leaving another chat never stops its run or destroys its keyed draft.

## Archived and permanent deletion

- `Архив чатов` opens the existing owner-private archived list. Selecting a row opens its read-only preview with bounded older-page loading, Restore, and capability-gated permanent deletion. A Memory source link to an archived chat resolves to this preview rather than activating an ineligible chat.
- Restore uses the current source-revision fence and returns the chat to active navigation. Duplicate or stale restore attempts stay disabled or refresh the exact target.
- Permanent deletion rereads exact title/location/revision/leaf before authorization. Admission immediately removes the chat from active/archived navigation and leaves an account-bound progress surface. Forgetting facts sourced from that chat remains an explicit separate choice; external retention and backup limitations stay in Advanced details.

## Focus and responsive behavior

- Hiding focused sidebar content transfers focus to the visible Open control. Re-expansion restores the remembered source only while that fallback still owns focus.
- The mobile drawer traps focus, closes with its explicit control/Escape/backdrop, and restores its opener. Switching viewport composition never creates another query, selection, draft, or run owner.
- Navigation, menus, and move options own local scrolling and never widen the page. Coarse-pointer actions meet the shared minimum target; no primary workflow depends on hover or drag precision.
