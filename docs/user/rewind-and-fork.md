# Rewind and fork

Rewind returns a conversation to an earlier point. Fork starts a new conversation from one. Neither loses anything.

## Rewind

Use the pencil on one of your messages, **Rewind this thread** in the command palette, or `mod+alt+z`. The dialog shows what each choice would do before anything changes:

- **Conversation only** drops the later messages. Files stay as they are.
- **Files only** restores files from that turn's checkpoint. The conversation stays, and the agent is told its earlier edits may be gone.
- **Conversation and files** does both.

Files restore to a turn boundary, so a message in the middle of a turn returns to the end of that turn.

What a rewind discards stays on an archived branch. Find it under **History** in the thread details, where you can reopen it or fork from it. Reopening one that restored files checks them out in a worktree of its own, so it cannot disturb the conversation you rewound.

If files changed outside the agent since its last turn, the dialog lists them. You can stash them first, which leaves an ordinary `git stash` entry, or leave them only on the archived branch.

Restoring files needs a worktree this conversation has to itself. A conversation sharing its folder can still rewind its conversation.

### Which agents can rewind

| Agent                               | Conversation rewind                                           |
| ----------------------------------- | ------------------------------------------------------------- |
| Claude, Codex, OpenCode, Pi         | Yes                                                           |
| Grok, Antigravity, other ACP agents | Yes, but the agent restarts and forgets the earlier turns too |
| Cursor, Muse                        | No, files only                                                |

Codex threads that use paginated history refuse a conversation rewind.

## Fork

Use the fork button on any message, **Fork this thread** in the command palette, or `mod+alt+f`. The dialog shows how much context carries over and whether the same agent continues or a new one starts from a replay.

Forking from one of your messages stops just before it. Forking from a reply in the middle of a turn cuts the turn there, which always starts the agent from a replay. Forking from the first message is not possible, because nothing comes before it.

**History** in the thread details shows how the conversation's forks, nested sessions, and rewind branches relate.

Agents reach the same actions through `t3_thread_rewind`, `t3_thread_fork_preview`, and `t3_thread_transfer`.
