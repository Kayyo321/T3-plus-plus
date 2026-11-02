import { ORCHESTRATOR_MESSAGE_BREAK, ORCHESTRATOR_SILENT_REPLY } from "@t3tools/contracts";

const FENCE_OPEN = /^ {0,3}(`{3,}|~{3,})/;
const PARTIAL_BREAK = /^\s*-{1,3}\s*$/;

/**
 * Splits the orchestrator's reply into message bubbles at `---` lines, never inside a fenced code
 * block. While streaming, trailing one-to-three-dash lines are held back: they may be the start
 * of a break.
 */
export function splitOrchestratorMessage(text: string): ReadonlyArray<string> {
  if (text.trim() === ORCHESTRATOR_SILENT_REPLY) return [];
  const lines = text.split("\n");
  const inFence: boolean[] = [];
  let fence: string | null = null;
  for (const line of lines) {
    const open = FENCE_OPEN.exec(line);
    if (fence === null) {
      inFence.push(open !== null);
      if (open !== null) fence = open[1]!;
      continue;
    }
    inFence.push(true);
    if (open !== null && open[1]![0] === fence[0] && line.trim() === open[1]) fence = null;
  }

  let end = lines.length;
  while (end > 0) {
    const line = lines[end - 1]!;
    if (line.trim() === "" || (!inFence[end - 1] && PARTIAL_BREAK.test(line))) {
      end -= 1;
      continue;
    }
    break;
  }

  const bubbles: string[] = [];
  let current: string[] = [];
  const flush = () => {
    const body = current.join("\n").trim();
    if (body !== "") bubbles.push(body);
    current = [];
  };
  for (let index = 0; index < end; index += 1) {
    if (!inFence[index] && lines[index]!.trim() === ORCHESTRATOR_MESSAGE_BREAK) {
      flush();
      continue;
    }
    current.push(lines[index]!);
  }
  flush();
  return bubbles;
}
