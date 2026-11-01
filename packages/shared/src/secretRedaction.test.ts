import { describe, expect, it } from "@effect/vitest";

import { makeSecretMask, noSecretMask } from "./secretRedaction.ts";

const VALUE = "postgres://admin:hunter2-long@db.internal/app";
const mask = makeSecretMask([{ name: "DATABASE_URL", value: VALUE }]);

const run = (chunks: ReadonlyArray<string>) => {
  const stream = mask.stream();
  return chunks.map((chunk) => stream.write(chunk)).join("") + stream.flush();
};

describe("makeSecretMask", () => {
  it("masks a value split at every possible chunk boundary", () => {
    const text = `before ${VALUE} after`;
    for (let split = 0; split <= text.length; split += 1) {
      expect(run([text.slice(0, split), text.slice(split)])).toBe(
        "before [secret:DATABASE_URL] after",
      );
    }
  });

  it("masks a value delivered one character at a time", () => {
    expect(run([...`a${VALUE}${VALUE}b`])).toBe("a[secret:DATABASE_URL][secret:DATABASE_URL]b");
  });

  it("never emits any prefix of the value before it is complete", () => {
    const stream = mask.stream();
    const emitted = Array.from(VALUE.slice(0, -1), (char) => stream.write(char)).join("");
    expect(emitted).toBe("");
    expect(stream.holding()).toBe(true);
  });

  it("releases a held tail that turns out not to be the secret", () => {
    const stream = mask.stream();
    expect(stream.write("path is pos")).toBe("path is ");
    expect(stream.write("sible")).toBe("possible");
    expect(stream.holding()).toBe(false);
    expect(stream.flush()).toBe("");
  });

  it("does not mask values too short to mean anything", () => {
    const short = makeSecretMask([{ name: "FLAG", value: "true1" }]);
    expect(short).toBe(noSecretMask);
    expect(short.redact("true1 is true1")).toBe("true1 is true1");
  });

  it("catches common encodings and each line of a multi-line value", () => {
    const pem = makeSecretMask([{ name: "KEY", value: "first-line-secret\nsecond-line-secret" }]);
    expect(pem.redact("first-line-secret\r\nsecond-line-secret")).toBe(
      "[secret:KEY]\r\n[secret:KEY]",
    );
    expect(pem.redact(JSON.stringify({ key: "first-line-secret\nsecond-line-secret" }))).toBe(
      '{"key":"[secret:KEY]"}',
    );
    expect(mask.redact(Buffer.from(VALUE).toString("base64"))).toBe("[secret:DATABASE_URL]");
    expect(mask.redact(encodeURIComponent(VALUE))).toBe("[secret:DATABASE_URL]");
  });

  it("replaces the longest value when one secret contains another", () => {
    const nested = makeSecretMask([
      { name: "HOST", value: "db.internal" },
      { name: "URL", value: "https://db.internal/app" },
    ]);
    expect(nested.redact("https://db.internal/app and db.internal")).toBe(
      "[secret:URL] and [secret:HOST]",
    );
  });

  it("walks plain data, keeps other values, and returns the same object when nothing matched", () => {
    const date = new Date(0);
    const clean = { a: ["x"], when: date };
    expect(mask.redactDeep(clean)).toBe(clean);
    expect(mask.redactDeep({ a: [{ b: VALUE }], when: date, n: 1 })).toStrictEqual({
      a: [{ b: "[secret:DATABASE_URL]" }],
      when: date,
      n: 1,
    });
  });

  it("trims a growing text that could still become a secret", () => {
    expect(mask.redactGrowing(`token ${VALUE.slice(0, 20)}`)).toBe("token ");
    expect(mask.redactGrowing(`token ${VALUE} done`)).toBe("token [secret:DATABASE_URL] done");
  });
});
