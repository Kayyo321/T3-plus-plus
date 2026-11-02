import {
  applyGitGraphPage,
  gitGraphArrivals,
  type GitGraphView,
  parseGitGraphQuery,
} from "@t3tools/client-runtime/git-graph";
import type {
  EnvironmentId,
  GitGraphAction,
  GitGraphActionResult,
  GitGraphListInput,
  GitGraphRow,
  ThreadId,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Option from "effect/Option";
import { useState } from "react";

import { useDebouncedValue } from "~/state/queries";
import { useEnvironmentQuery } from "~/state/query";
import { useAtomCommand } from "~/state/use-atom-command";
import { gitGraphEnvironment } from "~/state/vcs";

const PAGE_ROWS = 100;
const QUERY_SETTLE_MS = 250;

const NO_ARRIVALS: ReadonlySet<string> = new Set();

export function commandError(result: { readonly cause: Cause.Cause<unknown> }): string {
  const failure = Option.getOrNull(Cause.findErrorOption(result.cause));
  return failure instanceof Error ? failure.message : "The request failed.";
}

interface GitGraphFilterState {
  readonly query: string;
  readonly agentOnly: boolean;
  readonly thisConversation: boolean;
  readonly showCheckpoints: boolean;
}

/** One repository's graph: its first page as a live query, later pages, and the actions on it. */
export function useGitGraph(input: {
  readonly environmentId: EnvironmentId;
  readonly cwd: string;
  readonly threadId: ThreadId;
  readonly visible: boolean;
  readonly limit?: number;
}) {
  const { environmentId, cwd, threadId, visible, limit = PAGE_ROWS } = input;
  const listMore = useAtomCommand(gitGraphEnvironment.listMore, { reportFailure: false });
  const act = useAtomCommand(gitGraphEnvironment.act, { reportFailure: false });
  const preview = useAtomCommand(gitGraphEnvironment.preview, { reportFailure: false });

  const [filters, setFilters] = useState<GitGraphFilterState>({
    query: "",
    agentOnly: false,
    thisConversation: false,
    showCheckpoints: false,
  });
  const query = useDebouncedValue(filters.query, QUERY_SETTLE_MS);
  const listInput: GitGraphListInput = {
    cwd,
    limit,
    showCheckpoints: filters.showCheckpoints,
    checkpointThreadId: threadId,
    filter: {
      ...parseGitGraphQuery(query),
      ...(filters.agentOnly ? { agentOnly: true } : {}),
      ...(filters.thisConversation ? { threadId } : {}),
    },
  };
  const listKey = `${query}\0${filters.agentOnly}\0${filters.thisConversation}\0${filters.showCheckpoints}`;

  const page = useEnvironmentQuery(
    visible ? gitGraphEnvironment.page({ environmentId, input: listInput }) : null,
  );
  const firstPage = page.data;

  const [extended, setExtended] = useState<{
    readonly listKey: string;
    readonly revision: string;
    readonly view: GitGraphView;
  } | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [moreError, setMoreError] = useState<string | null>(null);
  const [motion, setMotion] = useState<{
    readonly arrivals: ReadonlySet<string>;
    readonly rewound: boolean;
  }>({ arrivals: NO_ARRIVALS, rewound: false });
  const [seen, setSeen] = useState<{
    readonly listKey: string;
    readonly rows: ReadonlyArray<GitGraphRow>;
  } | null>(null);

  if (firstPage !== null && seen?.rows !== firstPage.rows) {
    setSeen({ listKey, rows: firstPage.rows });
    if (seen?.listKey === listKey) {
      setMotion((current) => ({
        ...current,
        arrivals: gitGraphArrivals(seen.rows, firstPage.rows),
      }));
    }
  }

  const view: GitGraphView | null =
    firstPage === null
      ? null
      : extended?.listKey === listKey && extended.revision === firstPage.revision
        ? { ...extended.view, summary: firstPage.summary ?? extended.view.summary }
        : applyGitGraphPage(null, firstPage, false);

  const loadMore = async () => {
    const cursor = view?.nextCursor;
    if (!cursor || loadingMore || view === null) return;
    setLoadingMore(true);
    const result = await listMore({ environmentId, input: { ...listInput, cursor } });
    setLoadingMore(false);
    if (result._tag === "Failure") {
      setMoreError(commandError(result));
      return;
    }
    setMoreError(null);
    setExtended({
      listKey,
      revision: result.value.revision,
      view: applyGitGraphPage(view, result.value, true),
    });
  };

  const run = async (
    action: GitGraphAction,
  ): Promise<
    | { readonly ok: true; readonly result: GitGraphActionResult }
    | { readonly ok: false; readonly error: string }
  > => {
    const result = await act({ environmentId, input: { cwd, action, threadId } });
    if (result._tag === "Failure") return { ok: false, error: commandError(result) };
    setMotion({
      arrivals: NO_ARRIVALS,
      rewound: action.type === "rollback" || action.type === "recoveryRestore",
    });
    page.refresh();
    return { ok: true, result: result.value };
  };

  return {
    view,
    error: page.error ?? moreError,
    loading: page.isPending || loadingMore,
    filters,
    setFilters,
    loadMore,
    run,
    preview: (action: GitGraphAction) => preview({ environmentId, input: { cwd, action } }),
    arrivals: motion.arrivals,
    rewound: motion.rewound,
    clearMotion: () => setMotion({ arrivals: NO_ARRIVALS, rewound: false }),
  };
}
