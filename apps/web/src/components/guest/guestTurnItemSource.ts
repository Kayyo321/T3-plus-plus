import {
  applyCommandOutputFrame,
  EMPTY_COMMAND_OUTPUT,
} from "@t3tools/client-runtime/state/command-output";
import {
  OrchestrationV2CommandOutputFrame,
  OrchestrationV2GetTurnItemResult,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { Atom } from "effect/reactivity";

import type { TurnItemSource } from "../chat/timelineRowContext";
import type { SharedThreadRoutes } from "./guestStream.logic";

/** What an expanded guest row says when it cannot read the item. */
class GuestItemReadError extends Data.TaggedError("GuestItemReadError")<{
  readonly message: string;
}> {}

const decodeDetail = Schema.decodeUnknownSync(Schema.toCodecJson(OrchestrationV2GetTurnItemResult));
const decodeFrame = Schema.decodeUnknownOption(
  Schema.fromJsonString(OrchestrationV2CommandOutputFrame),
);

/** `item` is null when the thread no longer has the item, or the session ended. */
async function fetchGuestItemDetail(url: string): Promise<OrchestrationV2GetTurnItemResult> {
  const response = await fetch(url);
  if (response.status === 401 || response.status === 403 || response.status === 404) {
    return { item: null };
  }
  if (!response.ok) throw new Error(`Guest item request failed with ${response.status}.`);
  return decodeDetail(await response.json());
}

// Keys are JSON so a url can never run into the revision after it.
const guestItemDetailAtom = Atom.family((key: string) => {
  const [url] = JSON.parse(key) as [string, string];
  return Atom.make(
    Effect.tryPromise({
      try: () => fetchGuestItemDetail(url),
      catch: () => new GuestItemReadError({ message: "Could not load this item." }),
    }),
  );
});

/** Ends after the frame of a settled command, so the browser does not reconnect to it. */
const guestCommandOutputAtom = Atom.family((url: string) => {
  const frames = Stream.callback<OrchestrationV2CommandOutputFrame, GuestItemReadError>((queue) =>
    Effect.acquireRelease(
      Effect.sync(() => {
        const source = new EventSource(url);
        source.addEventListener("message", (message) => {
          const frame = decodeFrame(message.data);
          if (Option.isNone(frame)) return;
          Queue.offerUnsafe(queue, frame.value);
          if (!frame.value.running) {
            source.close();
            Queue.endUnsafe(queue);
          }
        });
        // A non-200 response closes the source for good: the share ended or the item is gone.
        source.addEventListener("error", () => {
          if (source.readyState === EventSource.CLOSED) {
            Queue.failCauseUnsafe(
              queue,
              Cause.fail(new GuestItemReadError({ message: "Output is no longer available." })),
            );
          }
        });
        return source;
      }),
      (source) => Effect.sync(() => source.close()),
    ),
  );
  // `scan` emits its seed first; skipping it keeps the row "loading" until the first frame.
  return Atom.make(
    frames.pipe(
      Stream.scan(() => EMPTY_COMMAND_OUTPUT, applyCommandOutputFrame),
      Stream.filter((view) => view !== EMPTY_COMMAND_OUTPUT),
    ),
  );
});

/** Expanded rows read through the page's own routes, with the page's cookie. */
export const sharedTurnItemSource = (
  routes: Pick<SharedThreadRoutes, "item" | "commandOutput">,
): TurnItemSource => ({
  detail: ({ itemId, revision }) =>
    guestItemDetailAtom(JSON.stringify([routes.item(itemId), revision])),
  commandOutput: ({ itemId }) => guestCommandOutputAtom(routes.commandOutput(itemId)),
});
