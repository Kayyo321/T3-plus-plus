import { AUDIT_TEXT_MAX_CHARS, ThreadId } from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as NodeServices from "@effect/platform-node/NodeServices";

import * as Sqlite from "../persistence/Sqlite.ts";
import * as AuditTrail from "./AuditTrail.ts";

const TestLayer = AuditTrail.layer.pipe(
  Layer.provideMerge(Sqlite.layerMemory),
  Layer.provideMerge(NodeServices.layer),
);

it.layer(TestLayer)("AuditTrail", (it) => {
  it.effect("filters by actor and pages newest first", () =>
    Effect.gen(function* () {
      const audit = yield* AuditTrail.AuditTrail;
      const threadId = ThreadId.make("thread-audit");
      yield* audit.record({ actor: "user", domain: "git", action: "push", outcome: "succeeded" });
      for (const action of ["rename", "archive", "fork"]) {
        yield* audit.record({
          actor: "orchestrator",
          domain: "conversations",
          action,
          outcome: "succeeded",
          threadId,
        });
      }
      const first = yield* audit.list({ actor: "orchestrator", limit: 2 });
      assert.deepStrictEqual(
        first.entries.map((entry) => entry.action),
        ["fork", "archive"],
      );
      assert.isNotNull(first.nextCursor);
      const second = yield* audit.list({
        actor: "orchestrator",
        limit: 2,
        cursor: first.nextCursor ?? 0,
      });
      assert.deepStrictEqual(
        second.entries.map((entry) => entry.action),
        ["rename"],
      );
      assert.strictEqual(second.nextCursor, null);
    }),
  );

  it.effect("caps free text", () =>
    Effect.gen(function* () {
      const audit = yield* AuditTrail.AuditTrail;
      yield* audit.record({
        actor: "remote-guest",
        actorLabel: "Pixel 8",
        domain: "remote-control",
        action: "message.send",
        outcome: "succeeded",
        request: "x".repeat(AUDIT_TEXT_MAX_CHARS + 50),
      });
      const { entries } = yield* audit.list({ actor: "remote-guest", limit: 1 });
      assert.strictEqual(entries[0]?.request?.length, AUDIT_TEXT_MAX_CHARS);
    }),
  );
});
