# Workspaces

A workspace is a named answer to _where does this work happen, and with what credentials?_ It holds working folders, secrets, and a few settings. Attach one to a project or a conversation and its processes start in the workspace's working root with its secrets in their environment.

## Create one

Open **Settings > Workspaces** and choose **New workspace**. List its folders and pick the working root, the folder processes start in. Then use **Add secret** on its row.

Each secret is an environment variable. Store the value encrypted on this server, or point at a secret provider such as 1Password (set one up in **Settings > Secrets**). T3++ never shows a saved value again, to you or to an agent. To change one, replace it.

## Attach it

- **To a project:** in **Settings > Workspaces**, pick a workspace beside the project. Its conversations use it unless they choose another.
- **To a conversation:** use the workspace chip in the thread header, press `mod+alt+w`, or run **Change this conversation's workspace** from the command palette.

The chip always says which workspace is live for the conversation you are looking at. Child conversations use their parent's workspace.

A change takes effect the next time a process launches: the next turn restarts the provider session, and the terminal restarts when you next open it. You cannot switch a conversation's workspace while a turn is running.

A conversation with its own worktree keeps working there, and still receives the workspace's secrets.

## What a workspace sets

- **Most a conversation here may do.** A ceiling on the permission mode. It can hold a conversation back but never gives it more than you chose.
- **Allowed commands.** Command prefixes approved without asking, such as `npm test`. A command that chains another with `;`, `&&`, `|`, or `$(...)` still asks. Works with Claude and ACP providers.
- **MCP servers.** Started beside the provider session, so they see its environment. Works with Claude and ACP providers.
- **Default model.** New threads in a project attached to this workspace start on this model.

## Keeping secrets out of the chat

Values reach process environments at launch and nothing else. They stay out of prompts, tool arguments, transcripts, and logs. Agents can list a workspace's secret names, never their values, and exports and handoffs carry neither.

As a backstop, T3++ masks known values in command and terminal output, shown as `[secret:DATABASE_URL]`. It catches a value split across output chunks, and common encodings. With Claude, tool output is masked before the model reads it. With other providers it is masked before it reaches the transcript and your screen, but the model may already have seen it, so treat a program that prints its credentials as exposing them.

Values under 8 characters are never masked, because that would rewrite ordinary text. The secret form warns you when this applies.

Masking covers output. A file an agent writes containing a value is still a file containing that value.

## Which providers can use secrets

| Provider                                     | Secrets                                                                      |
| -------------------------------------------- | ---------------------------------------------------------------------------- |
| Claude, Grok, Pi, Muse, Antigravity, Fx, ACP | Yes. Each conversation has its own process.                                  |
| Codex, OpenCode                              | No. One process serves every conversation, so a secret would reach them all. |
| Cursor                                       | No. It runs inside the T3++ server.                                          |

A turn on a provider that cannot receive them refuses to start, and the chip warns you first. Pick another provider or a workspace without secrets. Workspaces that hold only folders work everywhere.

## Delete and restore

Deleting a workspace stops its secrets being injected at once. It stays listed under **Settings > Workspaces** with its secrets and attachments intact until you restore it or choose **Delete forever**. Removing a single secret cannot be undone; add it again to bring the variable back.
