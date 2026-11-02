# Set up a T3++ private relay

You are helping someone connect T3++ to a private relay, so a phone can open Remote Control from
anywhere. The relay is a small Cloudflare Worker on their own account. Their computer dials out to
it, so nothing needs to reach their computer directly.

Work through this one step at a time and explain each step in plain language. Say what a step will
do before you do it, and wait for a yes before anything that changes their Cloudflare account.

## Rules

- Never print, read aloud, or ask for the relay secret, and never open `remote-relay.bin`. The setup
  script handles the secret without you seeing it. Secrets don't belong in this conversation.
- Don't change firewall, VPN, or network settings.
- Don't turn on **Network access**. The relay doesn't need it.

## 1. Find out where they stand

Ask whether they already have a relay.

- **They have one and know its address and secret:** have them open **Settings → Sharing & access →
  Private relay**, choose **Add relay**, and paste both there, not here. Go to step 5.
- **They have one on this computer, but no secret:** run the setup below. It deploys over the same
  Worker and replaces the secret.
- **They don't have one:** continue. They need a Cloudflare account, and the free plan is enough to
  start. If they don't have one, send them to <https://dash.cloudflare.com/sign-up> and wait.

## 2. Check the tools

They need `git` and Node.js 22 or newer. Check with `git --version` and `node --version`. If either
is missing or too old, help them install it the usual way for their system.

The T3 home is where T3++ keeps its data. Use the path from their message. If there isn't one, use
`T3PP_HOME` if it's set, and otherwise `~/.t3pp`.

## 3. Get the relay code

Clone into a temporary folder, unless they're already in a T3++ checkout:

```sh
git clone --depth 1 https://github.com/Kayyo321/T3-plus-plus.git "$(mktemp -d)/T3-plus-plus"
```

Then, from the root of that checkout:

```sh
npx --yes pnpm@12.14.0 install --filter t3code-remote-relay... --ignore-scripts
```

## 4. Deploy it

From `infra/remote-relay`, sign in to Cloudflare. This opens their browser, so tell them what to
expect and wait for them to finish:

```sh
node_modules/.bin/wrangler login
```

Confirm the account with `node_modules/.bin/wrangler whoami`, then deploy, using their T3 home:

```sh
node setup.mjs --home "<T3 home>"
```

Cloudflare may ask them to choose a `workers.dev` subdomain the first time. This name is public.

## 5. Check it worked

Within a few seconds, **Settings → Sharing & access → Private relay** should say **Connected**. There
is no need to restart T3++. If it says it can't reach the relay, run the setup again. If that doesn't
help, check that the T3 home above is the one this copy of T3++ uses.

## 6. Try it on a phone

In a conversation that has started, switch on **Remote Control** in the thread details panel, open
the dropdown, and check that the link says **Private relay**. Click the QR code to reveal it, then
scan it. On the phone, name the device. If the same word shows on both screens, choose **Allow** on
the computer.

Finish by telling them what changed: one Worker on their Cloudflare account, and one relay entry in
T3++. Offer to delete the temporary folder. They can remove the relay from the same settings page,
and `wrangler delete` from `infra/remote-relay` removes the Worker.
