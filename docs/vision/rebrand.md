# Rebrand: T3 Code to T3++

T3++ is the product name. The rebrand was **product-facing**: what users see, what builds produce,
and where state lives now say T3++. Internal identifiers were deliberately left alone to keep the
diff reviewable.

## Renamed

| Was                                                                  | Now                              |
| -------------------------------------------------------------------- | -------------------------------- |
| Display name `T3 Code`, `T3 Code (Beta)`                             | `T3++`                           |
| CLI package and binary `t3`, `npx t3`, `t3 up`                       | `t3pp`, `npx t3pp`, `t3pp up`    |
| CLI archives `t3-<version>-<platform>`, `t3.exe`, `t3.cmd`, `t3.tgz` | `t3pp-...`                       |
| Launcher `scripts/npm-launcher/t3.mjs`                               | `t3pp.mjs`                       |
| Data directory `~/.t3`, per-worktree `.t3`                           | `~/.t3pp`, `.t3pp`               |
| Environment variables `T3CODE_*`                                     | `T3PP_*`                         |
| Desktop app IDs `com.t3tools.t3code`, `com.t3tools.T3Code`           | `com.t3pp.t3pp`, `com.t3pp.T3PP` |
| Desktop installer artifacts `T3-Code-<version>-<arch>`               | `T3PP-<version>-<arch>`          |

## Deliberately unchanged

- **`@t3tools/*` package scope, `t3code` lint plugin and rule names, `.repos`, file and directory
  names** containing `t3code`. Renaming them is a mechanical but very large change with no user
  benefit. Do it separately if wanted.
- **Hosted T3 services:** `t3.codes`, `app.t3.codes`, the T3 Connect relay, auth, and the update feed.
  T3++ still depends on them. Anything called "T3 Connect" keeps that name because it names the hosted
  service, not this product.
- **Mobile identity:** the iOS and Android bundle IDs, store links, and the APNs/relay wiring. Push
  delivery is tied to those IDs on the hosted relay, so changing them breaks mobile.
- **`t3.json`** project config file name, and `T3_ACP_*` test-only variables.
- **GitHub URLs** (`pingdotgg/t3code`), used for updates and links until the fork has its own
  releases. Point these at the T3++ repository when releases move.

## Consequences to plan for

- **State is separate from T3 Code.** `~/.t3pp` does not read `~/.t3`, so installing T3++ beside T3 Code
  no longer shares a database. The dev seed script (`vp run migrate-dev-db`) now reads
  `~/.t3pp/userdata`. Copy `~/.t3/userdata` there by hand if you want existing threads.
- **CI secrets and variables** read as `T3CODE_*` in workflows are now `T3PP_*`. Rename them in the
  repository settings.
- **npm.** Publishing `t3pp` needs a trusted publisher registered for the release workflow.
- **Update feed and signing.** The desktop updater, code signing, and store listings need to point at
  T3++ infrastructure before a public release.
