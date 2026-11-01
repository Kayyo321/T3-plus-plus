import { type EnvironmentId, type VcsStatusResult, WS_METHODS } from "@t3tools/contracts";
import { AsyncResult, Atom } from "effect/reactivity";

import type { EnvironmentRegistry } from "../connection/registry.ts";
import type * as Persistence from "../platform/persistence.ts";
import { createEnvironmentRpcCommand, createEnvironmentRpcQueryAtomFamily } from "./runtime.ts";
import { invalidateCachedVcsRefs } from "./vcsRefInvalidation.ts";

const STATUS_SETTLE = "1500 millis";

/** What moving means the graph may have too. File edits alone are not worth a reload. */
const statusSignature = (status: VcsStatusResult | null) =>
  status === null
    ? null
    : `${status.refName}\0${status.aheadCount}\0${status.behindCount}\0${status.workingTree.files.length}`;

export function createGitGraphEnvironmentAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | Persistence.EnvironmentCacheStore | R, E>,
  status: (target: {
    readonly environmentId: EnvironmentId;
    readonly input: { readonly cwd: string };
  }) => Atom.Atom<AsyncResult.AsyncResult<VcsStatusResult | null, unknown>>,
) {
  const signalFamily = Atom.family((key: string) => {
    const [environmentId, cwd] = JSON.parse(key) as [EnvironmentId, string];
    return Atom.make((get) =>
      statusSignature(
        AsyncResult.getOrElse(get(status({ environmentId, input: { cwd } })), () => null),
      ),
    ).pipe(Atom.debounce(STATUS_SETTLE));
  });
  const statusSignal = (target: {
    readonly environmentId: EnvironmentId;
    readonly input: { readonly cwd: string };
  }) => signalFamily(JSON.stringify([target.environmentId, target.input.cwd]));

  return {
    /** The first page of a list. Later pages come from `listMore`. */
    page: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:git-graph:page",
      tag: WS_METHODS.gitGraphList,
      staleTimeMs: 5_000,
      refreshTrigger: statusSignal,
    }),
    listMore: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:git-graph:list-more",
      tag: WS_METHODS.gitGraphList,
    }),
    commitDetail: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:git-graph:commit",
      tag: WS_METHODS.gitGraphCommit,
    }),
    changes: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:git-graph:changes",
      tag: WS_METHODS.gitGraphChanges,
      staleTimeMs: 5_000,
      refreshTrigger: statusSignal,
    }),
    blame: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:git-graph:blame",
      tag: WS_METHODS.gitGraphBlame,
    }),
    preview: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:git-graph:preview",
      tag: WS_METHODS.gitGraphPreview,
    }),
    act: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:git-graph:act",
      tag: WS_METHODS.gitGraphAct,
      onSettled: (target, registry) =>
        invalidateCachedVcsRefs(registry, {
          environmentId: target.environmentId,
          cwd: target.input.cwd,
        }),
    }),
    draftMessage: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:git-graph:draft-message",
      tag: WS_METHODS.gitGraphDraftMessage,
    }),
  };
}
