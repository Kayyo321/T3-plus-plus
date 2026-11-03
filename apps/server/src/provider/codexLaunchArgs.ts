import { tokenizeCliArgs } from "@t3tools/shared/cliArgs";

const T3PP_CODEX_LAUNCH_ARGS_ENV = "T3PP_CODEX_LAUNCH_ARGS";

// Codex Desktop's browser and computer plugins drive that app's own host, so under T3 they only
// fail ("The browser access host is unavailable") and crowd out T3's browser and computer tools.
// Launch args come after these, so a user can still turn one back on.
const CODEX_DESKTOP_PLUGIN_OVERRIDES = [
  "browser@openai-bundled",
  "chrome@openai-bundled",
  "unified-computer-use@openai-bundled",
].flatMap((plugin) => ["-c", `plugins.${plugin}.enabled=false`]);

export const resolveCodexLaunchArgs = (
  launchArgs?: string,
  environment: NodeJS.ProcessEnv = process.env,
) => environment[T3PP_CODEX_LAUNCH_ARGS_ENV]?.trim() || launchArgs?.trim() || "";

const codexLaunchArgv = (launchArgs?: string): ReadonlyArray<string> => tokenizeCliArgs(launchArgs);

export const codexAppServerArgs = (launchArgs?: string) => [
  "app-server",
  ...CODEX_DESKTOP_PLUGIN_OVERRIDES,
  ...codexLaunchArgv(launchArgs),
];

export const codexExecLaunchArgs = (launchArgs?: string) => {
  const args = codexLaunchArgv(launchArgs);
  const execArgs: Array<string> = [];

  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg === undefined) continue;

    if (arg === "--strict-config" || arg.startsWith("--config=") || arg.startsWith("-c=")) {
      execArgs.push(arg);
    } else if (arg === "--config" || arg === "-c" || arg === "--enable" || arg === "--disable") {
      const value = args[index + 1];
      if (value !== undefined && !value.startsWith("-")) {
        execArgs.push(arg, value);
        index++;
      }
    } else if (arg.startsWith("--enable=") || arg.startsWith("--disable=")) {
      execArgs.push(arg);
    }
  }

  return execArgs;
};
