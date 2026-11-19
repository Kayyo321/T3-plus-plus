import { assert, it } from "@effect/vitest";
import { ThreadId, type IdeAgentChangesInput } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Context from "effect/Context";
import { HttpClient, HttpRouter } from "effect/http";

import * as IdeAgentChanges from "./IdeAgentChanges.ts";
import * as IdeProxy from "./IdeProxy.ts";
import * as IdeService from "./IdeService.ts";

const SECRET = "a".repeat(32);

it.effect("serves the margin feed only behind the running editor's capability", () =>
  Effect.gen(function* () {
    const asked: IdeAgentChangesInput[] = [];
    const context = Context.make(
      IdeService.IdeService,
      IdeService.IdeService.of({
        open: () => Effect.die("unused"),
        setTheme: () => Effect.void,
        proxyTarget: (secret) =>
          Effect.succeed(
            secret === SECRET ? { origin: "http://127.0.0.1:1", token: "token" } : null,
          ),
      }),
    ).pipe(
      Context.add(
        IdeAgentChanges.IdeAgentChanges,
        IdeAgentChanges.IdeAgentChanges.of({
          bind: () => Effect.void,
          changes: (input) =>
            Effect.sync(() => {
              asked.push(input);
              return { version: "none", thread: null, files: [] };
            }),
          applyHunk: () => Effect.void,
        }),
      ),
      // Feed requests never reach the editor process.
      Context.add(
        HttpClient.HttpClient,
        HttpClient.make(() => Effect.die("unused")),
      ),
    );
    const { handler, dispose } = HttpRouter.toWebHandler(IdeProxy.layer, { disableLogger: true });
    yield* Effect.addFinalizer(() => Effect.promise(dispose));
    const send = (path: string, init?: RequestInit) =>
      Effect.promise(() => handler(new Request(`http://env.local${path}`, init), context));

    const forged = yield* send(`/ide/${"b".repeat(32)}/.t3pp/changes?folder=%2Frepo`);
    assert.strictEqual(forged.status, 404);
    const forgedAction = yield* send(`/ide/${"b".repeat(32)}/.t3pp/hunk`, {
      method: "POST",
      body: JSON.stringify({
        folder: "/repo",
        threadId: ThreadId.make("thread"),
        turn: 1,
        path: "/repo/a.ts",
        hunkId: "hunk",
        action: "revert",
      }),
    });
    assert.strictEqual(forgedAction.status, 404);
    assert.deepEqual(asked, []);

    const served = yield* send(`/ide/${SECRET}/.t3pp/changes?folder=%2Frepo&after=v1`);
    assert.strictEqual(served.status, 200);
    assert.deepEqual(yield* Effect.promise(() => served.json()), {
      version: "none",
      thread: null,
      files: [],
    });
    assert.deepEqual(asked, [{ folder: "/repo", after: "v1" }]);

    const malformed = yield* send(`/ide/${SECRET}/.t3pp/hunk`, { method: "POST", body: "{}" });
    assert.strictEqual(malformed.status, 400);
  }),
);
