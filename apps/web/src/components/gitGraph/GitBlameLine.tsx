import type { EnvironmentId, GitGraphBlameResult } from "@t3tools/contracts";
import { useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";

import { useAtomCommand } from "~/state/use-atom-command";
import { gitGraphEnvironment } from "~/state/vcs";
import { buildThreadRouteParams } from "~/threadRoutes";

import { Button } from "../ui/button";
import { commandError } from "./useGitGraph";

/** From a diff line to the turn that wrote it. */
export function GitBlameLine(props: {
  readonly environmentId: EnvironmentId;
  readonly cwd: string;
  readonly path: string;
  readonly line: number;
}) {
  const { environmentId, cwd, path, line } = props;
  const blame = useAtomCommand(gitGraphEnvironment.blame, { reportFailure: false });
  const navigate = useNavigate();
  const [answer, setAnswer] = useState<GitGraphBlameResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  const conversation = answer?.conversation ?? null;
  if (error !== null) {
    return <p className="px-2 pb-1 text-2xs text-muted-foreground">{error}</p>;
  }
  if (answer === null) {
    return (
      <Button
        size="compact"
        variant="ghost-muted"
        onClick={async () => {
          const result = await blame({ environmentId, input: { cwd, path, line } });
          if (result._tag === "Failure") setError(commandError(result));
          else setAnswer(result.value);
        }}
      >
        Who wrote this line?
      </Button>
    );
  }
  if (answer.sha === null) {
    return <p className="px-2 pb-1 text-2xs text-muted-foreground">Not committed yet.</p>;
  }
  return (
    <p className="truncate px-2 pb-1 text-2xs text-muted-foreground">
      <span className="font-mono">{answer.sha.slice(0, 7)}</span> {answer.authorName}:{" "}
      {answer.subject}
      {conversation === null ? null : (
        <Button
          size="compact"
          variant="ghost"
          onClick={() =>
            void navigate({
              to: "/$environmentId/$threadId",
              params: buildThreadRouteParams(scopeThreadRef(environmentId, conversation.threadId)),
            })
          }
        >
          {conversation.turn === null ? "Open conversation" : `Turn ${conversation.turn}`}
        </Button>
      )}
    </p>
  );
}
