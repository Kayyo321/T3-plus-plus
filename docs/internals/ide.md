# IDE mode

> For maintainers. Using T3++? See [IDE mode](../user/ide.md).

## Why VSCodium's web server

The editor is VS Code, not a lookalike, so extensions work. Each environment runs one VSCodium
REH-web process ([`IdeService.ts`](../../apps/server/src/ide/IdeService.ts)), downloaded on first
use at a pinned version and checksum. OpenVSCode Server ships Linux only, and Microsoft's
`code serve-web` is licensed for Microsoft's products; VSCodium publishes every desktop platform T3++
supports and points its gallery at Open VSX. The editor runs where the folder and the agents are, so
it follows the environment over LAN, Tailscale, and the relay like everything else.

## The path is the capability

The editor process listens on loopback with VSCodium's connection token, which only the T3 server
knows. Clients reach it through [`IdeProxy.ts`](../../apps/server/src/ide/IdeProxy.ts) under
`/ide/<secret>/`, and only `ide.open`, which requires terminal scope, hands out that path.

Cookies cannot authenticate here. Desktop serves its UI from `t3code://app`, so the editor frame is
cross-site, and VSCodium's `SameSite=Lax` token cookie never reaches it. The proxy therefore adds the
token to every upstream request, and rewrites the workbench page to carry the token in its
configuration, which the workbench reads before its cookie. Responses send `no-referrer` so the path
does not leak to sites the editor links to.

## Two kinds of settings

VS Code for the web keeps user settings in the browser. The server can set two things:

- Machine settings (`<state>/ide/data/Machine/settings.json`) outrank the user's and are watched, so
  the theme lives there and an open editor repaints in place.
- Application-scoped settings, such as workspace trust, are ignored in machine settings. T3's
  defaults go into the workbench configuration as `configurationDefaults` instead, which keeps them
  overridable.

## Theme bridge

[`vscodeTheme.ts`](../../apps/web/src/ide/vscodeTheme.ts) reads the live theme and maps it onto VS
Code's color keys, with pierre's token colors so syntax matches diffs. Tailwind's `@theme inline`
emits no `--color-*` variables, so the bridge reads the variables behind them, and reads sidebar
tokens inside a `[data-app-sidebar]` scope because the sidebar re-scopes them.

## Margin extension

The editor marks what the open thread's agent changed in its latest turn, badges those files, and
offers Accept and Revert per hunk. A small extension does this from inside the editor
([`marginExtension.ts`](../../apps/server/src/ide/marginExtension.ts)); the data comes from
[`IdeAgentChanges.ts`](../../apps/server/src/ide/IdeAgentChanges.ts).

- **Built in, not installed.** VSCodium prunes extensions it did not install itself, so the service
  writes the extension into the install's own `extensions/` folder before each start.
- **Loopback, behind the path.** The extension runs in the editor's extension host, which holds no
  T3 session and cannot reach the client's WebSocket. It calls `/ide/<secret>/.t3pp/` on the server
  over loopback (`T3PP_IDE_ENDPOINT`). The secret is the same capability that opens the editor, and
  only `ide.open`, under terminal scope, hands it out. The feed is only for the thread `ide.open`
  last bound to that folder; the extension cannot ask for another. The feed request long-polls on
  the thread's run and checkpoint events.
- **Hunks come from the checkpoint diff.** The feed is the turn diff from `CheckpointDiffQuery`,
  with whitespace kept so hunks apply byte for byte. Each hunk is located in the file as it is now,
  so a hunk the user edited or reverted drops out. Revert and its undo apply one hunk through the
  checkpoint store's `applyPatch`, renumbered to where it sits now: Git pins a hunk that starts at
  line 1 to the file's start.
- **Accept stays in the editor.** The change is already on disk, so accepting only hides its marks,
  per editor window. `Show Accepted Agent Changes Again` brings them back.

## Memory

Every editor window runs an extension host and its language servers; TypeScript alone can take
gigabytes in a large repository. VSCodium keeps a disconnected window's processes for three hours by
default, so every reload of T3 would strand a set. The service lowers that grace to five minutes.
Switching to Chat keeps the frame mounted, so it never reconnects.
