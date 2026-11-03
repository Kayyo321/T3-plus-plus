<p align="center">
  <img src="./assets/brand/t3pp-art.webp" alt="T3++" width="640" />
</p>

# T3++

T3++ is an "agent harness control surface". It controls the coding agents on your machine from a desktop app, a web app, or any browser on your other devices.

Works with your subscriptions on Claude Code, Codex, Cursor, Grok Build, OpenCode, Google Antigravity, and fx. If they're set up on your computer, T3++ can control them.

T3++ is built on [T3 Code](https://github.com/pingdotgg/t3code) by the T3 team, and wouldn't exist without their work.

## "Wait, what are you selling me?"

Nothing. T3++ exists because we wanted the best possible development experience with agents: performant, remote-ready, and truly open. If we ever go the wrong direction, you have everything you need to fork it and build the editor you want.

## Installation

> [!WARNING]
> T3++ currently supports Codex, Claude, Cursor, Grok Build, OpenCode, Antigravity, and fx. Install and authenticate at least one provider before use:
>
> - Codex: install [Codex CLI](https://developers.openai.com/codex/cli) and run `codex login`
> - Claude: install [Claude Code](https://claude.com/product/claude-code) and run `claude auth login`
> - Cursor: install [Cursor CLI](https://cursor.com/cli) and run `agent login`
> - Grok Build: install [Grok Build CLI](https://x.ai/cli) and run `grok login`
> - OpenCode: install [OpenCode](https://opencode.ai) and run `opencode auth login`
> - Antigravity: enable it in Settings, then use **Install Antigravity** and **Sign in with Google**. No CLI is required.
> - fx: install [fx](https://fx.sh) and run `fx login` on the machine running the T3++ server ([setup guide](./docs/user/providers-fx.md))

Paste one line. It installs the desktop app and the `t3pp` command from the latest [GitHub Release](https://github.com/Kayyo321/T3-plus-plus/releases), and checks every download against the release's checksums.

**macOS and Linux**

```bash
curl -fsSL https://raw.githubusercontent.com/Kayyo321/T3-plus-plus/main/install.sh | sh
```

**Windows** (Command Prompt or PowerShell), or download [`install.bat`](https://raw.githubusercontent.com/Kayyo321/T3-plus-plus/main/install.bat) and double-click it:

```bash
powershell -c "irm https://raw.githubusercontent.com/Kayyo321/T3-plus-plus/main/install.bat | iex"
```

On a machine without a display, or over SSH, it installs only `t3pp`, the headless server. Run `t3pp` to start it and open the web app, or `t3pp up` to use it from your other devices.

**Update:** run the same line again. The desktop app also updates itself, and `t3pp update` updates the command.

**Uninstall:** add `uninstall`. Your projects, threads, and settings are kept.

```bash
curl -fsSL https://raw.githubusercontent.com/Kayyo321/T3-plus-plus/main/install.sh | sh -s -- uninstall
```

```bash
powershell -c "& ([scriptblock]::Create((irm https://raw.githubusercontent.com/Kayyo321/T3-plus-plus/main/install.bat))) uninstall"
```

[Install and first run](./docs/user/install.md) covers the options, manual downloads, and Intel Macs.

## Some notes

We are very very early in this project. Expect bugs.

We are (mostly) not accepting contributions yet. Small fixes may be considered. Big features will not be.

## Documentation

Full docs live in [docs/](./docs). There's no docs site yet.

- [FAQ](./docs/user/faq.md)
- [Install and first run](./docs/user/install.md)
- [Permission modes](./docs/user/permission-modes.md)
- [Keyboard shortcuts](./docs/user/keybindings.md)
- [Project settings](./docs/user/project-settings.md)
- [Workspaces](./docs/user/workspaces.md)
- [Conversation folders](./docs/user/conversation-folders.md)
- [Appearance preferences](./docs/user/appearance.md)
- [Remote access from a phone or another machine](./docs/user/remote-access.md)
- [Connect Claude Code, Codex, ChatGPT and other agents over MCP](./docs/user/outside-agents.md)
- [Keeping app and server in sync](./docs/user/updating.md)
- [Source control integrations](./docs/user/source-control.md)
- Multiple accounts: [Codex](./docs/user/providers-codex.md) · [Claude](./docs/user/providers-claude.md)
- [Run T3++ as a background service](./docs/user/background-service.md)

Building from source? Start at [docs/internals/overview.md](./docs/internals/overview.md). Cutting a release? See [docs/operations/release.md](./docs/operations/release.md).

## If you REALLY want to contribute still.... read this first

### Install `vp`

T3++ uses Vite+ so you'll need to install the global `vp` command-line tool.

#### macOS / Linux

```bash
curl -fsSL https://vite.plus | bash
```

#### Windows

```bash
irm https://vite.plus/ps1 | iex
```

Checkout their getting started guide for more information: https://viteplus.dev/guide/

### Install dependencies

```bash
vp i
```

Read [CONTRIBUTING.md](./CONTRIBUTING.md) before reporting a bug or opening a PR.

## Credits

T3++ is a fork of [T3 Code](https://github.com/pingdotgg/t3code), made by Theo, Julius, and the T3 team and released under the MIT license. If T3++ is useful to you, star [T3++](https://github.com/Kayyo321/T3-plus-plus) and [T3 Code](https://github.com/pingdotgg/t3code) too.
