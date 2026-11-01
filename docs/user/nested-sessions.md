# Nested sessions

A nested session is a conversation of its own under another one. Use it for work you want to keep talking to, such as a migration you want running while you carry on in the parent. For a quick question whose answer only the agent needs, the agent's own sub-agents are the better fit.

|             | Sub-agent           | Nested session                   |
| ----------- | ------------------- | -------------------------------- |
| Started by  | The agent, mid-turn | You, or the agent on your behalf |
| You talk to | Only the parent     | It, directly                     |
| Lifetime    | Ends with its task  | Stays until you close it         |

## Start one

Use **New nested session** in the command palette, or press `mod+alt+j`. Choose what it starts with:

- **Nothing** starts clean.
- **A summary** carries a short digest of the parent. An agent can write its own instead.
- **The full transcript** carries everything up to now.
- **Chosen files** carries only the files you name.

A nested session can use a different model, and can have its own worktree. Without one, it works in the same folder as its parent, so the two agents can overwrite each other's edits.

Nesting goes two levels deep by default. The `nestedSessionMaxDepth` server setting changes that.

## Work with one

Nested sessions sit indented under their parent in the sidebar, whichever folder that is in. Open one and talk to it as you would any conversation.

A nested session's agent can leave a summary card in the parent with `report_to_parent`, optionally starting a turn there. The parent's agent can read, message, and wait for its children with `t3_thread_read`, `t3_thread_send`, and `t3_thread_wait`.

## Close one

Closing a nested session archives it, and you can bring it back from the archive. Closing a parent asks what happens to its nested sessions: keep them, archive them, or stop them. Kept sessions move up to the list. The undo on that archive restores only the parent.
