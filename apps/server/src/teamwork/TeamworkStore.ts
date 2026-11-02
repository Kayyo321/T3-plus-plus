import {
  DEFAULT_TEAM_BUDGET,
  DEFAULT_TEAM_SHEET_ID,
  TEAM_LEAD_MEMBER_ID,
  TEAM_SESSION_SLOT,
  TeamRosterSlot,
  TeamRun,
  TeamRunId,
  TeamSheet,
  TeamworkError,
  type ModelSelection,
  type RunId,
  type TeamBudget,
  type TeamMember,
  type TeamNote,
  type TeamSheetId,
  type TeamworkChange,
  type ThreadCapabilityMode,
  type ThreadId,
} from "@t3tools/contracts";
import {
  DEFAULT_TEAM_SHEET,
  leadNodeOf,
  teamMemberId,
  teamMemberName,
} from "@t3tools/shared/teamSheets";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/sql/SqlClient";

import * as WorkspaceProcessEnvironment from "../workspace/WorkspaceProcessEnvironment.ts";
import { leadBrief, ownerNoteBrief } from "./teamworkBriefs.ts";

const RunJson = Schema.fromJsonString(TeamRun);
const SheetJson = Schema.fromJsonString(TeamSheet);
const encodeRun = Schema.encodeSync(RunJson);
const encodeSheet = Schema.encodeSync(SheetJson);
const decodeRun = Schema.decodeUnknownEffect(RunJson);
const decodeSheet = Schema.decodeUnknownEffect(SheetJson);
const decodeSlot = Schema.decodeUnknownEffect(TeamRosterSlot);

const storeError = () =>
  new TeamworkError({
    reason: "store_failed",
    detail: "Teamwork state could not be stored or read.",
  });

export interface TurnContextInput {
  readonly threadId: ThreadId;
  readonly capabilityMode: ThreadCapabilityMode | undefined;
  readonly orchestrationRunId: RunId;
  readonly modelSelection: ModelSelection;
  readonly text: string;
  /** Wake-ups from sessions and scheduled messages are not the owner speaking. */
  readonly fromUser: boolean;
}

export interface BeginRunInput {
  readonly threadId: ThreadId;
  readonly sheet: TeamSheet;
  readonly request: string;
  readonly leadModel: ModelSelection;
  readonly budget?: TeamBudget | undefined;
  readonly originRunId?: RunId | undefined;
}

export class TeamworkStore extends Context.Service<
  TeamworkStore,
  {
    readonly withLock: <A, E, R>(effect: Effect.Effect<A, E, R>) => Effect.Effect<A, E, R>;
    readonly getRun: (id: TeamRunId) => Effect.Effect<Option.Option<TeamRun>, TeamworkError>;
    readonly saveRun: (run: TeamRun) => Effect.Effect<TeamRun, TeamworkError>;
    readonly listRuns: (
      parentThreadId: ThreadId | undefined,
    ) => Effect.Effect<ReadonlyArray<TeamRun>, TeamworkError>;
    readonly listRunsForCaller: (
      threadId: ThreadId,
    ) => Effect.Effect<ReadonlyArray<TeamRun>, TeamworkError>;
    readonly listRunningRuns: Effect.Effect<ReadonlyArray<TeamRun>, TeamworkError>;
    readonly activeRun: (threadId: ThreadId) => Effect.Effect<TeamRun | null, TeamworkError>;
    readonly beginRun: (input: BeginRunInput) => Effect.Effect<TeamRun, TeamworkError>;
    readonly getSheet: (id: TeamSheetId) => Effect.Effect<TeamSheet | null, TeamworkError>;
    readonly listSheets: Effect.Effect<ReadonlyArray<TeamSheet>, TeamworkError>;
    readonly insertSheet: (sheet: TeamSheet) => Effect.Effect<void, TeamworkError>;
    /** Compare-and-set on the revision. False means someone wrote first. */
    readonly writeSheet: (
      sheet: TeamSheet,
      baseRevision: number,
    ) => Effect.Effect<boolean, TeamworkError>;
    readonly removeSheet: (
      id: TeamSheetId,
      baseRevision: number,
    ) => Effect.Effect<boolean, TeamworkError>;
    readonly threadSheetId: (
      threadId: ThreadId,
    ) => Effect.Effect<TeamSheetId | null, TeamworkError>;
    readonly setThreadSheetId: (
      threadId: ThreadId,
      sheetId: TeamSheetId | null,
    ) => Effect.Effect<void, TeamworkError>;
    readonly roster: (
      threadId: ThreadId,
      sheetId: TeamSheetId,
    ) => Effect.Effect<ReadonlyArray<TeamRosterSlot>, TeamworkError>;
    readonly putSlot: (slot: TeamRosterSlot) => Effect.Effect<void, TeamworkError>;
    readonly publish: (change: TeamworkChange) => Effect.Effect<void>;
    readonly changes: Stream.Stream<TeamworkChange>;
    /** The Project Lead's brief for a turn, starting the run when this message opens one. */
    readonly takeTurnContext: (
      input: TurnContextInput,
    ) => Effect.Effect<string | null, TeamworkError>;
  }
>()("t3pp/teamwork/TeamworkStore") {}

const memberOfSlot = (run: Pick<TeamRun, "flow">, slot: TeamRosterSlot): TeamMember => {
  const node = run.flow.nodes.find((candidate) => candidate.id === slot.nodeId);
  return {
    id: teamMemberId(slot.nodeId, slot.slot),
    nodeId: slot.nodeId,
    slot: slot.slot,
    kind: node?.kind ?? "build",
    name: teamMemberName(node?.name ?? slot.nodeId, slot.slot),
    threadId: slot.sessionThreadId,
    state: node === undefined ? "removed" : slot.status === "blocked" ? "blocked" : "idle",
    ...(slot.detail === null ? {} : { detail: slot.detail }),
  };
};

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const crypto = yield* Crypto.Crypto;
  const processEnvironment = yield* WorkspaceProcessEnvironment.WorkspaceProcessEnvironment;
  const masks = yield* WorkspaceProcessEnvironment.ActiveSecretMasks;
  const changes = yield* PubSub.sliding<TeamworkChange>(256);
  const lock = yield* Semaphore.make(1);

  const sanitize = Effect.fn("TeamworkStore.sanitize")(function* <A>(threadId: ThreadId, value: A) {
    const launch = yield* processEnvironment.forThread(threadId);
    return masks.redactDeep(Option.isSome(launch) ? launch.value.mask.redactDeep(value) : value);
  });

  const decodeRows = (rows: ReadonlyArray<{ readonly json: string }>) =>
    Effect.forEach(rows, (row) => decodeRun(row.json).pipe(Effect.mapError(storeError)));

  const getRun: TeamworkStore["Service"]["getRun"] = Effect.fn("TeamworkStore.getRun")(function* (
    id,
  ) {
    const rows = yield* sql<{
      readonly json: string;
    }>`SELECT run_json AS json FROM teamwork_runs WHERE id = ${id}`;
    if (rows[0] === undefined) return Option.none();
    return Option.some(yield* decodeRun(rows[0].json));
  }, Effect.mapError(storeError));

  const insertRun = Effect.fn("TeamworkStore.insertRun")(function* (
    input: TeamRun,
    originRunId: RunId | undefined,
  ) {
    const run = yield* sanitize(input.parentThreadId, input);
    yield* sql`INSERT INTO teamwork_runs (id, parent_thread_id, run_json, origin_run_id) VALUES (${run.id}, ${run.parentThreadId}, ${encodeRun(run)}, ${originRunId ?? null}) ON CONFLICT (id) DO UPDATE SET run_json = excluded.run_json`.pipe(
      Effect.mapError(storeError),
    );
    yield* PubSub.publish(changes, { type: "run", runId: run.id, updatedAt: run.updatedAt });
    return run;
  });

  const saveRun: TeamworkStore["Service"]["saveRun"] = (run) => insertRun(run, undefined);

  const listRuns: TeamworkStore["Service"]["listRuns"] = Effect.fn("TeamworkStore.listRuns")(
    function* (parentThreadId) {
      const rows = yield* sql<{
        readonly json: string;
      }>`SELECT run_json AS json FROM teamwork_runs ${parentThreadId === undefined ? sql`` : sql`WHERE parent_thread_id = ${parentThreadId}`} ORDER BY rowid DESC LIMIT 100`.pipe(
        Effect.mapError(storeError),
      );
      return yield* decodeRows(rows);
    },
  );

  const listRunsForCaller: TeamworkStore["Service"]["listRunsForCaller"] = Effect.fn(
    "TeamworkStore.listRunsForCaller",
  )(function* (threadId) {
    const rows = yield* sql<{
      readonly json: string;
    }>`SELECT run_json AS json FROM teamwork_runs WHERE parent_thread_id = ${threadId} OR EXISTS (SELECT 1 FROM json_each(run_json, '$.members') WHERE json_extract(value, '$.threadId') = ${threadId}) ORDER BY rowid DESC LIMIT 100`.pipe(
      Effect.mapError(storeError),
    );
    return yield* decodeRows(rows);
  });

  const listRunningRuns = sql<{
    readonly json: string;
  }>`SELECT run_json AS json FROM teamwork_runs WHERE json_extract(run_json, '$.status') = 'running'`.pipe(
    Effect.mapError(storeError),
    Effect.flatMap(decodeRows),
  );

  const activeRun: TeamworkStore["Service"]["activeRun"] = Effect.fn("TeamworkStore.activeRun")(
    function* (threadId) {
      const rows = yield* sql<{
        readonly json: string;
      }>`SELECT run_json AS json FROM teamwork_runs WHERE parent_thread_id = ${threadId} AND json_extract(run_json, '$.status') IN ('running', 'awaiting_owner', 'blocked', 'over_budget') ORDER BY rowid DESC LIMIT 1`.pipe(
        Effect.mapError(storeError),
      );
      const runs = yield* decodeRows(rows);
      return runs[0] ?? null;
    },
  );

  const getSheet: TeamworkStore["Service"]["getSheet"] = Effect.fn("TeamworkStore.getSheet")(
    function* (id) {
      if (id === DEFAULT_TEAM_SHEET_ID) return DEFAULT_TEAM_SHEET;
      const rows = yield* sql<{
        readonly json: string;
      }>`SELECT sheet_json AS json FROM teamwork_sheets WHERE id = ${id}`;
      if (rows[0] === undefined) return null;
      return yield* decodeSheet(rows[0].json);
    },
    Effect.mapError(storeError),
  );

  const listSheets = sql<{
    readonly json: string;
  }>`SELECT sheet_json AS json FROM teamwork_sheets ORDER BY rowid ASC`.pipe(
    Effect.mapError(storeError),
    Effect.flatMap((rows) =>
      Effect.forEach(rows, (row) => decodeSheet(row.json).pipe(Effect.mapError(storeError))),
    ),
    Effect.map((sheets) => [DEFAULT_TEAM_SHEET, ...sheets]),
  );

  const insertSheet: TeamworkStore["Service"]["insertSheet"] = Effect.fn(
    "TeamworkStore.insertSheet",
  )(function* (sheet) {
    yield* sql`INSERT INTO teamwork_sheets (id, revision, sheet_json) VALUES (${sheet.id}, ${sheet.revision}, ${encodeSheet(sheet)})`.pipe(
      Effect.mapError(storeError),
    );
    yield* PubSub.publish(changes, {
      type: "sheet",
      sheetId: sheet.id,
      revision: sheet.revision,
    });
  });

  const writeSheet: TeamworkStore["Service"]["writeSheet"] = Effect.fn("TeamworkStore.writeSheet")(
    function* (sheet, baseRevision) {
      const written = yield* sql<{
        readonly id: string;
      }>`UPDATE teamwork_sheets SET revision = ${sheet.revision}, sheet_json = ${encodeSheet(sheet)} WHERE id = ${sheet.id} AND revision = ${baseRevision} RETURNING id`.pipe(
        Effect.mapError(storeError),
      );
      if (written.length === 0) return false;
      yield* PubSub.publish(changes, {
        type: "sheet",
        sheetId: sheet.id,
        revision: sheet.revision,
      });
      return true;
    },
  );

  const removeSheet: TeamworkStore["Service"]["removeSheet"] = Effect.fn(
    "TeamworkStore.removeSheet",
  )(function* (id, baseRevision) {
    const removed = yield* sql<{
      readonly id: string;
    }>`DELETE FROM teamwork_sheets WHERE id = ${id} AND revision = ${baseRevision} RETURNING id`.pipe(
      Effect.mapError(storeError),
    );
    if (removed.length === 0) return false;
    // A roster stays: its sessions are the user's conversations, whatever became of the sheet.
    const threads = yield* sql<{
      readonly threadId: ThreadId;
    }>`DELETE FROM teamwork_thread_sheets WHERE sheet_id = ${id} RETURNING thread_id AS "threadId"`.pipe(
      Effect.mapError(storeError),
    );
    yield* PubSub.publish(changes, { type: "sheet", sheetId: id, revision: null });
    for (const { threadId } of threads) {
      yield* PubSub.publish(changes, { type: "thread", threadId });
    }
    return true;
  });

  const threadSheetId: TeamworkStore["Service"]["threadSheetId"] = Effect.fn(
    "TeamworkStore.threadSheetId",
  )(function* (threadId) {
    const rows = yield* sql<{
      readonly sheetId: TeamSheetId;
    }>`SELECT sheet_id AS "sheetId" FROM teamwork_thread_sheets WHERE thread_id = ${threadId}`.pipe(
      Effect.mapError(storeError),
    );
    return rows[0]?.sheetId ?? null;
  });

  const setThreadSheetId: TeamworkStore["Service"]["setThreadSheetId"] = Effect.fn(
    "TeamworkStore.setThreadSheetId",
  )(function* (threadId, sheetId) {
    yield* (
      sheetId === null
        ? sql`DELETE FROM teamwork_thread_sheets WHERE thread_id = ${threadId}`
        : sql`INSERT INTO teamwork_thread_sheets (thread_id, sheet_id) VALUES (${threadId}, ${sheetId}) ON CONFLICT (thread_id) DO UPDATE SET sheet_id = excluded.sheet_id`
    ).pipe(Effect.mapError(storeError));
    yield* PubSub.publish(changes, { type: "thread", threadId });
  });

  const roster: TeamworkStore["Service"]["roster"] = Effect.fn("TeamworkStore.roster")(
    function* (threadId, sheetId) {
      const rows =
        yield* sql`SELECT thread_id AS "threadId", sheet_id AS "sheetId", node_id AS "nodeId", slot, session_thread_id AS "sessionThreadId", status, created_run_id AS "createdRunId", origin, detail FROM teamwork_roster WHERE thread_id = ${threadId} AND sheet_id = ${sheetId} ORDER BY rowid ASC`.pipe(
          Effect.mapError(storeError),
        );
      return yield* Effect.forEach(rows, (row) =>
        decodeSlot(row).pipe(Effect.mapError(storeError)),
      );
    },
  );

  const putSlot: TeamworkStore["Service"]["putSlot"] = Effect.fn("TeamworkStore.putSlot")(
    function* (slot) {
      yield* sql`INSERT INTO teamwork_roster (thread_id, sheet_id, node_id, slot, session_thread_id, status, created_run_id, origin, detail) VALUES (${slot.threadId}, ${slot.sheetId}, ${slot.nodeId}, ${slot.slot}, ${slot.sessionThreadId}, ${slot.status}, ${slot.createdRunId}, ${slot.origin}, ${slot.detail}) ON CONFLICT (thread_id, sheet_id, node_id, slot) DO UPDATE SET session_thread_id = excluded.session_thread_id, status = excluded.status, detail = excluded.detail`.pipe(
        Effect.mapError(storeError),
      );
    },
  );

  const beginRun: TeamworkStore["Service"]["beginRun"] = Effect.fn("TeamworkStore.beginRun")(
    function* (input) {
      const at = DateTime.formatIso(yield* DateTime.now);
      const { sheet } = input;
      const lead = leadNodeOf(sheet);
      if (lead === undefined) return yield* storeError();
      const slots = yield* roster(input.threadId, sheet.id);
      const flow = {
        sheetName: sheet.name,
        sheetRevision: sheet.revision,
        nestedSessions: sheet.nestedSessions,
        nodes: sheet.nodes,
        edges: sheet.edges,
      };
      const members = slots.map((slot) => memberOfSlot({ flow }, slot));
      const notes: ReadonlyArray<TeamNote> = members.flatMap((member) =>
        member.state === "removed"
          ? [
              {
                kind: "roster" as const,
                byId: TEAM_LEAD_MEMBER_ID,
                text: `${member.name} left the sheet. Its session stays in place, uninvoked.`,
                at,
              },
            ]
          : [],
      );
      return yield* insertRun(
        {
          id: TeamRunId.make(yield* crypto.randomUUIDv4().pipe(Effect.orDie)),
          parentThreadId: input.threadId,
          sheetId: sheet.id,
          flow,
          request: input.request,
          leadModel: input.leadModel,
          budget: input.budget ?? DEFAULT_TEAM_BUDGET,
          costUsd: 0,
          status: "running",
          activeNodeId: lead.id,
          waitingFor: null,
          correctionCycles: 0,
          members: [
            {
              id: TEAM_LEAD_MEMBER_ID,
              nodeId: lead.id,
              slot: TEAM_SESSION_SLOT,
              kind: "lead",
              name: lead.name,
              threadId: input.threadId,
              modelSelection: input.leadModel,
              state: "invoked",
            },
            ...members,
          ],
          tasks: [],
          notes,
          handoffs: [],
          evidence: [],
          verdicts: [],
          growth: [],
          report: null,
          startedAt: at,
          updatedAt: at,
        },
        input.originRunId,
      );
    },
  );

  const runFromOrigin = Effect.fn("TeamworkStore.runFromOrigin")(function* (originRunId: RunId) {
    const rows = yield* sql<{
      readonly json: string;
    }>`SELECT run_json AS json FROM teamwork_runs WHERE origin_run_id = ${originRunId}`.pipe(
      Effect.mapError(storeError),
    );
    return (yield* decodeRows(rows))[0] ?? null;
  });

  const takeTurnContext: TeamworkStore["Service"]["takeTurnContext"] = Effect.fn(
    "TeamworkStore.takeTurnContext",
  )(
    function* (input) {
      if (!input.fromUser || input.capabilityMode === "chat") return null;
      const sheetId = yield* threadSheetId(input.threadId);
      if (sheetId === null) return null;
      // A retried provider turn must not open a second run.
      const retried = yield* runFromOrigin(input.orchestrationRunId);
      if (retried !== null) {
        return leadBrief(retried, yield* roster(retried.parentThreadId, retried.sheetId));
      }
      const active = yield* activeRun(input.threadId);
      if (active !== null) {
        const at = DateTime.formatIso(yield* DateTime.now);
        const note = {
          kind: "owner" as const,
          byId: TEAM_LEAD_MEMBER_ID,
          text: input.text,
          at,
        };
        const updated = yield* saveRun({
          ...active,
          notes: [...active.notes, note],
          updatedAt: at,
        });
        return ownerNoteBrief(updated);
      }
      const sheet = yield* getSheet(sheetId);
      if (sheet === null) return null;
      const run = yield* beginRun({
        threadId: input.threadId,
        sheet,
        request: input.text,
        leadModel: input.modelSelection,
        originRunId: input.orchestrationRunId,
      });
      return leadBrief(run, yield* roster(run.parentThreadId, run.sheetId));
    },
    (effect) => lock.withPermits(1)(effect),
  );

  const withLock: TeamworkStore["Service"]["withLock"] = lock.withPermits(1);

  return TeamworkStore.of({
    withLock,
    getRun,
    saveRun,
    listRuns,
    listRunsForCaller,
    listRunningRuns,
    activeRun,
    beginRun,
    getSheet,
    listSheets,
    insertSheet,
    writeSheet,
    removeSheet,
    threadSheetId,
    setThreadSheetId,
    roster,
    putSlot,
    publish: Effect.fn("TeamworkStore.publish")(function* (change) {
      yield* PubSub.publish(changes, change);
    }),
    changes: Stream.fromPubSub(changes),
    takeTurnContext,
  });
});

export const layer = Layer.effect(TeamworkStore, make);
