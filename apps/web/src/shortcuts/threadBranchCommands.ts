import { type CommandHandler, registerCommands } from "./dispatcher";

const THREAD_BRANCH_COMMANDS = [
  "thread.rewind",
  "thread.fork",
  "thread.newNestedSession",
  "thread.runInBackground",
] as const;
export type ThreadBranchCommand = (typeof THREAD_BRANCH_COMMANDS)[number];

let handlers: Readonly<Record<ThreadBranchCommand, () => void>> | null = null;

/** The open conversation owns these, so a shortcut and the palette act on the same thread. */
export function registerThreadBranchCommands(
  next: Readonly<Record<ThreadBranchCommand, () => void>>,
): () => void {
  handlers = next;
  const claim =
    (command: ThreadBranchCommand): CommandHandler =>
    (event) => {
      event.preventDefault();
      event.stopPropagation();
      next[command]();
    };
  const dispose = registerCommands(
    Object.fromEntries(THREAD_BRANCH_COMMANDS.map((command) => [command, claim(command)])),
  );
  return () => {
    dispose();
    if (handlers === next) handlers = null;
  };
}

export function runThreadBranchCommand(command: ThreadBranchCommand): void {
  handlers?.[command]();
}
