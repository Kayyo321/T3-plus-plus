import {
  isNestedSessionLineage,
  type OrchestrationV2ThreadShell,
  type ThreadId,
} from "@t3tools/contracts";

export type NestedRelation =
  | "self"
  | "parent"
  | "ancestor"
  | "sibling"
  | "child"
  | "descendant"
  | "cousin";

export interface NestedFamilyMember {
  readonly threadId: ThreadId;
  readonly title: string;
  readonly relation: NestedRelation;
  readonly depth: number;
  readonly status: string | null;
}

type FamilyThread = Pick<
  OrchestrationV2ThreadShell,
  "id" | "title" | "lineage" | "activityRunStatus" | "status" | "archivedAt" | "deletedAt"
>;

/** Depth 0 is the conversation the family hangs from. Forks of it are not family. */
export function nestedFamilyOf(
  threads: ReadonlyArray<FamilyThread>,
  threadId: ThreadId,
): ReadonlyArray<NestedFamilyMember> {
  const byId = new Map(threads.map((thread) => [thread.id, thread]));
  const parentOf = (thread: FamilyThread) =>
    isNestedSessionLineage(thread.lineage) && thread.lineage.parentThreadId !== null
      ? byId.get(thread.lineage.parentThreadId)
      : undefined;
  const chainOf = (thread: FamilyThread) => {
    const chain = [thread];
    const seen = new Set([thread.id]);
    for (let parent = parentOf(thread); parent !== undefined; parent = parentOf(parent)) {
      if (seen.has(parent.id)) break;
      seen.add(parent.id);
      chain.push(parent);
    }
    return chain;
  };
  const self = byId.get(threadId);
  if (self === undefined) return [];
  const ancestors = chainOf(self);
  const root = ancestors.at(-1)!;
  const relationOf = (chain: ReadonlyArray<FamilyThread>): NestedRelation => {
    if (chain[0]!.id === threadId) return "self";
    if (chain[1]?.id === threadId) return "child";
    if (chain.some((link) => link.id === threadId)) return "descendant";
    if (ancestors[1]?.id === chain[0]!.id) return "parent";
    if (ancestors.some((link) => link.id === chain[0]!.id)) return "ancestor";
    return ancestors[1] !== undefined && chain[1]?.id === ancestors[1].id ? "sibling" : "cousin";
  };
  return threads.flatMap((thread) => {
    if (thread.archivedAt !== null || thread.deletedAt !== null) return [];
    const chain = chainOf(thread);
    if (chain.at(-1)?.id !== root.id) return [];
    return [
      {
        threadId: thread.id,
        title: thread.title,
        relation: relationOf(chain),
        depth: chain.length - 1,
        status: thread.activityRunStatus ?? thread.status ?? null,
      },
    ];
  });
}
