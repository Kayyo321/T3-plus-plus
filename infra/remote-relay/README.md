# Remote Control relay

A small Cloudflare Worker you deploy to your own account. It lets a phone open a Remote Control
link from anywhere when no inbound connection can reach your computer: behind a VPN kill switch, on
a network that isolates devices, or with no way to forward a port.

Your computer dials out to the relay over WSS on port 443. A browser's request reaches the relay,
and the relay passes it down that open connection. Nothing listens for inbound traffic on your
computer, and **Network access** can stay off.

## Set up

The easiest way is **Settings → Sharing & access → Private relay**. Run the onboarding prompt there,
and an agent walks you through [these steps](./ONBOARDING.md).

To do it by hand, you need Node.js 22 or newer. From a checkout of this repository:

```sh
npx --yes pnpm@12.14.0 install --filter t3code-remote-relay... --ignore-scripts
cd infra/remote-relay
node_modules/.bin/wrangler login
node setup.mjs --home ~/.t3pp
```

`--home` is your T3 home. It defaults to `T3PP_HOME`, then `~/.t3pp`.

The script deploys the Worker, creates a shared secret, gives it to Cloudflare, and saves the relay's
address and secret to `<T3 home>/userdata/secrets/remote-relay.bin`, readable only by you. T3++
connects within a few seconds, and **Private relay** becomes the first route in Remote Control.

If you already have a relay's address and secret, add them in the same settings page instead.

Run the script again to replace the secret. To remove the relay, choose **Remove** in Settings, then
run `node_modules/.bin/wrangler delete`.

## What protects it

- **Only Remote Control is exposed.** The Worker and your computer each check every request against
  the same allowlist: the `/remote` page, its static files, and `/api/remote/*`. The rest of the
  server, including `/ws`, `/pair`, and the auth API, can't be reached through the relay.
- **Only your computer can be the host.** The relay accepts a host only with the shared secret, which
  never appears in a link.
- **Remote Control's own checks still apply.** Links work once and expire, a device needs your
  approval, and sessions end on their own. A visitor without a link gets nothing but the empty
  join page.
- **Nothing is stored.** The Worker keeps no data, and its logs are off.

## What it can't protect

Cloudflare ends TLS for your Worker, so conversation text passes through its memory unencrypted
while it's being forwarded, the same as T3 Connect. Use Tailscale when even Cloudflare shouldn't be
able to see the traffic.

## Limits

Requests to the relay count against your Cloudflare Workers plan. Large downloads aren't throttled,
so a very large attachment on a slow connection can restart the relay; the page reconnects by itself.

## Develop locally

Put `HOST_SECRET=<any value>` in `.dev.vars`, run `node_modules/.bin/wrangler dev`, and save
`{"url":"http://127.0.0.1:8787","secret":"<same value>"}` as the file above in a test T3 home. Plain
HTTP is accepted only for `127.0.0.1`.
