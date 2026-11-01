import { assert, it } from "@effect/vitest";
import { ProviderDriverKind, ThreadId, TurnItemId } from "@t3tools/contracts";
import type * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import { makeSecretMask, noSecretMask } from "@t3tools/shared/secretRedaction";
import * as Chunk from "effect/Chunk";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";

import { makeProviderEventRedactor, withSecretsMasked } from "./ProviderEventRedaction.ts";

type Event = ProviderAdapter.ProviderAdapterV2Event;

const VALUE = "sk-live-0123456789abcdef";
const mask = makeSecretMask([{ name: "API_KEY", value: VALUE }]);
const driver = ProviderDriverKind.make("claudeAgent");
const threadId = ThreadId.make("thread-redaction");
const itemId = TurnItemId.make("item-redaction");

const delta = (chunk: string): Event => ({
  type: "command_output.delta",
  driver,
  threadId,
  itemId,
  chunk,
});

const finished = (output: string): Event =>
  ({
    type: "turn_item.updated",
    driver,
    turnItem: {
      type: "command_execution",
      id: itemId,
      threadId,
      status: "completed",
      output,
    },
  }) as unknown as Event;

const message = (text: string, streaming: boolean): Event =>
  ({
    type: "message.updated",
    driver,
    message: { text, streaming },
  }) as unknown as Event;

const live = (events: ReadonlyArray<Event>) =>
  events.flatMap((event) => (event.type === "command_output.delta" ? [event.chunk] : [])).join("");

it("masks live output split across chunks and the final output of the same item", () => {
  const redact = makeProviderEventRedactor(mask);
  const events = [
    ...redact(delta("key=sk-live-0123")),
    ...redact(delta("456789abcdef done pos")),
    ...redact(finished(`key=${VALUE} done pos`)),
  ];
  assert.strictEqual(live(events), "key=[secret:API_KEY] done pos");
  assert.notInclude(JSON.stringify(events), VALUE);
  assert.notInclude(JSON.stringify(events), "sk-live-0123");
});

it("flushes a held tail before the item that closes it", () => {
  const redact = makeProviderEventRedactor(mask);
  const events = [...redact(delta("ends with sk-")), ...redact(finished("ends with sk-"))];
  assert.strictEqual(live(events), "ends with sk-");
  assert.strictEqual(events.at(-1)?.type, "turn_item.updated");
});

it("does not let a streaming message show part of a secret", () => {
  const redact = makeProviderEventRedactor(mask);
  const [partial] = redact(message("The key is sk-live-01234", true));
  assert.strictEqual(
    partial?.type === "message.updated" ? partial.message.text : undefined,
    "The key is ",
  );
  const [complete] = redact(message(`The key is ${VALUE}.`, false));
  assert.strictEqual(
    complete?.type === "message.updated" ? complete.message.text : undefined,
    "The key is [secret:API_KEY].",
  );
});

it("masks any other event deep in its payload", () => {
  const redact = makeProviderEventRedactor(mask);
  const event = {
    type: "plan.updated",
    driver,
    plan: { steps: [{ text: `use ${VALUE}` }] },
  } as unknown as Event;
  assert.notInclude(JSON.stringify(redact(event)), VALUE);
});

it.effect("leaves a session without secrets as a plain passthrough", () =>
  Effect.gen(function* () {
    const events = Stream.make(delta("anything"));
    assert.strictEqual(withSecretsMasked(noSecretMask)(events), events);
    const masked = yield* withSecretsMasked(mask)(
      Stream.make(delta(`${VALUE.slice(0, 6)}`), delta(VALUE.slice(6)), delta(" ok")),
    ).pipe(Stream.runCollect);
    assert.strictEqual(
      live(Chunk.toReadonlyArray(Chunk.fromIterable(masked))),
      "[secret:API_KEY] ok",
    );
  }),
);
