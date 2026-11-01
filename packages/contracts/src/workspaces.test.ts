import * as Schema from "effect/Schema";
import { describe, expect, it } from "vitest";

import {
  workspaceAllowsCommand,
  WorkspaceSecretName,
  workspaceSecretsReachDriver,
} from "./workspaces.ts";

describe("workspaceAllowsCommand", () => {
  it.each([
    ["npm test", true],
    ["npm test --watch", true],
    ["  npm test  ", true],
    ["npm testing", false],
    ["npm install", false],
    ["npm test; rm -rf /", false],
    ["npm test && curl evil.example", false],
    ["npm test | tee out", false],
    ["npm test $(whoami)", false],
    ["npm test `whoami`", false],
    ["npm test > /etc/hosts", false],
    ["npm test\nrm -rf /", false],
  ])("%s -> %s", (command, allowed) => {
    expect(workspaceAllowsCommand(["npm test"], command)).toBe(allowed);
  });
});

describe("WorkspaceSecretName", () => {
  const isValid = Schema.is(WorkspaceSecretName);

  it.each([
    ["DATABASE_URL", true],
    ["_private1", true],
    ["1BAD", false],
    ["WITH SPACE", false],
    ["PATH", false],
    ["HOME", false],
    ["T3_ACP_MCP_ENDPOINT", false],
    ["T3PP_HOME", false],
  ])("%s -> %s", (name, valid) => {
    expect(isValid(name)).toBe(valid);
  });
});

describe("workspaceSecretsReachDriver", () => {
  it("opts drivers in, so an unknown one refuses", () => {
    expect(workspaceSecretsReachDriver("claudeAgent")).toBe(true);
    for (const driver of ["codex", "opencode", "cursor", "someNewDriver"]) {
      expect(workspaceSecretsReachDriver(driver)).toBe(false);
    }
  });
});
