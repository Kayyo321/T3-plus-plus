# Releasing T3++

> For maintainers. Using T3++? See [docs/user](../user/).

## Ship a release

Push a tag from the commit to ship:

```bash
git tag v1.2.3 && git push origin v1.2.3
```

`.github/workflows/release.yml` builds that commit, runs lint, typecheck, and tests beside the
builds, and publishes one GitHub Release when everything passes. Main is protected, so tag a
commit that already landed through a pull request. A plain `X.Y.Z` tag becomes the repository's
latest release; a suffix such as `1.2.3-rc.1` publishes a prerelease.

The workflow can also be dispatched by hand:

- `channel=nightly` publishes `vX.Y.Z-nightly.YYYYMMDD.<run>` from `main`, a prerelease on its own
  updater channel. Nothing schedules nightlies; adding back the commented `schedule` trigger turns
  on the old every-30-minutes check (six hours and new commits between nightlies).
- `channel=stable` rebuilds the commit of the latest published nightly under its version, so stable
  only ships a build nightly users already ran. Without a nightly, push a tag instead.
- `channel=preview` (the default) is a maintainer test train for any branch. It carries no update
  feed, no updater manifests, and a warning instead of release notes, so no install is ever offered
  it. Installers and `t3pp update` reach it only when asked for `preview` by name.

There is no dry run: every accepted tag or dispatch publishes. Use CI or `preview` to test changes.

## What a release contains

- Desktop installers, one job per target (`release-desktop.yml`), all named `T3PP-<version>-<arch>`:
  macOS arm64 and x64 `.dmg` plus `.zip` (the update payload), Linux x64 and arm64 `.AppImage` and
  `.deb`, Windows x64 and arm64 NSIS `.exe`. Windows builds on Linux and runs its native checks on a
  Windows runner of its own architecture, and embeds the same-arch Linux CLI archive as its WSL
  runtime.
- Self-contained CLI archives, `t3pp-<version>-<platform>-<arch>.tar.gz` (`.zip` on Windows), for
  macOS arm64, Linux x64 and arm64, and Windows x64 and arm64. There is none for Intel Macs: Node
  single-executables segfault there. The archive is the only runtime T3++ manages: `t3pp update`,
  the boot service, SSH environments, and the installers all download it.
- `SHA256SUMS` over the CLI archives and the desktop installers. The installers check every
  download against it, so it is written from the exact bytes being uploaded.
- electron-updater metadata (`latest*.yml` or `nightly*.yml`, and blockmaps). The workflow merges
  the per-arch macOS and Windows manifests into one per platform. The update feed is the repository
  the build ran in (`GITHUB_REPOSITORY`, or `T3PP_DESKTOP_UPDATE_REPOSITORY`).

The macOS arm64 DMG and Linux x64 AppImage are opened against an old seeded database
(`scripts/fixtures/desktop-launch`) before anything publishes, so a build whose server cannot
migrate and start fails the release. Do not regenerate that fixture on schema changes.

Release notes come from `scripts/generate-release-notes.ts` when `OPENAI_API_KEY` is set, and from
GitHub's generated notes otherwise. Each channel compares against its own previous tag.

## Installers

The one-line installers are `install.sh` and `install.bat` at the repository root, served straight
from `main` on raw.githubusercontent.com rather than from t3.codes. They read this repository's
releases, so a change to them reaches users as soon as it merges, independent of any release.

## Unsigned builds

Signing is optional and detected per platform from secrets. Without it:

- macOS apps carry no Developer ID signature. They run when installed by the installer or with
  `curl`, which sets no quarantine flag, but a browser download is blocked by Gatekeeper. macOS
  in-app updates also need a signed app (Squirrel.Mac checks the signature), so unsigned macOS
  installs update by rerunning the installer. The CLI archive is signed ad hoc.
- Windows installers trigger SmartScreen when downloaded in a browser. In-app updates still work.
- Linux is unaffected.

## Optional integrations

Every GitHub asset ships without these. Each extra turns on when its secrets or variables exist:

| Extra                                       | Turned on by                                                                                                                                            |
| ------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| macOS signing and notarization              | `CSC_LINK`, `CSC_KEY_PASSWORD`, `APPLE_API_KEY`, `APPLE_API_KEY_ID`, `APPLE_API_ISSUER`, `MACOS_PROVISIONING_PROFILE` secrets, `APPLE_TEAM_ID` variable |
| Windows signing                             | the seven `AZURE_*` secrets in [Azure Trusted Signing](#3-azure-trusted-signing-setup-windows)                                                          |
| T3 Connect in release builds                | `RELAY_DOMAIN` (or `RELAY_API_ZONE_NAME`), `CLERK_PUBLISHABLE_KEY`, `CLERK_JWT_TEMPLATE`, `CLERK_CLI_OAUTH_CLIENT_ID` variables; all or none            |
| Relay client tracing                        | `CLOUDFLARE_API_TOKEN` secret and `CLOUDFLARE_ACCOUNT_ID` variable for the deployed relay stack                                                         |
| npm launcher (`npx t3pp`)                   | `T3PP_NPM_PUBLISH=true` variable, once the `t3pp` package has a trusted publisher for this workflow                                                     |
| AUR packages `t3pp-bin`, `t3pp-nightly-bin` | `AUR_SSH_PRIVATE_KEY` secret ([packaging/aur](../../packaging/aur/README.md))                                                                           |
| Hosted web app and marketing site           | `VERCEL_TOKEN`, `VERCEL_ORG_ID`, `VERCEL_PROJECT_ID` secrets                                                                                            |
| Discord announcements                       | `DISCORD_RELEASE_WEBHOOK_URL` secret                                                                                                                    |
| Version bump commit on `main`               | `RELEASE_APP_ID`, `RELEASE_APP_PRIVATE_KEY` secrets; the app must be a bypass actor on the `main` ruleset                                               |
| Release notes summary                       | `OPENAI_API_KEY` secret                                                                                                                                 |

Without T3 Connect variables the builds ship with T3 Connect off. Without the release app, package
versions on `main` stay where they are; the release workflow stamps the tag's version into every
build regardless, so bump them in a pull request when you want `main` to match.

The mobile store, Android APK mirror, and T3 Connect relay deployment workflows stay tied to the
upstream repository (`pingdotgg/t3code`) and never run here; they publish under T3 Tools' accounts.

## Pull request macOS previews

Labeling a PR `preview:mac` publishes a signed, notarized Apple Silicon DMG with T3 Connect enabled
to the rolling `desktop-preview` prerelease, and works for fork PRs. The label is a one-shot request
for the commit it is applied to: the trusted workflow removes it once the build is in hand, and later
pushes do not build until a maintainer applies it again. Every signed preview is therefore a
per-commit maintainer decision, which matters because the result carries the Developer ID signature.
Vouching a contributor lets their labeled commits be signed; it is not a standing grant. The build is
split so the Developer ID certificate never shares a job with PR code:

- `.github/workflows/desktop-macos-preview.yml` runs on `pull_request` with no secrets and builds
  only the JS bundle from the PR (the same `js-bundle` artifact `release.yml` produces).
- `.github/workflows/desktop-macos-preview-publish.yml` runs on `workflow_run` from `main`. It
  refuses unless the PR is open, still labeled, its head is the built commit, and the author is a
  bot, a collaborator, or listed in `.github/VOUCHED.td` (read from the default branch, so a PR cannot vouch
  for itself). It then packages and signs the bundle through `release-desktop.yml` checked out at
  `main`, so packaging, native helpers, and the Electron/desktop dependencies come from `main`, not
  the PR. Only the version and the public T3 Connect identifiers in `.env.example` are read from the
  PR commit, as data, so the signed app's passkey entitlement matches the bundle. A PR that changes
  packaging must use the `channel=preview` release train above instead.

Before handing the bundle to the signing runner, the trusted workflow validates its ZIP entries
and accepts only regular files under `server/dist` and `desktop/dist-electron`, plus the directory
entries that lead to those roots. The artifact cannot
overwrite packaging code or installed dependencies. The bundle is copied into the app, never executed,
on the signing runner. The
`pull_request_target` cleanup job in the publish workflow removes the download when the PR closes, or
when the label is removed by hand before a build consumed it, and never checks out PR code.

## T3 Connect relay deployment

T3 Tools operates the production relay. `deploy-relay.yml` runs only in the upstream repository,
so this section matters here only if you deploy a relay of your own.

The relay is a shared control plane versioned separately from client releases. Stable and nightly
client builds must point at the same relay so users see the same linked environments when switching
release channels.

`.github/workflows/deploy-relay.yml` deploys Alchemy stage `prod` on every push to `main`. The
release workflow reads the relay URL and Clerk client configuration from the existing `production`
GitHub Actions environment before building desktop, CLI, or hosted web artifacts.

Required repository variables shared by relay deployments:

- `CLOUDFLARE_ACCOUNT_ID`
- `PLANETSCALE_ORGANIZATION`
- `AXIOM_ORG_ID`

Required repository secrets shared by relay deployments:

- `CLOUDFLARE_API_TOKEN`
- `PLANETSCALE_API_TOKEN_ID`
- `PLANETSCALE_API_TOKEN`
- `AXIOM_TOKEN`

Required `production` environment variables:

- `RELAY_API_ZONE_NAME`
- `RELAY_TUNNEL_ZONE_NAME`
- `CLERK_PUBLISHABLE_KEY`
- `CLERK_JWT_AUDIENCE`
- `CLERK_JWT_TEMPLATE`
- `CLERK_CLI_OAUTH_CLIENT_ID`
- `APNS_ENVIRONMENT`
- `APNS_TEAM_ID`
- `APNS_KEY_ID`
- `APNS_BUNDLE_ID`

Optional `production` environment variables:

- `RELAY_DOMAIN` when overriding the derived `relay.<RELAY_API_ZONE_NAME>` domain
- `RELAY_TUNNEL_CLEANUP_MODE` with `off`, `dry-run`, or `enabled`. Missing and blank values use
  `off`.
- `RELAY_LEGACY_TUNNEL_CLEANUP_MODE` with the same values, for tunnels whose host never registered
  recovery. Missing and blank values use `off`.

Required `production` environment secrets:

- `CLERK_SECRET_KEY`
- `APNS_PRIVATE_KEY`

Optional `production` environment secrets:

- `T3CHAT_LINK_SECRET` for the T3 Chat account link. It must match
  `T3PP_LINK_SECRET` on T3 Chat.

After changing a variable or secret, run the **Deploy T3 Connect relay** workflow manually from
`main` with **force** unchecked. Alchemy compares the values the Worker reads and redeploys it when
one changed. Check **force** only to redeploy resources with no detected change.

The account-scoped repository credentials are consumed by Alchemy while provisioning relay stages; they
are not bound into the relay Worker. The production deployment uses an Axiom personal access token,
so `AXIOM_ORG_ID` must accompany `AXIOM_TOKEN`. The `prod` stage owns the retained PlanetScale
database. Local personal stages provision isolated branches from it and are never deployed by CI.
Production adopts the configured relay API and tunnel DNS zones as retained Cloudflare resources.
Personal stages reference the production-owned zones.

Developers deploy personal stages locally:

```sh
vp run --filter t3code-relay deploy -- --stage "$USER" --env-file .env.local
```

A same-repository PR labeled `relay:preview` deploys stage `pr-<number>` through
`.github/workflows/relay-preview.yml`, after approval in the `relay-preview` environment. Removing the
label or closing the PR runs `.github/workflows/relay-preview-cleanup.yml`, which destroys the stage
and sweeps its managed tunnels and DNS records. A nightly run destroys stages of closed labeled PRs
whose teardown failed. Fork PRs get no preview.

### Managed tunnel cleanup rollout

Keep `RELAY_TUNNEL_CLEANUP_MODE=off` for the first production deploy. That deploy applies the
nullable allocation migration and adds the recovery endpoints. Web and mobile clients need no
coordinated release. CLI and desktop server builds must reach users before cleanup is enabled,
because those builds register recovery and replace a deleted tunnel after wake.

1. Deploy the relay and migration with cleanup `off`.
2. Release the server build and confirm current hosts register recovery. Older hosts stay marked
   legacy and are only candidates under the legacy switch below.
3. Set `dry-run`, run a relay deploy, and read the sweep counters (`scanned`, `wouldDelete`,
   `skippedLegacy`, `skippedOrphan`, `failed`, `truncated`) across several sweeps. Each sweep records
   them, and the active `mode`, as `relay.managed_endpoint_reaper.*` attributes on its
   `relay.managed_endpoint_reaper.sweep` span in Axiom.
4. Run the disposable-host canary below.
5. Set `enabled` only after the canary recovers without a server restart.

The job runs every five minutes with a five-minute grace period for tunnels that lost their
connector, so a candidate is usually removed five to ten minutes after it goes down. Tunnels that
never connected wait an hour. One sweep attempts at most 100 deletions, so a backlog takes longer.
Changing `RELAY_TUNNEL_CLEANUP_MODE`, including turning cleanup off during an incident, needs a relay
deploy without force. Confirm the new `mode` on the next sweep span.

To roll back, set cleanup to `off` and run a relay deploy before downgrading any host. Keep the
recovery endpoints deployed while current server builds are in use. The nullable columns can stay.

### Legacy tunnel cleanup

A legacy tunnel belongs to a host that never registered recovery, usually one that went offline
before the recovery build shipped. `RELAY_LEGACY_TUNNEL_CLEANUP_MODE` deletes these once Cloudflare
reports them down, or never connected, for more than 7 days. It is independent of
`RELAY_TUNNEL_CLEANUP_MODE`, and every other check still applies.

A deleted legacy tunnel keeps its allocation, so its hostname is kept. When the host comes back:

- On a build with recovery, the connector is rejected and the host requests a replacement tunnel at
  the same hostname.
- On an older build with a CLI link, startup provisions a new tunnel.
- On an older build linked from web or mobile, the host stays offline until T3++ on that computer
  is updated.

Ship the web and mobile builds that show the offline reason before enabling legacy cleanup, so a
user whose host is affected sees what to do. The relay adds the `tunnel_released_at` allocation
column in its first deploy with this change; the legacy switch stays `off` until you set it.

1. Run `vp run --filter t3code-relay tunnels:census` with a read-only Cloudflare token. It counts
   tunnels in every relay stage. The reaper only sees its own stage's tunnels, so clean up the rest
   by hand.
2. Set the legacy mode to `dry-run`, deploy, and read `wouldDeleteLegacy`, `legacyOver30Days`,
   `totalDown`, and `totalInactive` on the sweep spans for a day. `wouldDeleteLegacy` counts only the
   tunnels a sweep inspected, at most 500 per status. `totalDown` and `totalInactive` are Cloudflare's
   counts of this stage's tunnels down for over five minutes and never connected for over an hour.
   They include ones the reaper skips, so they are an upper bound on the backlog. The share of `wouldDeleteLegacy` in each sweep's `scanned` estimates how
   much of that total is eligible.
3. Run the legacy steps of the disposable-host canary below.
4. Before enabling, confirm the web and mobile builds that show the "update T3++ on that computer"
   message are live. Without them, a user whose older host lost its tunnel only sees it as offline.
5. Set the legacy mode to `enabled`. One sweep deletes at most 100 tunnels, four at a time, and
   stops starting new deletions after 90 seconds. A backlog of 20,000 takes about 17 hours if each
   sweep finishes its 100. Watch `deletedLegacy`, `attempted`, `failed`, and `truncated`. An
   `attempted` well under 100 with `truncated` set means the sweep stopped early: either the time
   budget ran out or Cloudflare rate-limited a deletion. The counters don't say which; the relay
   logs a warning with the Cloudflare error for each failed deletion.

In Axiom, filter the relay traces dataset on `name == "relay.managed_endpoint_reaper.sweep"` and
chart the `attributes.custom.relay.managed_endpoint_reaper.*` fields over time.

Set the legacy mode back to `off` and deploy if any of these happen:

- `failed` stays above a few per sweep. Read the warning log for the Cloudflare error.
- Users report an environment that is offline with the update message after they have updated T3
  Code on that computer and restarted it.
- Relay request errors rise while sweeps run. Deletions share the Postgres connection pool with
  request handlers.

Turning the legacy mode off stops new legacy deletions; `RELAY_TUNNEL_CLEANUP_MODE` keeps deleting
tunnels of hosts with recovery while it is `enabled`. Deleted tunnels stay deleted; their hosts
recover as described above.

### Disposable-host canary

This test has not been run against a real Cloudflare account. Run it against a disposable relay
stage, test Cloudflare account, disposable host, and disposable T3 home. Keep production cleanup at
`off` or `dry-run` until it passes. Do not stop a daily-use T3 server.

1. Deploy the disposable stage with cleanup `dry-run`. Link a first disposable environment through
   web or mobile settings and confirm its tunnel is healthy and recovery is registered.
2. Stop that host and restart the same T3 home on a different local port. Confirm the public
   hostname reaches the new port and sends nothing to the old one.
3. Link a second disposable environment with a server build that predates recovery registration.
   Capture its managed `cloudflared` child PID, confirm it belongs to that host, and pause only that
   child with `kill -STOP <legacy-pid>`. Wait until Cloudflare reports it down for over five minutes.
4. Capture the first environment's `cloudflared` child PID from its server logs, confirm ownership,
   and pause it with `kill -STOP <first-pid>`. Wait until Cloudflare reports it down for over five
   minutes.
5. Confirm dry-run counts the first tunnel in `wouldDelete` and the second in `skippedLegacy`.
6. Set cleanup `enabled` on the disposable stage and deploy. Confirm in the test Cloudflare account
   that the first tunnel is deleted and the legacy tunnel still exists.
7. Resume the first child with `kill -CONT <first-pid>`. Confirm the running server detects the
   repeated rejection, requests recovery, and becomes reachable at the same hostname without a
   restart.
8. Resume the legacy child with `kill -CONT <legacy-pid>` and confirm its tunnel reconnects.
9. Repeat with a physical sleep and wake cycle on a disposable laptop before broad rollout.

Legacy cleanup, on the same disposable stage:

10. Set `RELAY_LEGACY_TUNNEL_GRACE_MINUTES=10` and the legacy mode to `dry-run`, then deploy. The
    override shortens the 7-day grace period and is ignored on `prod`. Pause the legacy child again
    and wait until Cloudflare reports it down for over ten minutes.
11. Confirm the sweep counts it in `wouldDeleteLegacy`, then set the legacy mode to `enabled` and
    deploy. Confirm the legacy tunnel is deleted and its allocation row remains.
12. With the legacy host still on its old build, resume the child. A CLI-linked host provisions a
    new tunnel on its next restart; a web- or mobile-linked host stays offline.
13. Update that host to the current build and start it. Confirm it requests recovery and is
    reachable at the same hostname.
14. Remove `RELAY_LEGACY_TUNNEL_GRACE_MINUTES` from the disposable stage.

## Marketing site deployment

Runs only when the Vercel secrets are set (see [Optional integrations](#optional-integrations)).

On nightly releases, the release workflow builds the same commit as a staged
production deployment of the marketing site's Vercel project while the desktop
jobs run, and promotes it with `vercel promote` after the release is published.
Stable releases do not deploy the marketing site because they can promote an
older nightly commit.

The job looks up the `t3code-marketing` project using the existing `VERCEL_TOKEN`
and `VERCEL_ORG_ID` secrets. It also respects the optional `VERCEL_TEAM_SLUG`
variable. The Vercel project's root directory must be `apps/marketing`.
Git deployments remain disabled in `apps/marketing/vercel.ts`.

## Mobile TestFlight and store releases

The mobile apps publish under T3 Tools' Expo, App Store, and Play accounts, so these workflows run
only in the upstream repository.

Merges to main publish compatible OTAs and build iOS prereleases with the `testflight`
profile at version `3.0.0`. Build numbers increment automatically. The committed app
version remains the App Store release version; Android keeps using that version.

To release iOS, dispatch **Mobile EAS Production** with `mode=build`,
`profile=production`, `platform=ios`, and the intended version, such as `2.0.1`.
The workflow commits and pushes the version before building and uploading it.
Select that build in App Store Connect for App Store review.

To force a TestFlight rebuild, select `profile=testflight`, `platform=ios`, and
leave the version blank. Submit the first `3.0.0` build for external beta review
in App Store Connect. Later builds may still require review; uploads alone do
not guarantee external approval. TestFlight builds expire after 90 days.

Both release and TestFlight binaries receive compatible production-channel OTAs,
separated by their major-version fingerprints. Manual `mode=update` uses the
selected profile's version. Before releasing `3.0.0` to the App Store, advance
`build.testflight.env.T3PP_MOBILE_VERSION` in `apps/mobile/eas.json` to the next
unreleased major and get its first beta build approved.

## Android APK mirror

`.github/workflows/mobile-android-apk.yml` checks the Google Play Alpha closed-testing
track hourly. Each new beta gets one `android-beta-<build-number>` prerelease
containing its APK. Unchanged checks publish nothing, and interrupted draft
uploads resume on the next check.

Normal Nightly releases include the newest processed internal-testing APK available
when the release publishes. Internal builds do not create separate Android releases.
If Play credentials or a processed APK are unavailable, the Nightly can still publish
without an APK. Android submissions continue to go to internal testing; promote a
build to Alpha to publish it as a beta.

The APK is the universal APK Play generates and signs from the
uploaded bundle, so no signing key lives in GitHub. The job skips itself until
`GOOGLE_PLAY_SERVICE_ACCOUNT_JSON` holds a Play service account key with the "Release to
production, exclude devices, and use Play App Signing" permission, which downloading generated
APKs requires. The job reads tracks without opening a Play edit, so it can share the service
account EAS Submit uses.

## Hosted web app release deployment

Runs only when the Vercel secrets are set; without them no hosted app is deployed and
app.t3.codes keeps serving upstream's build.

The hosted app is intentionally not deployed by Vercel's Git integration. The
web project disables automatic Git deployments in `apps/web/vercel.ts` via
`git.deploymentEnabled: false`. `.github/workflows/release.yml` builds the web
app with Vercel CLI as a staged production deployment (`--skip-domain`) while
the desktop jobs run, and aliases the channel domains to it after the GitHub
Release succeeds.

Required GitHub Actions secrets:

- `VERCEL_TOKEN`
- `VERCEL_ORG_ID`
- `VERCEL_PROJECT_ID`

Optional GitHub Actions variables:

- `VERCEL_TEAM_SLUG`: overrides the Vercel CLI scope when the team slug is preferred over the `VERCEL_ORG_ID` secret.
- `T3PP_WEB_ROUTER_URL`: defaults to `https://app.t3.codes`.
- `T3PP_WEB_LATEST_DOMAIN`: defaults to `latest.app.t3.codes`.
- `T3PP_WEB_NIGHTLY_DOMAIN`: defaults to `nightly.app.t3.codes`.

Required Vercel domains:

- `app.t3.codes`: the router domain users open, updated by stable releases.
- `latest.app.t3.codes`: channel alias updated by stable releases.
- `nightly.app.t3.codes`: channel alias updated by nightly releases.

The router domain uses `apps/web/vercel.ts` routes. Users opt into a channel by
visiting `/__t3code/channel?channel=latest` or
`/__t3code/channel?channel=nightly`; the router stores the
`t3code_web_channel` cookie and rewrites future requests on `app.t3.codes` to
the matching channel alias.

The release deploy job rewrites release package versions before upload so the
hosted app's About panel renders the release version. Stable deploys alias the
same deployment to both the `latest` channel and the router domain so the router
rules stay current. Nightly deploys only alias the `nightly` channel. The job
also passes `VITE_HOSTED_APP_CHANNEL=latest|nightly`, which renders the hosted
update track selector in the About panel. Changing the selector navigates
through `/__t3code/channel` on the router domain so the user's channel cookie is
updated before redirecting to the hosted app root.

One-time Vercel dashboard setup:

1. Confirm the web project root directory remains `apps/web`.
2. Add the three domains above to the web project.
3. Disable automatic Git deployments in the dashboard if desired; the committed
   `vercel.ts` setting is the source-of-truth, but disconnecting Git in the
   dashboard is also safe.
4. Run one stable release deployment, or manually alias the current stable
   deployment, so `app.t3.codes` points at a deployment containing the router
   rules in `apps/web/vercel.ts`. Future stable releases keep this alias current.

## Nightly builds

- Workflow: `.github/workflows/release.yml`
- Trigger: manual `workflow_dispatch` with `channel=nightly`. With the `schedule` trigger restored,
  automatic nightlies also need new commits and six hours since the last nightly.
- Manual nightlies bypass the time and change checks. Nightly runs remain serialized.
- Runs the same desktop quality gates and artifact matrix as the tagged release flow.
- Publishes a GitHub prerelease only:
  - current tag format: `vX.Y.Z-nightly.YYYYMMDD.<run_number>`
  - `nightly-v...` is accepted only as a legacy previous-nightly tag
  - release name includes the short commit SHA
  - `make_latest` is always `false`
- Uses the next stable patch version as the nightly base. For example, `0.0.17` produces nightlies on `0.0.18-nightly.*`.
- Publishes Electron auto-update metadata to the dedicated `nightly` updater channel, so desktop users can opt into that track independently from stable.
- Publishes the `t3pp` npm launcher to the `nightly` npm dist-tag when npm publishing is on.
- Does not commit version bumps back to `main`.

## Server self-update release invariant

Connected servers update to the client's exact version, not to an npm dist-tag. Servers that update
themselves download that version's CLI archive from the GitHub Release; servers run through npm are
handed a `t3pp@<version>` command to run. Every released client version must therefore have its
release archives, and then its npm launcher, available before users can receive that client.

The workflow enforces this ordering:

1. `release` publishes the GitHub Release with the CLI archives and `SHA256SUMS`. Every channel
   uploads to a draft and publishes only after all assets are attached, so a new version in the
   desktop update feed already has its archives. **Update everything** relies on this to update
   background-service hosts before npm has the version. Rerunning `release` after publication
   replaces assets in a public release, so service updates can fail until the upload finishes.
2. `publish_cli` publishes the `t3pp@<version>` launcher, which downloads from that release, on every
   channel. While npm publishing is off, servers started through `npx t3pp` cannot follow; servers
   installed by the installers or `t3pp service install` update from the archives.
3. `deploy_web` depends on both before moving the hosted channel to the new client.
   `build_web` builds that client earlier with `vercel deploy --prod --skip-domain`, which
   leaves the custom domains alone but moves the project's own `*.vercel.app` production
   hostname. That hostname is behind Vercel SSO, so users only get the client through the
   custom domains.

Desktop auto-update reads the GitHub Release directly, so a desktop client can see the new version
a few minutes before `t3pp@<version>` is on npm. Only the copied manual command for npm-run servers
depends on npm, and it works once `publish_cli` finishes.

Preserve these dependencies when changing the release graph. Publishing a client first would leave
the **Update server** action targeting a package version that does not exist yet.

For a release smoke test, confirm `npm view t3pp@<version> version` returns the expected version, then
connect the new client to a server on the previous version and verify that the update action
reconnects to the matching server. When the release adds database migrations, verify that the
remote update applies them and reconnects. A failed trial must restore the database snapshot and
restart the previous server. If the installed launcher does not support the target protocol,
verify that the update stops before restart and run `npx t3pp@<version> service update` once on the
server machine. Also test the manual or desktop-managed guidance when those environments are
available.

## Desktop auto-update notes

- Updater runtime: `apps/desktop/src/updates/DesktopUpdates.ts`.
- `electron-updater` adapter: `apps/desktop/src/electron/ElectronUpdater.ts`.
- `apps/desktop/src/main.ts` only wires the updater layers into the desktop runtime.
- Update UX:
  - Background checks run on startup delay + interval.
  - No automatic download or install.
  - The desktop UI shows a rocket update button when an update is available; click once to download, click again after download to restart/install.
- Provider: GitHub Releases (`provider: github`) configured at build time.
- Repository slug source:
  - `T3PP_DESKTOP_UPDATE_REPOSITORY` (format `owner/repo`), if set.
  - otherwise `GITHUB_REPOSITORY` from GitHub Actions.
- Required release assets for updater:
  - platform installers (`.exe`, `.dmg`, `.AppImage`, `.deb`, plus macOS `.zip` for Squirrel.Mac update payloads)
  - channel metadata: `latest*.yml` for stable releases, `nightly*.yml` for nightly releases
  - `*.blockmap` files (used for differential downloads)
- macOS metadata note:
  - `electron-updater` reads `latest-mac.yml` on stable and `nightly-mac.yml` on nightly, for both Intel and Apple Silicon.
  - The workflow merges the per-arch mac manifests into one channel-specific mac manifest before publishing the GitHub Release.

### Windows payload topology and update validation

Windows packages the bundled server and only its runtime-external/native
dependency closure in `resources/server.asar`. Native modules and helper
executables declared as unpacked by that archive must be present at the matching
paths below `resources/server.asar.unpacked`. The Windows-native backend reads
the archive in place through Electron. Packaged Windows builds also ship
`resources/wsl-runtime.tar.gz` plus its SHA-256 sidecar: the Linux CLI archive
(`t3pp-<version>-linux-<arch>.tar.gz`, the same arch as the Windows host) built
by the Linux desktop job and handed to the Windows desktop build as
`--wsl-runtime`, copied in verbatim so WSL runs the exact bytes a Linux user
downloads. WSL verifies and extracts that archive
into `~/.t3pp/wsl-runtime/sha256-<archive-digest>` inside the selected distro,
then reuses it for later launches of the same update.

Windows keeps JavaScript and package metadata inside `app.asar` and unpacks only
native libraries and helper executables. Avoid enabling whole-package smart
unpacking: each loose file adds work to NSIS installation and counts against
the payload limit.

The artifact builder rejects a Windows package when any of these invariants
break:

- `resources/server.asar` is absent or does not contain the server entry.
- Any file marked unpacked in the ASAR header is absent from
  `resources/server.asar.unpacked`.
- On same-architecture Windows builds, the packaged primary cannot load the fff
  native library from inside `server.asar` through its `.unpacked` sibling.
- The isolated, extracted sidecar cannot load the server entry with plain Node.
- A Windows build given `--wsl-runtime` omits the WSL archive or SHA-256
  sidecar, or the sidecar digest does not match the emitted archive.
- The emitted WSL archive is not a Linux CLI release archive: it must unpack to
  a single `t3pp-<version>-linux-<arch>` directory holding `t3pp`, `client/`, and
  `node_modules/` with the Linux node-pty binary, and must not carry a loose
  server bundle (`bin.mjs`).
- The external Windows resource monitor is absent.
- The unpacked Windows application contains more than 80 files.

Cross-architecture Windows builds retain every structural and extracted-sidecar
check, but skip executing the target Electron binary. A same-architecture build
for each release target must exercise the primary native-load probe.

NSIS differential packaging remains enabled. A sidecar layout transition can
produce a larger one-time download; subsequent small releases retain their
blockmaps, with a 60 MB maximum for a representative sidecar-to-sidecar update.

## 0) npm OIDC trusted publishing setup (CLI)

The `publish_cli` job runs only when the `T3PP_NPM_PUBLISH` repository variable is `true`. After
the GitHub Release is published, it runs `node scripts/build-npm-launcher.ts`, then
`node apps/server/scripts/cli.ts publish --packages-dir npm-packages`, which publishes the `t3pp`
launcher. That is the only package published per release.

Checklist:

1. Confirm you own package `t3pp` on npm, or rename the launcher package first.
2. For `t3pp`, configure a Trusted Publisher in the npm package settings:
   - Provider: GitHub Actions
   - Repository: this repo
   - Workflow file: `.github/workflows/release.yml`
   - Environment (if used): match your npm trusted publishing config
3. Ensure npm account and org policies allow trusted publishing for the package.
4. Set the `T3PP_NPM_PUBLISH` variable to `true`. The next tag publishes the GitHub Release and
   then the launcher with npm dist-tag `latest`.
5. Nightly runs publish with npm dist-tag `nightly`; preview runs with `preview`.

## 1) Release validation and unsigned builds

There is no dry-run tag path. Pushing any accepted non-nightly tag, including
`v0.0.0-test.1`, classifies the run as the stable channel and creates a real GitHub Release that
installers and updaters follow. With the optional integrations on, it also publishes to npm,
moves the hosted app, and commits a version bump to `main`. Do not push a test tag to validate
the workflow; dispatch `channel=preview` instead.

The workflow has no non-publishing `workflow_dispatch` mode. Use normal CI or local quality gates to
validate checks and builds without shipping. To exercise the complete release graph at lower stable
risk, manually dispatch `channel=nightly`; this still publishes a real GitHub prerelease and
nightly updater feed (plus npm, the hosted nightly alias, and the marketing site when those are
on), but it does not touch stable. Only run it when a real nightly release is acceptable.

Manual `channel=stable` is also a real stable-channel release. Omitting signing secrets only makes
platform artifacts unsigned; it does not prevent publication.

## 2) Apple signing + notarization setup (macOS)

Required secrets used by the workflow:

- `CSC_LINK`
- `CSC_KEY_PASSWORD`
- `APPLE_API_KEY`
- `APPLE_API_KEY_ID`
- `APPLE_API_ISSUER`
- `MACOS_PROVISIONING_PROFILE` (base64-encoded provisioning profile with Associated Domains)

Required repository variables:

- `APPLE_TEAM_ID`

Optional repository variables:

- `CLERK_PASSKEY_RP_DOMAINS`: comma-separated RP-domain override. By default, the build derives the
  domain from the production Clerk publishable key.

Checklist:

1. Apple Developer account access:
   - Team has rights to create Developer ID certificates.
2. Create an explicit App ID for `com.t3pp.t3pp` and enable Associated Domains.
3. Create a `Developer ID Application` certificate and a compatible provisioning profile for that
   App ID with Associated Domains enabled.
4. Export the certificate + private key as `.p12` from Keychain.
5. Base64-encode the `.p12` and store as `CSC_LINK`.
6. Base64-encode the provisioning profile and store it as `MACOS_PROVISIONING_PROFILE`.
7. Store the `.p12` export password as `CSC_KEY_PASSWORD`, and set `APPLE_TEAM_ID` to the
   10-character Apple Developer Team ID.
8. In App Store Connect, create an API key (Team key).
9. Add API key values:
   - `APPLE_API_KEY`: contents of the downloaded `.p8`
   - `APPLE_API_KEY_ID`: Key ID
   - `APPLE_API_ISSUER`: Issuer ID
10. Complete the Clerk Native API and AASA setup in [T3 Connect setup](./connect-setup.md#desktop-passkeys).
11. Re-run a tag release and confirm macOS artifacts are signed/notarized and contain the expected
    `com.apple.developer.associated-domains` entitlement.

Notes:

- `APPLE_API_KEY` is stored as raw key text in secrets.
- The workflow writes it to a temporary `AuthKey_<id>.p8` file at runtime.
- The workflow decodes `MACOS_PROVISIONING_PROFILE`, validates it with `security cms`, and passes it
  to the desktop packager.
- In-app browser passkeys depend on the same profile. The packager adds each entitlement only when
  the profile grants it, because macOS will not launch an app that claims more than its profile
  allows. The build log reports which ones it enabled.
  - `keychain-access-groups` (`<TEAM_ID>.com.t3pp.t3pp.webauthn`) enables Touch ID passkeys.
    Profiles that grant the team's keychain groups (`<TEAM_ID>.*`) cover it.
  - `com.apple.developer.web-browser.public-key-credential` lets the system passkey sheet (iCloud
    Keychain, password managers, phones, security keys) serve any site. Apple grants it as a
    managed capability: the Account Holder requests it through the
    [macOS Browsers Passkeys form](https://developer.apple.com/contact/request/macos-browsers-passkeys/).
    After approval, regenerate the profile and update `MACOS_PROVISIONING_PROFILE`.

## 3) Azure Trusted Signing setup (Windows)

Required secrets used by the workflow:

- `AZURE_TENANT_ID`
- `AZURE_CLIENT_ID`
- `AZURE_CLIENT_SECRET`
- `AZURE_TRUSTED_SIGNING_ENDPOINT`
- `AZURE_TRUSTED_SIGNING_ACCOUNT_NAME`
- `AZURE_TRUSTED_SIGNING_CERTIFICATE_PROFILE_NAME`
- `AZURE_TRUSTED_SIGNING_PUBLISHER_NAME`

Checklist:

1. Create Azure Trusted Signing account and certificate profile.
2. Record ATS values:
   - Endpoint
   - Account name
   - Certificate profile name
   - Publisher name
3. Create/choose an Entra app registration (service principal).
4. Grant service principal permissions required by Trusted Signing.
5. Create a client secret for the service principal.
6. Add Azure secrets listed above in GitHub Actions secrets.
7. Re-run a tag release and confirm Windows installer is signed.

## 4) Ongoing release checklist

1. Merge what ships into `main` through pull requests.
2. Tag the commit and push the tag (`git tag vX.Y.Z <sha> && git push origin vX.Y.Z`), or verify a
   nightly and dispatch `channel=stable` to promote it.
3. Watch the run: preflight, quality checks, tests, `build_bundle`, all six desktop jobs, then the
   release job. Optional jobs that are off show as skipped.
4. Confirm the release lists every installer, CLI archive, updater manifest, and `SHA256SUMS`.
5. Run the one-line installer on at least one machine and check that an older desktop install
   offers the update.

## 5) Troubleshooting

- macOS build unsigned when expected signed:
  - Check all Apple secrets plus `APPLE_TEAM_ID` are populated and non-empty.
  - Confirm the provisioning profile belongs to `APPLE_TEAM_ID.com.t3pp.t3pp` and includes
    Associated Domains.
- Windows build unsigned when expected signed:
  - Check all Azure ATS and auth secrets are populated and non-empty.
- Build fails with signing error:
  - Retry with secrets removed to confirm unsigned path still works.
  - Re-check certificate/profile names and tenant/client credentials.
