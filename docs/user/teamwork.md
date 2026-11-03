# Teamwork

Teamwork runs a request through a team of agents on a **sheet**: a flow chart with a Project Lead, and
teams that build, review, and validate the work. Each sheet is saved, so you can reuse a team setup.

## Turn a sheet on

In code mode, click the teamwork button in the composer's toolbar, right next to the workspace selector.
Pick **Off**, **Default teamwork**, or one of your saved sheets. While a sheet is on, the button stays
highlighted and its tooltip names the sheet. The setting belongs to the thread, so other threads are
unaffected. Chat mode hides the button.

While a sheet is on, each message you send goes to the Project Lead. A message sent during a run also
goes to the lead, not to the team working at that moment.

## Create and edit sheets

**Create new sheet** opens the sheet editor on the right, starting from a copy of the default. The default
is read-only, so use **Duplicate** on it to make changes. You can edit, rename, or delete any other sheet
from the picker's **Edit** action or the command palette.

In the editor you add, remove, and rename teams, edit their role instructions, and connect them. Right-click
a team, a connection, or an empty spot on the chart for the same actions. Drag across empty space to select several teams and move them together. Hold the middle mouse button to pan the chart, and
use **Recenter** or `mod+alt+h` to bring it back. The editor refuses a sheet the run could not execute, with a plain message: no lead, more than one lead, a team
the lead cannot reach, or no way to finish. Changes save as you go, and a problem stays on screen until
you fix it or discard it.

Each team has a model option:

- **Lead decides** lets the lead pick any provider and model for that team.
- **Lead decides within one provider** lets the lead pick the model, but keeps it on one provider.
- **Pinned** uses one exact provider and model every run.

In all three, the lead still chooses reasoning effort and team size. The Project Lead always uses this
thread's model.

## Growth

Growth is a setting on the Project Lead node, and it controls whether a run can add members.

- **Off** (default): the team is fixed after the first run. Requests to add a member are refused.
- **On**: the lead decides each request.
- **Ask**: you answer each request on the run board first. A denial is final.

When Growth is On or Ask, choose a scope. **Per session** adds the member to this thread only. **Save to
sheet** also adds it to the sheet.

## The run board

The run board shows where the run is, the status of each member, and any request waiting for your answer.
You can open a member, or view it in split view. A blocked member says why it is blocked and offers
**Replace**. Denied requests show the reason.

## Stop and resume

**Stop** interrupts the turns in progress and ends the run. Its team sessions stay, and your next message starts a new run with them. A run that reaches its budget pauses instead, and continues once you raise the budget and resume it.

Archiving or deleting the conversation also ends its run.

A team session is kept across runs. If you delete a session that is on a roster, its slot is blocked until
you replace it, and the replacement starts with an empty conversation.
