import * as Schema from "effect/Schema";
import { GitPreparePullRequestThreadInput, GitRunStackedActionInput } from "./git.ts";
import { GitGraphActInput } from "./gitGraph.ts";
import {
  AuthAccessWriteScope,
  AuthFilesystemWriteScope,
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
  AuthPreviewOperateScope,
  AuthSettingsWriteScope,
  AuthSourceControlWriteScope,
  AuthTerminalOperateScope,
  type AuthEnvironmentScope,
} from "./auth.ts";
import { ORCHESTRATION_V2_WS_METHODS } from "./orchestrationV2.ts";
import { WS_METHODS } from "./rpc.ts";

/** Incremental client enforcement; the server still authorizes every request. */
export const CLIENT_GUARDED_RPC_SCOPES = {
  [WS_METHODS.teamworkStart]: AuthOrchestrationOperateScope,
  [WS_METHODS.teamworkAct]: AuthOrchestrationOperateScope,
  [WS_METHODS.teamworkStartMember]: AuthOrchestrationOperateScope,
  [WS_METHODS.previewClose]: AuthPreviewOperateScope,
  [WS_METHODS.workspacesUpsert]: AuthSettingsWriteScope,
  [WS_METHODS.workspacesDelete]: AuthSettingsWriteScope,
  [WS_METHODS.workspacesRestore]: AuthSettingsWriteScope,
  [WS_METHODS.workspacesPurge]: AuthSettingsWriteScope,
  [WS_METHODS.workspacesAttach]: AuthSettingsWriteScope,
  [WS_METHODS.workspacesSetSecret]: AuthSettingsWriteScope,
  [WS_METHODS.workspacesRemoveSecret]: AuthSettingsWriteScope,
  [WS_METHODS.conversationFoldersMutate]: AuthOrchestrationOperateScope,
  // Stopping a server signals its processes, as closing a terminal does.
  [WS_METHODS.previewStopLocalServer]: AuthTerminalOperateScope,
  [WS_METHODS.serverRunStorageCleanup]: AuthSettingsWriteScope,
  [WS_METHODS.serverCheckOtlpEndpoint]: AuthSettingsWriteScope,
  [WS_METHODS.pullRequestsRunAction]: AuthSourceControlWriteScope,
  [WS_METHODS.pullRequestsUpdate]: AuthSourceControlWriteScope,
  [WS_METHODS.pullRequestsComment]: AuthSourceControlWriteScope,
  [WS_METHODS.pullRequestsUpdateComment]: AuthSourceControlWriteScope,
  [WS_METHODS.pullRequestsSubmitReview]: AuthSourceControlWriteScope,
  [WS_METHODS.pullRequestsReplyToThread]: AuthSourceControlWriteScope,
  [WS_METHODS.pullRequestsSetThreadResolution]: AuthSourceControlWriteScope,
  [WS_METHODS.pullRequestsSetReaction]: AuthSourceControlWriteScope,
  [WS_METHODS.pullRequestsSetFilesViewed]: AuthSourceControlWriteScope,
  [WS_METHODS.pullRequestsRequestReviewers]: AuthSourceControlWriteScope,
  [WS_METHODS.pullRequestsSetLabels]: AuthSourceControlWriteScope,
  // Writing a guide runs a model on this environment's providers, which reading one does not.
  [WS_METHODS.pullRequestsGenerateReviewGuide]: AuthOrchestrationOperateScope,
  [WS_METHODS.projectsCreateFromThread]: AuthOrchestrationOperateScope,
  [WS_METHODS.sourceControlCloneRepository]: AuthSourceControlWriteScope,
  [WS_METHODS.sourceControlPublishRepository]: AuthSourceControlWriteScope,
  // Signing in replaces the server's GitHub credential, as saving a token in Settings does.
  [WS_METHODS.sourceControlSignInStart]: AuthSettingsWriteScope,
  [WS_METHODS.sourceControlSignInWait]: AuthSettingsWriteScope,
  [WS_METHODS.sourceControlSignInCancel]: AuthSettingsWriteScope,
  [WS_METHODS.projectCloneStart]: AuthSourceControlWriteScope,
  [WS_METHODS.projectCloneCancel]: AuthSourceControlWriteScope,
  [WS_METHODS.projectCloneRetry]: AuthSourceControlWriteScope,
  [WS_METHODS.vcsPull]: AuthSourceControlWriteScope,
  [WS_METHODS.gitRunStackedAction]: AuthSourceControlWriteScope,
  [WS_METHODS.gitPreparePullRequestThread]: AuthSourceControlWriteScope,
  [WS_METHODS.vcsCreateWorktree]: AuthSourceControlWriteScope,
  [WS_METHODS.vcsRemoveWorktree]: AuthSourceControlWriteScope,
  [WS_METHODS.vcsCreateRef]: AuthSourceControlWriteScope,
  [WS_METHODS.vcsSwitchRef]: AuthSourceControlWriteScope,
  [WS_METHODS.vcsInit]: AuthSourceControlWriteScope,
  [WS_METHODS.gitGraphAct]: AuthSourceControlWriteScope,
  // Drafting a message runs a model on this environment's providers.
  [WS_METHODS.gitGraphDraftMessage]: AuthOrchestrationOperateScope,

  // Starts an agent session on this environment that can read its logs and database.
  [WS_METHODS.serverPrepareTriage]: AuthOrchestrationOperateScope,
  // Input to a screen: a view-only guest holds none of these scopes.
  [WS_METHODS.computerUseStart]: AuthOrchestrationOperateScope,
  [WS_METHODS.computerUseStop]: AuthOrchestrationOperateScope,
  [WS_METHODS.computerUseTakeOver]: AuthOrchestrationOperateScope,
  [WS_METHODS.computerUseResume]: AuthOrchestrationOperateScope,
  [WS_METHODS.computerUseAnswerApproval]: AuthOrchestrationOperateScope,
  [WS_METHODS.documentsCreate]: AuthOrchestrationOperateScope,
  [WS_METHODS.documentsUpdate]: AuthOrchestrationOperateScope,
  [WS_METHODS.documentsDelete]: AuthOrchestrationOperateScope,
  [WS_METHODS.documentsRestore]: AuthOrchestrationOperateScope,
  [WS_METHODS.documentsRestoreVersion]: AuthOrchestrationOperateScope,
  // Writes a file on the host, as saving one in the file panel does.
  [WS_METHODS.documentsMoveToProject]: AuthFilesystemWriteScope,
  [WS_METHODS.scheduledTasksUpsert]: AuthOrchestrationOperateScope,
  [WS_METHODS.scheduledTasksSetEnabled]: AuthOrchestrationOperateScope,
  [WS_METHODS.scheduledTasksDelete]: AuthOrchestrationOperateScope,
  [WS_METHODS.scheduledTasksRunNow]: AuthOrchestrationOperateScope,
  [WS_METHODS.threadRewind]: AuthOrchestrationOperateScope,
  [WS_METHODS.threadRewindReopen]: AuthOrchestrationOperateScope,
  [WS_METHODS.nestedSessionStart]: AuthOrchestrationOperateScope,
  [WS_METHODS.nestedSessionReport]: AuthOrchestrationOperateScope,
  [WS_METHODS.nestedSessionCloseParent]: AuthOrchestrationOperateScope,
  // A background task is a shell command on this environment, as a terminal is.
  [WS_METHODS.backgroundTaskStart]: AuthTerminalOperateScope,
  [WS_METHODS.backgroundTaskStop]: AuthTerminalOperateScope,
  [WS_METHODS.backgroundTaskRemove]: AuthTerminalOperateScope,
  [WS_METHODS.scheduledTasksRotateWebhookToken]: AuthOrchestrationOperateScope,
  [ORCHESTRATION_V2_WS_METHODS.stopWorkflow]: AuthOrchestrationOperateScope,
  // Force stop kills agent processes, as Stop on a terminal does.
  [ORCHESTRATION_V2_WS_METHODS.forceStopThread]: AuthOrchestrationOperateScope,
  // A guest link hands thread access to someone outside, like a pairing link.
  [WS_METHODS.guestShareCreate]: AuthAccessWriteScope,
  // Grants decide what an agent may do unasked, so they follow access management.
  [WS_METHODS.orchestratorAgentSetGrants]: AuthAccessWriteScope,
  [WS_METHODS.orchestratorAgentSetBrain]: AuthOrchestrationOperateScope,
  [WS_METHODS.orchestratorAgentSetThresholds]: AuthOrchestrationOperateScope,
  [WS_METHODS.orchestratorAgentSend]: AuthOrchestrationOperateScope,
  [WS_METHODS.orchestratorAgentReact]: AuthOrchestrationOperateScope,
  [WS_METHODS.orchestratorAgentMarkRead]: AuthOrchestrationOperateScope,
  [WS_METHODS.supervisionSetThread]: AuthOrchestrationOperateScope,
  [WS_METHODS.orchestratorAgentInterrupt]: AuthOrchestrationOperateScope,
  // Answering is what lets the orchestrator act, so it is access management too.
  [WS_METHODS.orchestratorAgentAnswerApproval]: AuthAccessWriteScope,
  // Remote control does too, and its link and code are that access.
  [WS_METHODS.remoteControlEnable]: AuthAccessWriteScope,
  [WS_METHODS.remoteControlUpdate]: AuthAccessWriteScope,
  [WS_METHODS.remoteControlRotateLink]: AuthAccessWriteScope,
  [WS_METHODS.remoteControlRevealLink]: AuthAccessWriteScope,
  [WS_METHODS.remoteControlResolvePairing]: AuthAccessWriteScope,
  // Ending access is what a phone reaches for in a hurry, so it needs less than granting it.
  [WS_METHODS.remoteControlDisable]: AuthOrchestrationOperateScope,
  [WS_METHODS.remoteControlRevokeDevice]: AuthOrchestrationOperateScope,
  // A relay opens this machine to the internet, and its secret is that access.
  [WS_METHODS.remoteRelayConfigure]: AuthAccessWriteScope,
  [WS_METHODS.remoteRelayRemove]: AuthAccessWriteScope,
  [WS_METHODS.peerLinksLink]: AuthAccessWriteScope,
  [WS_METHODS.peerLinksUnlink]: AuthAccessWriteScope,
  // A link lets every agent here reach the other environment: Settings' bar.
  [WS_METHODS.peerLinksAnswerRequest]: AuthAccessWriteScope,
} as const;
export type ClientGuardedRpcTag = keyof typeof CLIENT_GUARDED_RPC_SCOPES;

const decodePrepareThread = Schema.decodeUnknownSync(GitPreparePullRequestThreadInput);
const decodeStackedAction = Schema.decodeUnknownSync(GitRunStackedActionInput);
const decodeGraphAction = Schema.decodeUnknownSync(GitGraphActInput);

export function clientRpcRequiredScopes(
  method: string,
  input: unknown,
): readonly AuthEnvironmentScope[] {
  if (method === WS_METHODS.gitPreparePullRequestThread && input !== undefined) {
    const payload = decodePrepareThread(input);
    if (payload.mode === "worktree" && payload.threadId !== undefined)
      return [AuthSourceControlWriteScope, AuthOrchestrationOperateScope];
  }
  if (method === WS_METHODS.gitRunStackedAction && input !== undefined) {
    const payload = decodeStackedAction(input);
    if (
      payload.threadId !== undefined &&
      (payload.action === "create_pr" || payload.action === "commit_push_pr")
    )
      return [AuthSourceControlWriteScope, AuthOrchestrationReadScope];
  }
  if (method === WS_METHODS.gitGraphAct && input !== undefined) {
    const payload = decodeGraphAction(input);
    if (payload.threadId !== undefined && payload.action.type === "createPullRequest")
      return [AuthSourceControlWriteScope, AuthOrchestrationReadScope];
  }
  return Object.hasOwn(CLIENT_GUARDED_RPC_SCOPES, method)
    ? [CLIENT_GUARDED_RPC_SCOPES[method as ClientGuardedRpcTag]]
    : [];
}
