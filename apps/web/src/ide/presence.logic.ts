import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";
import type { ThreadId } from "@t3tools/contracts";

type Status =
  | "working"
  | "waiting"
  | "approval"
  | "input"
  | "request"
  | "ready"
  | "failed"
  | "limited";

const ACTIVE: ReadonlySet<Status> = new Set(["working", "waiting", "approval", "input", "request"]);
const MAX_THREADS = 6;

/** The current thread and every other live one in the project, oldest first so places hold. */
export function presenceThreads(
  shells: ReadonlyArray<EnvironmentThreadShell>,
  currentId: ThreadId,
  statusOf: (thread: EnvironmentThreadShell) => Status,
): EnvironmentThreadShell[] {
  return shells
    .filter(
      (thread) =>
        thread.archivedAt === null &&
        thread.deletedAt === null &&
        (thread.id === currentId || ACTIVE.has(statusOf(thread))),
    )
    .toSorted((a, b) => a.createdAt.localeCompare(b.createdAt))
    .slice(-MAX_THREADS);
}

export function presenceLabel(status: Status): string {
  switch (status) {
    case "working":
      return "Working";
    case "waiting":
      return "Waiting";
    case "approval":
      return "Needs your approval";
    case "input":
      return "Asked you a question";
    case "request":
      return "A guest is waiting";
    case "failed":
      return "Stopped with an error";
    case "limited":
      return "Hit a usage limit";
    case "ready":
      return "Done";
  }
}

export function threadInitial(title: string): string {
  return /[\p{L}\p{N}]/u.exec(title)?.[0]?.toUpperCase() ?? "•";
}

/** A stable git-lane color per thread, so an agent keeps its color everywhere it shows. */
export function threadLane(id: string): number {
  let hash = 0;
  for (let index = 0; index < id.length; index += 1) {
    hash = (Math.imul(hash, 31) + id.charCodeAt(index)) >>> 0;
  }
  return hash % 8;
}
