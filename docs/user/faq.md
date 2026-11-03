# FAQ

## Is T3++ a harness?

No. A harness is what turns an LLM into an agent: it gives the model tools, a way to call them, runs them, and hands the results back. Claude Code is kind of a harness. It is an interface (the TUI, the Code tab in the desktop app) plus a harness underneath (the Anthropic Agent SDK). Codex is the same split: the app plus the Codex App Server. T3++ uses those harnesses. It is not a harness, and it does not work without one.

Chef = LLM. Kitchen = harness. T3++ = the restaurant that lets you bring whatever kitchen you want. Our MCP is a cookbook we hand the kitchen, but the chef won't open it unless you tell them to :) The longer version is here: [What is a harness?](https://t3.gg/blog/post/what-is-a-harness)

Bring your own: Claude Code, Codex, Cursor, Grok Build, OpenCode, Google Antigravity, Pi, or Muse Code. [Provider setup](./install.md#providers)

## Why use T3++ instead of Claude Code or the Codex app?

We were inspired by the Codex desktop app, Conductor, Claude Desktop, and Cursor Glass, but none met our bar. What you get:

- Bring your own sub. Claude, Codex, and whatever else you already have installed.
- Best in class remote. Run `npx t3pp up` on any box and drive it from anywhere.
- Best in class mobile app.
- Truly 100% open source. If we go the wrong direction, fork it.

Every harness feels nearly identical in here, so you can stop worrying about harnesses and focus on building :) [Install](./install.md)

## Can I use T3++ with my Claude Code subscription?

Yes.

## How much does T3++ cost?

Nothing. T3++ is free and open source (MIT). You bring your own sub and still pay your provider like you already do. Remote access uses your local network, Tailscale, or a [Private relay](../../infra/remote-relay/ONBOARDING.md) you run yourself. If you hit limits or have issues, you can always fork it, self host, or use Tailscale. [Install](./install.md)

## Why is my Claude 5-hour limit draining so fast?

T3++ drives Claude through Anthropic's Agent SDK. The T3 Code team reported to Anthropic that Agent SDK usage drains your 5h limits faster than using Claude Code directly. This does not affect weekly limits. [Details](https://x.com/theo/status/2114166439813017873)

## How do I use T3++ remotely?

Your agents run wherever T3++ runs: your desktop, a server, a VPS. You connect to it from anywhere. Run `npx t3pp up` on that machine and choose the local network or Tailscale. A [Private relay](../../infra/remote-relay/ONBOARDING.md) also works if you run one. [Remote access](./remote-access.md)

## How do I use T3++ on my phone?

T3++ has no app store listing yet. The App Store and Google Play apps are T3 Code's. To use T3++ from a phone, open it in the phone's browser through [remote access](./remote-access.md), or build the mobile app from source. The phone is a remote. Your computer does the work and needs to stay on. [Mobile app](./install.md#mobile-app)

## Why does my remote connection keep dropping?

Open **Settings > Environments**, find the machine, and check its routes. A second route, such as Tailscale, keeps the machine reachable when one drops. [Reach one machine several ways](./remote-access.md#reach-one-machine-several-ways)

## Will I get banned for using my subscription?

T3++ runs each provider through its own CLI or its official ACP bindings. The T3 Code team worked directly with [SpaceXAI](https://x.com/SpaceXSI/status/2070195830192320600) on the Grok Build and Cursor integrations. Check each provider's current terms for what your plan allows.

## Can I add a bunch of accounts for one provider?

T3++ is not the right place to manage a pile of accounts. An auto-switcher would risk TOS bans for users.

A separate work account is fine. Setup for two: [Codex](./providers-codex.md#use-multiple-accounts) · [Claude](./providers-claude.md#separate-accounts-or-configurations). For a bigger pool, manage them outside T3++ with a self-hosted proxy like [CLIProxyAPI](https://github.com/router-for-me/CLIProxyAPI). A [setup guide](https://gist.github.com/t3dotgg/59a521d2ee8d70aaf90e280c175072af) walks through a multi-account setup. Hand it to your agent and it will walk you through it. After you set up a hub, T3++ can show its pooled limits under Usage. [Connect a hub](./usage.md#connect-a-cliproxyapi-hub)

## Can I use an API key or OpenRouter instead of a subscription?

Yes. Add another provider instance in Settings and give it its own keys and endpoint. Claude has a full OpenRouter recipe. Your subscription setup stays untouched. [OpenRouter](./providers-claude.md#openrouter) · [Provider instances](./install.md#providers)

## Does T3++ support local models?

No. T3++ is a serious developer tool. Locally runnable models are not capable of meaningful engineering work.

## Does my code go to T3 Code's servers?

No. Your code and prompts go from your machine to your provider (Anthropic, OpenAI, etc.), not to T3 Code. T3++ does send basic product usage events (provider, model, token totals, that kind of thing) to T3 Code's endpoint at `ingest.t3.codes`. No prompts, no file contents. Over your local network or Tailscale, traffic goes directly between your devices and your machine. A Private relay you run carries traffic only when you use one. Set `T3PP_TELEMETRY_ENABLED=false` if you want usage events off. [Product usage data](./telemetry.md)

## Worktrees are eating my disk. How do I clean them up?

Open **Settings > Storage** and turn on automatic worktree cleanup. You can also run it now from there. Worktrees add up fast. One user cleared 500 GB. [Storage cleanup](./project-settings.md#storage-cleanup)

## Is there voice input?

On iPhone, yes. You need iOS 26 or later. Tap the mic in the composer, talk, check the text, then send. Web, desktop, and Android do not have it yet. [Voice input on iPhone](./composer.md#voice-input-on-iphone)

## Does it work on Windows, Mac, and Linux?

Yes, all three. Desktop app, CLI, the works. One catch: there is no `t3pp` command for Intel Macs, so use the desktop app there. Windows folks can also run agents inside WSL. [Install](./install.md)

## Why is my provider not showing up?

Almost always, the CLI is not installed or not on the `PATH` of the machine that runs the server. (Not your phone. The computer.) Log in on that machine first, like `codex login` or `claude auth login`. Still missing? Point **Binary path** at it in provider settings. Version managers love to cause this one. [Provider setup](./install.md#providers)
