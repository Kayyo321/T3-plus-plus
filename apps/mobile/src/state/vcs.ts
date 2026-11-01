import { createGitGraphEnvironmentAtoms } from "@t3tools/client-runtime/state/git-graph";
import {
  createVcsActionManager,
  createVcsEnvironmentAtoms,
} from "@t3tools/client-runtime/state/vcs";

import { connectionAtomRuntime } from "../connection/runtime";

export const vcsEnvironment = createVcsEnvironmentAtoms(connectionAtomRuntime);
export const gitGraphEnvironment = createGitGraphEnvironmentAtoms(
  connectionAtomRuntime,
  vcsEnvironment.status,
);
export const vcsActionManager = createVcsActionManager(connectionAtomRuntime);
