import { GitGraphRecoveryKind, type GitGraphRecoveryPoint } from "@t3tools/contracts";
import * as Schema from "effect/Schema";

/**
 * A recovery point is one hidden ref. Its commit holds the metadata in the message, the commit the
 * branch was at as first parent, and a full snapshot of the worktree as second parent. Parents
 * rather than sibling refs mean one ref keeps everything alive through `git gc` and one delete
 * removes it.
 */
export const RECOVERY_REF_PREFIX = "refs/t3pp/recovery";
export const RECOVERY_RETAINED = 100;

const RecoveryMeta = Schema.Struct({
  kind: GitGraphRecoveryKind,
  label: Schema.String,
  branch: Schema.NullOr(Schema.String),
  /** The stash's message, restored with it. */
  stashMessage: Schema.optional(Schema.String),
});
export type RecoveryMeta = typeof RecoveryMeta.Type;

export const encodeRecoveryMeta = Schema.encodeSync(Schema.fromJsonString(RecoveryMeta));
const decodeRecoveryMeta = Schema.decodeUnknownOption(Schema.fromJsonString(RecoveryMeta));

export const recoveryRef = (id: string) => `${RECOVERY_REF_PREFIX}/${id}`;

export interface RecoveryRecord {
  readonly point: GitGraphRecoveryPoint;
  readonly meta: RecoveryMeta;
  readonly snapshot: string | null;
}

export function parseRecoveryRecords(stdout: string): ReadonlyArray<RecoveryRecord> {
  return stdout.split("\u001e").flatMap((record): ReadonlyArray<RecoveryRecord> => {
    const [ref, parents, createdAt, contents] = record.replace(/^\s+/u, "").split("\u001f");
    if (!ref || !parents || !ref.startsWith(`${RECOVERY_REF_PREFIX}/`)) return [];
    const decoded = decodeRecoveryMeta((contents ?? "").trim());
    if (decoded._tag === "None") return [];
    const meta = decoded.value;
    const [sha, snapshot] = parents.split(" ");
    if (!sha) return [];
    return [
      {
        meta,
        snapshot: snapshot ?? null,
        point: {
          id: ref.slice(RECOVERY_REF_PREFIX.length + 1),
          kind: meta.kind,
          label: meta.label,
          sha,
          branch: meta.branch,
          savedChanges: snapshot !== undefined,
          createdAt: Number(createdAt),
        },
      },
    ];
  });
}

export const RECOVERY_LIST_FORMAT =
  "--format=%(refname)%1f%(parent)%1f%(committerdate:unix)%1f%(contents)%1e";
