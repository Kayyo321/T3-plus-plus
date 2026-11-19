# IDE mode

IDE mode turns the window into a code editor for the conversation's folder, with your agents still
in view. The editor is VSCodium, the open-source build of VS Code, so your keybindings, extensions,
terminals, and debuggers work the way they do in VS Code.

IDE mode is for web and desktop. The mobile app does not show it.

## Open and leave the IDE

Choose **IDE ↗** in the conversation's title bar, press Ctrl+Alt+E (Cmd+Option+E on macOS), or
search for `Open IDE` in the command palette. **Chat ↙** in the same place, or the same shortcut,
returns to the conversation exactly as you left it. Open files and terminals in the editor stay as
they were while you are away.

The editor opens the conversation's folder: its worktree when it has one, otherwise the project.
Conversations in Chat mode have no folder, so they do not offer the IDE.

The first time you open the IDE in an environment, T3++ downloads the editor to that environment,
about 110 MB. Later opens take a second or two. Opening the IDE needs permission to run terminals in
that environment.

## Your agents beside your code

The rail on the right edge shows the conversations working in this project:

- Each conversation has a letter and a color. The dot shows whether it is working, done, or waiting
  for you.
- Subagents the current conversation starts appear under it while they run.
- Hover a letter for its status. **Open in chat** takes you to that conversation.
- When a conversation needs your approval or asks a question, its window opens by itself. Choose
  **Answer in chat** to respond.

The orchestrator mark at the top of the rail, or Ctrl+Alt+O (Cmd+Option+O on macOS), opens the orchestrator in a
window over the editor.

## See what an agent changed

After a turn, the editor marks the lines the conversation's agent changed, in that conversation's
color from the rail. Files it touched carry its letter in the Explorer.

Above each change, **Accept** keeps it and clears its marks; **Revert** puts those lines back the
way they were before the turn, and **Undo** in the notification brings the change back. Revert
works one change at a time, and only while those lines still read the way the agent left them.
Accepted marks come back with `T3++: Show Accepted Agent Changes Again` in the command palette.

Marks cover the latest finished turn. Lines you edit afterwards stop counting as the agent's.

## Theme

The editor uses your T3++ theme, including custom and imported themes, and follows it when you
change it in **Settings > Appearance**. Code colors match the ones in T3++'s diffs and files.

## Extensions

Install extensions from the Extensions view as usual. They come from
[Open VSX](https://open-vsx.org), the open extension registry. A few Microsoft extensions, such as
Pylance, C# Dev Kit, and Remote SSH, are licensed only for Microsoft's own builds and are not
available there.

VS Code's own AI chat is turned off in the IDE, since your T3++ agents fill that role. You can turn
it back on in the editor's settings.

## Remote environments

The IDE runs on the environment that owns the folder, the same machine your agents use, and reaches
your browser through T3++. It works over your local network, Tailscale, and your relay without extra
setup.

VSCodium is not published for Windows on ARM; there, T3++ runs the x64 build under Windows'
emulation.
