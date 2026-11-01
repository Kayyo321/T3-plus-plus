# Remote control

## What it is

A **switch on a conversation**. Turn it on and T3-plus-plus serves a small, self-contained web page for
that one conversation. You get a link. Open it on your phone, a tablet, or another computer and you
can watch the conversation stream and, with permission, talk to the agent, approve actions, and stop
a run.

Turn the switch off and the link dies immediately.

This is different from connecting a client to an environment (see [remote](../internals/remote.md)),
which gives a whole app access to everything. Remote control is **one conversation, narrowly scoped,
revocable in one click**. It generalizes the beta [guest links](../user/guest-links.md): same idea
(a link to one thread) with the missing pieces made real: control, device trust, and no hard dependency
on T3 Connect.

## Experience

1. The conversation header has a remote switch. Flip it.
2. A sheet shows a link, a QR code, the current access level, and who is connected.
3. Open the link on a phone. First visit asks for a pairing step (below). After that the page shows
   the conversation in a layout built for narrow screens: transcript, composer, approve/deny, stop.
4. The desktop shows a small indicator when anyone is connected, with their device label and what they
   last did. Disconnect any device individually.
5. Flip the switch off, or archive the conversation, and every session ends.

## Auth model

The goal: a leaked link must not be enough, and a forgotten link must not stay valid.

- **Link plus proof.** The URL carries a high-entropy, single-use _pairing token_. Opening it in a
  new browser starts a pairing flow rather than granting access directly.
- **Owner approval or a code.** Two pairing modes, chosen per switch:
  - _Approve on desktop_ (default): the desktop shows "Pixel 8 wants to join. Allow?" with a short
    confirmation word shown on both screens so the owner can tell it is the right device.
  - _One-time code_: the owner reads a 6 to 8 digit code from the desktop and types it on the phone.
    Useful when nobody is at the desktop to click.
- **Device-bound sessions.** After pairing, the browser gets a session credential in a secure,
  HTTP-only cookie (or stored key on mobile) bound to that device. The token in the URL is spent.
- **Access levels.** _View_, _Chat_ (send messages), _Approve_ (also answer permission prompts), and
  _Full_ (also interrupt, change mode). Default: Chat. Raising it needs desktop confirmation.
- **Expiry.** Sessions expire after inactivity and after an absolute lifetime. Defaults should be
  short (hours, not weeks) and shown plainly.
- **Rate limiting and lockout.** Failed pairing attempts are rate limited; repeated failures disable
  the pairing token.
- **Revocation.** Revoke one device, rotate the link (kills pending tokens), or switch off (kills
  everything). All take effect immediately, including mid-stream.
- **Scoped.** A remote session can reach exactly one conversation. It cannot list other
  conversations, open files outside the conversation's context, read environment secrets, or address
  the [orchestrator](./orchestrator.md).
- **Audit.** Who joined, from what device label, what they sent, what they approved, in the audit
  trail with a distinct actor.

Where the existing [environment auth](../internals/environment-auth.md) already has primitives
(pairing, scopes, sessions), reuse them rather than inventing a parallel system. The remote-control
scope should be a strictly narrower grant than any environment scope.

## Reaching the host

The link must work when the user is away from home, without making them configure networking:

- **Same network:** a LAN address works directly.
- **Tailscale:** use the tailnet address when available (the repo already has a Tailscale package).
- **T3 Connect / tunnel:** the default for off-network use; the existing relay and tunnel carry
  the conversation without opening ports.
- **No route available:** the switch explains which options exist instead of showing a dead link.
  It must never fall back to a loopback address that only works on the host itself.

## What the remote page needs

- Live streaming of the transcript with the same performance care as the main app: send deltas,
  not whole transcripts.
- Composer, attachments, approve/deny prompts, stop.
- Reconnect handling, since phones sleep and networks change. Resume from the last seen event.
- Push notifications when the agent needs input or finishes, where the platform allows.
- Works as a plain web page, so no install is required. The native mobile app can open the same
  link and upgrade the experience.

## Edge cases to decide

- Two people controlling at once: show who sent what; consider a soft "typing" lock.
- Owner offline: the conversation is paused remotely too, and the page says so.
- A remote user sends a prompt that the owner never reviewed: by default it just runs at the
  conversation's permission mode. Offer an owner-review queue (as guest links do today) for
  untrusted collaborators.
- Conversations in a worktree or with an attached environment: remote users never see environment
  secret values, only that an environment is attached.
