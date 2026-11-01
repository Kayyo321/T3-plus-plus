import { WORKSPACE_SECRET_MIN_MASKED_LENGTH } from "@t3tools/contracts";

/**
 * Masks known secret values in text on its way to a transcript, a client, or a model. A backstop,
 * not the control: the control is that values only ever enter process environments.
 */

export interface SecretMaskEntry {
  readonly name: string;
  readonly value: string;
}

interface Needle {
  readonly text: string;
  readonly mask: string;
}

export interface SecretMask {
  /** Masks every complete occurrence. */
  readonly redact: (text: string) => string;
  /** Masks text that is still growing, and drops a tail that could become a secret. */
  readonly redactGrowing: (text: string) => string;
  /** Masks strings anywhere in plain objects and arrays; other values pass through. */
  readonly redactDeep: <A>(value: A) => A;
  /** Keeps its own held tail, so one instance serves one ordered stream. */
  readonly stream: () => SecretMaskStream;
}

export interface SecretMaskStream {
  /** What is safe to emit now. A tail that may be the start of a secret waits for the next write. */
  readonly write: (chunk: string) => string;
  /** Releases the held tail once no more output can complete it. */
  readonly flush: () => string;
  readonly holding: () => boolean;
}

const lineBreak = /\r\n|\r|\n/;

const encodings = (value: string): ReadonlyArray<string> => {
  const base64 = Buffer.from(value, "utf8").toString("base64");
  return [
    // A PEM key or other multi-line value prints with whatever line endings the terminal uses.
    ...value.split(lineBreak),
    // An encoded form outgrows the floor, but that does not make the value meaningful.
    ...(value.length < WORKSPACE_SECRET_MIN_MASKED_LENGTH
      ? []
      : [
          value,
          encodeURIComponent(value),
          base64,
          base64.replace(/=+$/u, ""),
          JSON.stringify(value).slice(1, -1),
        ]),
  ];
};

const needlesFor = (entries: ReadonlyArray<SecretMaskEntry>): ReadonlyArray<Needle> => {
  const byText = new Map<string, string>();
  for (const { name, value } of entries) {
    for (const text of encodings(value)) {
      if (text.length >= WORKSPACE_SECRET_MIN_MASKED_LENGTH && !byText.has(text)) {
        byText.set(text, `[secret:${name}]`);
      }
    }
  }
  // Longest first, so a value containing another is replaced whole.
  return [...byText]
    .map(([text, mask]) => ({ text, mask }))
    .sort((left, right) => right.text.length - left.text.length);
};

const replaceAll = (needles: ReadonlyArray<Needle>, text: string) => {
  let next = text;
  for (const needle of needles) {
    if (next.includes(needle.text)) next = next.replaceAll(needle.text, needle.mask);
  }
  return next;
};

/** Length of the longest suffix of `text` that begins some needle without being all of it. */
const heldTailLength = (needles: ReadonlyArray<Needle>, text: string) => {
  let longest = 0;
  for (const { text: needle } of needles) {
    const limit = Math.min(needle.length - 1, text.length);
    for (let length = limit; length > longest; length -= 1) {
      if (
        text.charCodeAt(text.length - length) === needle.charCodeAt(0) &&
        needle.startsWith(text.slice(text.length - length))
      ) {
        longest = length;
        break;
      }
    }
  }
  return longest;
};

const isPlainObject = (value: object): value is Record<string, unknown> => {
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
};

export const noSecretMask: SecretMask = {
  redact: (text) => text,
  redactGrowing: (text) => text,
  redactDeep: (value) => value,
  stream: () => ({ write: (chunk) => chunk, flush: () => "", holding: () => false }),
};

export const makeSecretMask = (entries: ReadonlyArray<SecretMaskEntry>): SecretMask => {
  const needles = needlesFor(entries);
  if (needles.length === 0) return noSecretMask;

  const redact = (text: string) => replaceAll(needles, text);

  const redactDeep = <A>(value: A): A => {
    if (typeof value === "string") return redact(value) as A;
    if (typeof value !== "object" || value === null) return value;
    if (Array.isArray(value)) {
      let changed = false;
      const next = value.map((item) => {
        const redacted = redactDeep(item);
        changed ||= redacted !== item;
        return redacted;
      });
      return (changed ? next : value) as A;
    }
    if (!isPlainObject(value)) return value;
    let changed = false;
    const next: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) {
      const redacted = redactDeep(item);
      changed ||= redacted !== item;
      next[key] = redacted;
    }
    return (changed ? next : value) as A;
  };

  return {
    redact,
    redactDeep,
    redactGrowing: (text) => {
      const masked = redact(text);
      return masked.slice(0, masked.length - heldTailLength(needles, masked));
    },
    stream: () => {
      let held = "";
      return {
        write: (chunk) => {
          const pending = redact(held + chunk);
          const hold = heldTailLength(needles, pending);
          held = pending.slice(pending.length - hold);
          return pending.slice(0, pending.length - hold);
        },
        flush: () => {
          const rest = held;
          held = "";
          return rest;
        },
        holding: () => held.length > 0,
      };
    },
  };
};
