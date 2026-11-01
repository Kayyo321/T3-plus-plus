# Layouts, workspaces, and organization

Five related features about _how the app is arranged around you_: saved layouts, split view, IDE
mode, workspaces that hold folders and secrets, and conversation folders.

> **Naming.** A **workspace** is a named bundle of working folders, secrets, and settings (the
> concept Claude Code calls an environment). A **layout** is a saved arrangement of panels. The
> codebase's own "environment" still means one running server
> ([glossary](../internals/glossary.md)) and is unchanged.

## Layouts (saved panel arrangements)

A **layout** is an arrangement of panels: transcript, diff, terminal, file tree, git graph,
browser, task board, orchestrator, and so on, in the positions and sizes you like.

- Drag panels anywhere, split, stack as tabs, collapse, and resize.
- **Save** the current arrangement under a name (_Focus_, _Review_, _Debug_, _Pair_).
- **Apply** a saved layout to the current conversation, or set it as the layout a new conversation
  opens with.
- **Favorite** one layout as the default: every new conversation opens in it automatically.
  Per-project overrides are allowed ("`api` always opens in _Debug_").
- Layouts store arrangement and panel settings, not conversation content.
- Switching layouts is fast and animated gently, with no reload of content.
- Built-in starter layouts so the feature is useful on day one; reset to default always available.
- Reachable from the command palette ("Layout: Review") and the [orchestrator](./orchestrator.md).
- Mobile: layouts do not map onto small screens. Mobile keeps its own navigation, and may share only
  the favorite _panel set_ where meaningful.

Persist layouts as small, versioned documents. Because layouts are user preference, decide whether
they sync across devices through the environment or stay per device; per-device is simpler.

## Split view

Show two or more conversations side by side, each fully usable. Typical uses: a parent and its
[nested session](./sessions-and-agents.md), two forks compared, a conversation next to the
orchestrator.

- Drag a conversation from the sidebar to an edge to split; close with one click.
- Each pane has its own composer and run state. One pane is focused for keyboard input.
- Panes can be linked so scrolling and selection compare turns (useful for fork comparison).
- Layout participates in saved workspaces.
- Performance: only visible panes stream and render fully; hidden ones stay cheap. A large transcript
  in a narrow pane must not cost more than in a wide one.

## IDE mode

A mode where the app is the editor, not only a chat window with a viewer.

- Layout: file explorer, tabbed editor with syntax highlighting, integrated terminal, diff and git
  panels, and the conversation docked as a panel, not the main surface.
- The agent's edits appear in the editor live, with accept or revert per hunk.
- Quick selection-to-chat: select code, ask, and the selection is attached as context (the composer
  already supports context references).
- Language intelligence (go to definition, diagnostics) is valuable but expensive. Start by reusing
  the language servers the machine already has, or defer it; the minimum bar is _good file editing
  with agent awareness_, not a full IDE.
- It is a workspace layout plus a few panels, not a separate app. Chat-first users never see it.

## Workspaces (working folders and secrets)

A **workspace** is a named bundle that answers: _where does this work happen, and with what credentials?_

- **Working folders:** which directories belong to the workspace, and which one is the working root.
- **Secrets:** environment variables, tokens, and passwords, stored encrypted or pulled from a
  secret provider (the repository already ships a 1Password provider and a provider-definition
  package to extend).
- **Settings bundle:** default model, permission mode, allowed commands, MCP servers.
- **Attach** a workspace to a project or a conversation. Switching workspace changes where processes
  run and which secrets they receive.

### The rule that matters: secrets stay out of the chat

- Secret values are injected into **process environments at launch**, never into prompts, tool
  arguments, transcripts, or logs.
- The agent can see that `DATABASE_URL` _exists_, not its value. Tooling should show names only.
- Output redaction: known secret values are masked in command output before it reaches the model or
  the transcript. This is a best-effort backstop, not the primary control.
- Remote guests and the [orchestrator](./orchestrator.md) never read values.
- Workspace secrets are excluded from exports, forks to other machines, and replay files.
- Clear UI for "this conversation uses workspace _staging_", so no one is surprised which credentials
  are live.

## Conversation folders

Organize conversations beyond the project list.

- Folders and **subfolders** to any reasonable depth, in the sidebar.
- A conversation lives in one folder; **tags** (optional) cover cross-cutting groupings.
- Drag to move, bulk move, collapse state remembered.
- Smart folders are a nice extension: saved filters like "running", "needs input", "this week".
- Nested sessions appear under their parent regardless of folder.
- Folder ops (create, move, rename) are service methods so the orchestrator can reorganize a
  messy sidebar on request.
- Keep it cheap: virtualized lists, no animated rows that cost frames on long lists.
