import { describe, expect, it } from "vite-plus/test";

import { splitOrchestratorMessage } from "./orchestratorMessages.ts";

describe("splitOrchestratorMessage", () => {
  it.each([
    ["one line", "Done.", ["Done."]],
    ["break line splits", "First.\n---\nSecond.", ["First.", "Second."]],
    ["surrounding whitespace on a break", "First.\n   ---  \nSecond.", ["First.", "Second."]],
    ["empty bubbles are dropped", "---\nFirst.\n---\n\n---\nSecond.\n---", ["First.", "Second."]],
    ["bubbles are trimmed", "  First.  \n---\n  Second.\n", ["First.", "Second."]],
    ["four dashes is not a break", "First.\n----\nSecond.", ["First.\n----\nSecond."]],
    ["a dash inside a sentence is not a break", "a --- b\nc", ["a --- b\nc"]],
    [
      "a break inside a fence does not split",
      "Code:\n```\n---\n```\nAfter.",
      ["Code:\n```\n---\n```\nAfter."],
    ],
    ["a tilde fence holds a break too", "~~~\n---\n~~~\n---\nNext", ["~~~\n---\n~~~", "Next"]],
    ["a break after a fence splits", "```\nx\n```\n---\nNext", ["```\nx\n```", "Next"]],
    ["the silent reply sends nothing", "(silent)", []],
    ["the silent reply is trimmed first", "  (silent)\n", []],
    ["a silent reply inside a longer text is kept", "(silent) but more", ["(silent) but more"]],
    ["a streaming trailing dash is held back", "First.\n-", ["First."]],
    ["a streaming trailing double dash is held back", "First.\n--", ["First."]],
    ["a streaming trailing triple dash is held back", "First.\n---", ["First."]],
    ["a held back dash keeps the text before it", "First.\n---\nSecond.\n-", ["First.", "Second."]],
    ["a dash in the middle of text is not held back", "First.\n-\nSecond.", ["First.\n-\nSecond."]],
    ["a trailing dash inside an open fence is kept", "```\nx\n--", ["```\nx\n--"]],
  ])("%s", (_name, text, expected) => {
    expect(splitOrchestratorMessage(text)).toEqual(expected);
  });
});
