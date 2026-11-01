import type {
  OrchestratorDomain,
  OrchestratorGrants,
  OrchestratorSupervisionAction,
  OrchestratorToolEffect,
} from "@t3tools/contracts";

export interface OrchestratorToolPolicy {
  readonly domain: OrchestratorDomain;
  readonly effect: OrchestratorToolEffect;
  readonly action?: OrchestratorSupervisionAction;
}

const tool = (
  domain: OrchestratorDomain,
  effect: OrchestratorToolEffect,
  action?: OrchestratorSupervisionAction,
): OrchestratorToolPolicy => ({ domain, effect, ...(action === undefined ? {} : { action }) });

/**
 * Every tool the orchestrator may call. A tool absent here is refused, so a new tool stays out of
 * its reach until someone decides what it is. `request_secret` is absent on purpose.
 */
export const ORCHESTRATOR_TOOL_POLICY: Readonly<Record<string, OrchestratorToolPolicy>> = {
  orchestrator_capabilities: tool("conversations", "read"),
  create_threads: tool("conversations", "write"),
  html_preview: tool("conversations", "read"),
  t3_attachment_discard: tool("conversations", "write"),
  t3_attachment_prepare_upload: tool("conversations", "write"),
  t3_background_wait: tool("conversations", "read"),
  t3_pending_request: tool("supervision", "write", "answer"),
  t3_queue: tool("conversations", "write"),
  t3_thread_configure: tool("conversations", "write"),
  t3_thread_interrupt: tool("conversations", "write", "interrupt"),
  t3_thread_launch: tool("conversations", "write"),
  t3_thread_list: tool("conversations", "read"),
  t3_thread_organize: tool("conversations", "write"),
  t3_thread_read: tool("conversations", "read"),
  t3_thread_search: tool("conversations", "read"),
  t3_thread_send: tool("conversations", "write", "message"),
  t3_thread_send_attachments: tool("conversations", "write", "message"),
  t3_thread_transfer: tool("conversations", "external"),
  t3_thread_update: tool("conversations", "write"),
  t3_thread_wait: tool("conversations", "read"),

  delegate_task: tool("sessions", "write"),
  task_cancel: tool("sessions", "write", "stop"),
  task_status: tool("sessions", "read"),
  t3_workflow_stop: tool("sessions", "write", "stop"),

  t3_project_clone: tool("projects", "write"),
  t3_project_create: tool("projects", "write"),
  t3_project_delete: tool("projects", "destructive"),
  t3_project_list: tool("projects", "read"),
  t3_project_read: tool("projects", "read"),
  t3_project_update: tool("projects", "write"),
  t3_environment_link: tool("projects", "external"),
  t3_environment_links: tool("projects", "read"),
  t3_environment_read: tool("projects", "read"),
  t3_environment_unlink: tool("projects", "destructive"),

  t3_environment_preferences_update: tool("settings", "write"),

  t3_worktree_handoff: tool("git", "write"),
  t3_worktree_list: tool("git", "read"),
  t3_worktree_status: tool("git", "read"),
  link_pull_request: tool("git", "write"),
  link_pull_requests: tool("git", "write"),
  list_thread_pull_requests: tool("git", "read"),
  read_pull_request_guide: tool("git", "read"),
  unlink_pull_request: tool("git", "write"),
  unlink_pull_requests: tool("git", "write"),
  unwatch_pull_request: tool("git", "write"),
  watch_pull_request: tool("git", "write"),
  write_pull_request_guides: tool("git", "write"),

  editor_ui: tool("workspace-ui", "write"),
  supervision_decide: tool("supervision", "write"),
  supervision_status: tool("supervision", "read"),
  supervision_watch: tool("supervision", "write"),

  delete_scheduled_task: tool("tasks", "destructive"),
  list_scheduled_tasks: tool("tasks", "read"),
  run_scheduled_task_now: tool("tasks", "write"),
  schedule_task: tool("tasks", "write"),
};

export type GrantDecision = "run" | "ask" | "deny";

const strictest = (left: GrantDecision, right: GrantDecision): GrantDecision =>
  left === "deny" || right === "deny" ? "deny" : left === "ask" ? "ask" : right;

const levelDecision = (level: "off" | "ask" | "allow"): GrantDecision =>
  level === "off" ? "deny" : level === "ask" ? "ask" : "run";

export const grantDecision = (
  grants: OrchestratorGrants,
  policy: OrchestratorToolPolicy,
): GrantDecision => {
  const domain = grants.domains[policy.domain];
  if (domain === "off") return "deny";
  if (policy.effect === "read") return "run";
  const changes = levelDecision(domain);
  const guarded =
    (policy.effect === "external" && grants.askBeforeExternal) ||
    (policy.effect === "destructive" && grants.askBeforeDestructive)
      ? "ask"
      : changes;
  return policy.action === undefined
    ? guarded
    : strictest(guarded, levelDecision(grants.supervisionActions[policy.action]));
};
