import { isOrchestrationV2WorkActive } from "@t3tools/contracts";
import type * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import {
  noSecretMask,
  type SecretMask,
  type SecretMaskStream,
} from "@t3tools/shared/secretRedaction";
import * as Stream from "effect/Stream";

type ProviderEvent = ProviderAdapter.ProviderAdapterV2Event;

/**
 * One event in, the events safe to persist and publish out. Stateful per session: live command
 * output arrives in chunks that can split a value, so each item keeps its own held tail.
 */
export const makeProviderEventRedactor = (mask: SecretMask) => {
  const outputs = new Map<string, SecretMaskStream>();

  const flushOutput = (event: {
    readonly driver: ProviderEvent["driver"];
    readonly threadId: Extract<ProviderEvent, { type: "command_output.delta" }>["threadId"];
    readonly itemId: Extract<ProviderEvent, { type: "command_output.delta" }>["itemId"];
  }): ReadonlyArray<ProviderEvent> => {
    const stream = outputs.get(event.itemId);
    if (stream === undefined) return [];
    outputs.delete(event.itemId);
    const chunk = stream.flush();
    return chunk.length === 0
      ? []
      : [{ type: "command_output.delta", ...event, chunk: mask.redact(chunk) }];
  };

  return (event: ProviderEvent): ReadonlyArray<ProviderEvent> => {
    switch (event.type) {
      case "command_output.delta": {
        const stream = outputs.get(event.itemId) ?? mask.stream();
        outputs.set(event.itemId, stream);
        const chunk = stream.write(event.chunk);
        return chunk.length === 0 ? [] : [{ ...event, chunk }];
      }
      case "turn_item.updated":
        return [
          ...(event.turnItem.type === "command_execution" &&
          !isOrchestrationV2WorkActive(event.turnItem.status)
            ? flushOutput({
                driver: event.driver,
                threadId: event.turnItem.threadId,
                itemId: event.turnItem.id,
              })
            : []),
          mask.redactDeep(event),
        ];
      case "message.updated": {
        const redacted = mask.redactDeep(event);
        return [
          event.message.streaming
            ? {
                ...redacted,
                message: { ...redacted.message, text: mask.redactGrowing(event.message.text) },
              }
            : redacted,
        ];
      }
      case "turn.terminal":
        outputs.clear();
        return [event];
      default:
        return [mask.redactDeep(event)];
    }
  };
};

/** Sessions without secrets stay a plain passthrough. */
export const withSecretsMasked =
  (mask: SecretMask) =>
  <E, R>(events: Stream.Stream<ProviderEvent, E, R>): Stream.Stream<ProviderEvent, E, R> => {
    if (mask === noSecretMask) return events;
    const redactEvent = makeProviderEventRedactor(mask);
    return events.pipe(Stream.flatMap((event) => Stream.fromIterable(redactEvent(event))));
  };
