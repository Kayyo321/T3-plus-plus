# Remote control

Remote control lets you reach one conversation from your phone, a tablet, or another computer. You
watch it stream, and depending on the access you choose, you can send messages, answer the agent,
and stop a run. Nothing is installed on the other device: it is a web page.

This is narrower than [connecting a client](./remote-access.md), which gives an app the whole
machine. A remote device reaches one conversation and nothing else.

## Turn it on

1. Open the conversation's thread details panel and switch on **Remote Control**. The switch needs a
   conversation that has started. The header button and the command palette's **Remote control**
   (`Ctrl+Alt+R`, `Cmd+Option+R` on a Mac) also work.
2. Turning it on uses Chat access and **Approve on this device** pairing, and opens the sheet with the
   link. Change access or pairing in that sheet.
3. Scan the QR code on the other device, or send it the link.

If no other device can reach this machine, the sheet says what you can set up instead of showing a
link that would not work.

Each link works once and stops working after 30 minutes. To add another device, choose **New link**.

## Pair a device

Opening the link alone never gets anyone in. The device names itself, and then one of these happens:

- **Approve on this device** (default): you see a request on your computer with a word on it. The
  same word shows on the device. Allow it only if they match.
- **One-time code**: the sheet shows an 8 digit code, and the device types it in. Use this when
  nobody will be at the computer to approve. Five wrong tries lock the link, and you need a new one.

After pairing, that browser stays signed in to this conversation for its session.

## Access levels

| Level   | What the device can do                             |
| ------- | -------------------------------------------------- |
| View    | Watch the conversation                             |
| Chat    | Also send messages and files to the agent          |
| Approve | Also answer the agent's approvals and questions    |
| Full    | Also stop a run and change the conversation's mode |

The default is Chat. Raising the level asks you to confirm, and it applies to every paired device at
once. Lowering it applies at once too.

A device can approve or deny one request at a time, but it cannot grant a standing approval. It
cannot rewind the conversation, open files on your machine, or see other conversations.

## How a device connects

T3++ offers the routes this machine actually has, best first:

- **This network** works when both devices share a network and this server accepts network
  connections. It is plain HTTP, so anyone on that network could read the conversation. Devices on
  this route stop at Chat, whatever level you chose. Use it on a network you trust.
- **Tailscale** works from anywhere on your tailnet and is encrypted.
- **T3 Connect** works from anywhere and is encrypted. See [remote access](./remote-access.md).

## How long access lasts

A session ends after 2 hours without activity, or 12 hours after pairing, whichever comes first.
Keeping the page open counts as activity. The sheet shows how long each device has left.

To end access sooner:

- **Disconnect** removes one device.
- **Replace link** kills an unused link and any request waiting on it. Paired devices stay.
- **Turn off** ends every device and the link at once, asking first if any device is connected. You can also do this from the mobile app,
  above the composer of the conversation.

Archiving a conversation turns its remote control off, and unarchiving does not bring it back. A
device that was removed sees why on its page. Devices can also leave with **Leave**.

The header shows how many devices are connected. Every join, message, approval, and disconnect is
in the [activity log](./activity-log.md) under the device's name.

## Two people at once

Several devices can be connected together, and each can send. Messages run in the order they arrive,
each with its device's name beside it, so you can see who sent what. There is no typing lock. The
first answer to an approval wins, and anyone else is told it was already answered.

## Review messages first

By default a remote message runs like any other, at the conversation's permission mode. The agent
is told it came from a remote device and that you did not review it. Slash commands do not run.

If you are sharing with someone you do not fully trust, turn on **Review messages**. Each message
then waits at the end of the conversation until you choose **Send** or **Dismiss**, as with
[guest links](./guest-links.md).

## When your machine is offline

The conversation lives on your machine, so when it sleeps or loses its connection the page says the
owner's machine is offline and the conversation is paused. The page reconnects on its own and picks
up from the last event it saw. Phones that sleep do the same when they wake.

## Using the mobile app

In the T3++ app, scan or paste a remote control link where you add a connection, and it opens the
page in your browser. To control a whole machine from the app, [pair it](./remote-access.md) instead.

## Things to keep in mind

Anything the agent read or printed can show on the page, such as a value from a file. Remote devices
see that an environment is attached to a conversation, but never its secret values.

A conversation with a [guest link](./guest-links.md) cannot use remote control until you end the
link, and the other way around.
