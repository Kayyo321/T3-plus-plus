import { decodeLayoutDocument, LAYOUT_DOCUMENT_VERSION } from "./layoutDocument";
import type { ThreadArrangement } from "./threadArrangement";

const stringRecord = (value: unknown): Record<string, string> =>
  typeof value === "object" && value !== null
    ? Object.fromEntries(
        Object.entries(value).filter(
          (entry): entry is [string, string] => typeof entry[1] === "string",
        ),
      )
    : {};

/** Validates a persisted arrangement; the store spreads the result, so damage drops the field. */
export function decodeArrangement(value: unknown): { arrangement?: ThreadArrangement } {
  if (typeof value !== "object" || value === null) return {};
  const raw = value as Partial<Record<keyof ThreadArrangement, unknown>>;
  const document = decodeLayoutDocument({
    version: LAYOUT_DOCUMENT_VERSION,
    id: "arrangement",
    name: "arrangement",
    root: raw.root,
  });
  if (document === null) return {};
  return {
    arrangement: {
      layoutId: typeof raw.layoutId === "string" ? raw.layoutId : null,
      root: document.root,
      placements: stringRecord(raw.placements),
      activeByGroup: stringRecord(raw.activeByGroup),
      revision: typeof raw.revision === "number" ? raw.revision : 0,
    },
  };
}
