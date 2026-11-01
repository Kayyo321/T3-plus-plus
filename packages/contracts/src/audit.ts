import * as Schema from "effect/Schema";

import {
  ForwardCompatibleArray,
  IsoDateTime,
  NonNegativeInt,
  ThreadId,
  TrimmedNonEmptyString,
} from "./baseSchemas.ts";

export const AUDIT_TEXT_MAX_CHARS = 2_000;
export const AUDIT_PAGE_MAX_ENTRIES = 200;

export const AuditEntryId = TrimmedNonEmptyString.pipe(Schema.brand("AuditEntryId"));
export type AuditEntryId = typeof AuditEntryId.Type;

export const AuditActorKind = Schema.Literals([
  "user",
  "orchestrator",
  "agent",
  "scheduled-task",
  "remote-guest",
  "system",
]);
export type AuditActorKind = typeof AuditActorKind.Type;

export const AuditOutcome = Schema.Literals(["succeeded", "failed", "denied", "pending"]);
export type AuditOutcome = typeof AuditOutcome.Type;

export const AuditTarget = Schema.Struct({
  kind: TrimmedNonEmptyString,
  id: TrimmedNonEmptyString,
  label: Schema.optional(Schema.String),
});
export type AuditTarget = typeof AuditTarget.Type;

/** A later command that reverses this entry, shown as Undo in the audit view. */
export const AuditUndo = Schema.Struct({
  tool: TrimmedNonEmptyString,
  input: Schema.Unknown,
  label: TrimmedNonEmptyString,
});
export type AuditUndo = typeof AuditUndo.Type;

export const AuditEntryInput = Schema.Struct({
  actor: AuditActorKind,
  /** The guest's device label, the task's name, or the provider session's model. */
  actorLabel: Schema.optional(Schema.String),
  domain: TrimmedNonEmptyString,
  action: TrimmedNonEmptyString,
  outcome: AuditOutcome,
  target: Schema.optional(AuditTarget),
  threadId: Schema.optional(ThreadId),
  /** What asked for this: the owner's message or the supervision signal. */
  request: Schema.optional(Schema.String),
  reasoning: Schema.optional(Schema.String),
  result: Schema.optional(Schema.String),
  undo: Schema.optional(AuditUndo),
});
export type AuditEntryInput = typeof AuditEntryInput.Type;

export const AuditEntry = Schema.Struct({
  ...AuditEntryInput.fields,
  id: AuditEntryId,
  at: IsoDateTime,
});
export type AuditEntry = typeof AuditEntry.Type;

export const AuditListInput = Schema.Struct({
  actor: Schema.optional(AuditActorKind),
  domain: Schema.optional(TrimmedNonEmptyString),
  threadId: Schema.optional(ThreadId),
  /** The `nextCursor` of the page before. */
  cursor: Schema.optional(NonNegativeInt),
  limit: Schema.optional(NonNegativeInt),
});
export type AuditListInput = typeof AuditListInput.Type;

export const AuditListResult = Schema.Struct({
  entries: ForwardCompatibleArray(AuditEntry),
  nextCursor: Schema.NullOr(NonNegativeInt),
});
export type AuditListResult = typeof AuditListResult.Type;

export class AuditTrailError extends Schema.TaggedError<AuditTrailError>()("AuditTrailError", {
  operation: Schema.String,
}) {
  override get message(): string {
    return `The audit trail could not ${this.operation}.`;
  }
}
