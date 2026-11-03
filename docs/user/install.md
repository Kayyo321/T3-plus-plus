# Install T3++

T3++ runs coding agents on your computer and lets you control them from its
desktop, web, or mobile app. Set up the machine where the agents will work first.

## Requirements

You need an installed, authenticated provider before starting a thread. You can
launch T3++ and configure providers afterwards.

## Install

On macOS or Linux:

```bash
curl -fsSL https://raw.githubusercontent.com/Kayyo321/T3-plus-plus/main/install.sh | sh
```

On Windows, in Command Prompt or PowerShell:

```bash
powershell -c "irm https://raw.githubusercontent.com/Kayyo321/T3-plus-plus/main/install.bat | iex"
```

You can also download [`install.bat`](https://raw.githubusercontent.com/Kayyo321/T3-plus-plus/main/install.bat)
and double-click it.

This installs the desktop app (into Applications on macOS, your app menu on Linux, or the
Start menu on Windows) and the `t3pp` command in `~/.local/bin`. On a machine with no
display, or over SSH, it installs only `t3pp`; set `T3PP_DESKTOP=1` or `T3PP_DESKTOP=0` to
choose. If your shell reports `command not found`, add `~/.local/bin` to your `PATH`; the
Windows installer adds it for you. Set `T3PP_CHANNEL=nightly` to install the nightly train,
or `T3PP_VERSION` to pin an exact version.

Run the same command again to update both. To remove T3++, run it with `uninstall`. Your
projects, threads, and settings stay in `~/.t3pp`.

```bash
curl -fsSL https://raw.githubusercontent.com/Kayyo321/T3-plus-plus/main/install.sh | sh -s -- uninstall
```

```bash
powershell -c "& ([scriptblock]::Create((irm https://raw.githubusercontent.com/Kayyo321/T3-plus-plus/main/install.bat))) uninstall"
```

Everything comes from [GitHub Releases](https://github.com/Kayyo321/T3-plus-plus/releases),
and each download is checked against the release's `SHA256SUMS`. You can also download an
installer there yourself: `.dmg` for macOS, `.exe` for Windows, and `.AppImage` or `.deb` for
Linux (`sudo apt install ./T3PP-*.deb`).

| Task                                             | Command                                                                   |
| ------------------------------------------------ | ------------------------------------------------------------------------- |
| Start the server and open the web app            | `t3pp`                                                                    |
| Start the server without a browser               | `t3pp serve`                                                              |
| Use it from your other devices                   | `t3pp up` ([details](./remote-access.md))                                 |
| Keep it running in the background (macOS, Linux) | `t3pp service install` ([details](./background-service.md))               |
| Move to the newest release                       | `t3pp update`                                                             |
| Reclaim database space                           | `t3pp doctor` ([details](./background-service.md#reclaim-database-space)) |
| Remove only the `t3pp` command                   | `t3pp uninstall`                                                          |

Run `t3pp --help` for the full reference. To start in a new working directory, use an
explicit path such as `t3pp ./my-project`. A bare directory name is accepted only if it
already exists.

If `t3pp` reports an already running server, connect to that server instead. Stop it
before starting a replacement, or use a different `--base-dir` for an independent server.

The desktop app updates itself. Unsigned macOS builds cannot, so on a Mac, run the install
command again to update.

### Intel Macs

There is no `t3pp` executable for Intel Macs, so the installer installs only the desktop
app there. To run a headless server on an Intel Mac, build it from source with `vp`, which
provides the Node version it needs
([Install vp](https://github.com/Kayyo321/T3-plus-plus#install-vp)):

```bash
git clone https://github.com/Kayyo321/T3-plus-plus
cd T3-plus-plus && vp i && vp run build:desktop
node apps/server/dist/bin.mjs
```

`t3pp update` and the background service do not apply to a server run this way;
update it with `git pull` and a rebuild.

### The `t3pp` command in the desktop app

The desktop app includes the `t3pp` command-line tool too. To run it from any terminal,
open **Settings → About** and choose **Install** next to **t3pp command**. On macOS and
Linux it adds a `t3pp` link to a folder on your `PATH`; on Windows it adds the app's
command folder to your `PATH`. Open a new terminal afterwards. **Remove** takes it off
again. A `t3pp` you installed another way stays as it is.

### Windows Subsystem for Linux

Choose a WSL distro in **Settings → Sharing & access** to run agents and projects
there. Install the provider CLIs inside that distro. T3++ installs its own
server runtime there automatically; the first launch after an app update can
take longer.

### Open a project from a terminal

With the desktop app already running on the same machine:

```bash
t3pp app
```

This opens a new thread for the current directory, adding the project if needed.
Pass a path, such as `t3pp app ../my-project`, to open another directory. It requires
the desktop app, so a standalone server or an SSH session is not enough. If the
command cannot reach the app, start or update the desktop app and try again.

## Mobile app

T3++ has no app store listing of its own yet. To use it from a phone, open it in the
phone's browser through [remote access](./remote-access.md). The mobile app in
`apps/mobile` can be built from source.

If the app crashes during launch, open Settings → Diagnostics on the next launch
that succeeds. It lists startup crashes from the last 7 days with the error and
component stack that store crash reports leave out. Copy the report and paste it
into a GitHub issue. Error messages can quote values from the app, so read it over
before sharing.

## Providers

Open **Settings → Providers** in the web or desktop app, select the environment,
and enable the provider you want. Installation, login, and configuration belong
to that environment's machine, even when you connect from a phone or another
computer.

| Provider    | Install and authenticate                                                                                                                                  |
| ----------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Codex       | [Connect with ChatGPT](./providers-codex.md#connect-with-chatgpt), or install [Codex CLI](https://developers.openai.com/codex/cli) and run `codex login`. |
| Claude      | Install [Claude Code](https://claude.com/product/claude-code), then run `claude auth login`.                                                              |
| Cursor      | Install [Cursor CLI](https://cursor.com/cli), then run `agent login`.                                                                                     |
| Grok Build  | Install [Grok Build CLI](https://x.ai/cli), then run `grok login`.                                                                                        |
| OpenCode    | Install [OpenCode](https://opencode.ai), then run `opencode auth login`.                                                                                  |
| Antigravity | Install and sign in with Google from T3++'s provider settings.                                                                                            |
| Pi          | Install [Pi](./providers-pi.md#set-up-pi) with Node.js 22.19 or newer, then run `pi` and `/login`.                                                        |
| Muse Code   | Install [Muse Code](https://dev.meta.ai/docs/muse-code) on the server, run `muse login`, then enable it in Settings → Providers.                          |
| fx          | Install [fx](https://fx.sh) with `curl -fsSL https://fx.sh/setup.sh \| bash`, then run `fx login`.                                                        |

Provider CLIs must be on the server's `PATH`. If T3++ cannot find one, set its
**Binary path** in provider settings, especially when using a version manager.
Cursor's executable is `cursor-agent`, although its login command is
`agent login`. Codex connected through ChatGPT and Antigravity can use their
managed runtimes without a `PATH` entry.

T3++ warns when a provider version has known compatibility problems with your
release. Check **Settings → Providers** on that environment for the recommended
version or range. When its package manager supports installing a specific version,
you can install the recommendation there. Otherwise use the provider's installer
on the environment's machine. An unlisted version is unverified.

When a provider CLI is behind its latest release, its provider card shows the
available version. **Update now** runs the installer that owns the CLI
(Homebrew, or a global npm, pnpm, Yarn, Bun, Volta, or Vite+ install), or the
CLI's own update command when T3++ cannot tell. Update a CLI installed with
mise through mise. Cursor and Antigravity update with T3++. Homebrew and
Chocolatey installs compare against the version their package manager offers,
which can trail the npm release; update Claude installed with Chocolatey
through Chocolatey.

Add another provider instance for a separate account or configuration. Each
instance can have its own environment variables, such as API keys or a custom
base URL. Mark secret values as sensitive; after saving, T3++ does not display
their original values.

For provider-specific setup and accounts, see [Codex](./providers-codex.md),
[Claude](./providers-claude.md), [OpenCode](./providers-opencode.md),
[Antigravity](./providers-antigravity.md), [Pi](./providers-pi.md),
[Muse Code](./providers-muse.md), and [fx](./providers-fx.md).

## Next steps

- [Working with threads](./thread-sidebar.md): start tasks and organize parallel work.
- [Permission modes](./permission-modes.md): choose when agents ask before acting.
- [Remote access](./remote-access.md): connect from another device.
- [Running in the background](./background-service.md): keep a Linux or macOS host available.
- [Updating T3++](./updating.md): update the app and connected servers.
