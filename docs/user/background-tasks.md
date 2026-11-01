# Background tasks

A background task is work attached to a conversation that keeps running without blocking it: a test run, a dev server, a watcher.

## Start one

- Type `/background` in the composer, with the command after it if you like.
- Use **Run in background** in the command palette, or press `mod+alt+g`.
- An agent can start one with its `background_task_start` tool.

Commands run in the conversation's folder with no input attached, so a command that stops to ask a question will fail rather than hang. Chat conversations cannot run commands.

## Follow it

The tray above the composer shows each task's name, state, elapsed time, and last line of output. The log button opens the end of its output. Logs are capped, so very old output of a noisy task is rotated away.

When a task ends, it leaves a card in the conversation and a notification. Turn on **Resume the agent when it ends** and the agent gets a turn to act on the result.

A task keeps running when you close the window, as long as its server does. If you want that to survive closing the desktop app too, use the [background service](./background-service.md). If the server restarts, the task's process is gone and the tray marks it **Lost on restart**.

Stopping a task stops everything it started. Archiving or deleting its conversation stops it too. Finished tasks stay in the tray until you remove them.

The mobile app shows what is running and can stop it. Starting a task needs web or desktop.
