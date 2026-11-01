# Layouts, split view, and IDE mode

A layout is a saved arrangement of panels. It holds positions, sizes, and which panels are open, and
never any conversation content. Layouts live on this device and do not follow you to other clients.

These features are for web and desktop. The mobile app keeps its own navigation.

## Use a layout

Open the layouts menu in the title bar, or press Ctrl+K (Cmd+K on macOS) and search for
`Layout: Review`. Ctrl+Alt+L (Cmd+Option+L on macOS) cycles through them.

Applying a layout changes only the current conversation. Panels on screen before and after stay
loaded, so nothing reloads.

| Layout | Shows                                                  |
| ------ | ------------------------------------------------------ |
| Focus  | The conversation alone, and any split closed           |
| Review | The conversation beside diff and pull requests         |
| Debug  | The conversation over a terminal, beside the browser   |
| Pair   | Two conversations side by side                         |
| IDE    | Files, editor, and tools, with the conversation docked |

## Arrange panels

- **Move a tab:** drag it to another group's middle to stack it, or to an edge to split that group.
- **Move the conversation:** drag the small grip at the top of a docked conversation to a group's
  edge.
- **Resize:** drag the line between two panels, or focus it and use the arrow keys.
- **Collapse or close a group:** use the buttons at the end of its tab bar. Closing a group keeps
  its tabs open in another group.

Below 980 pixels wide, a layout's panels fall back to the single slide-over panel.

## Save and reuse a layout

Choose **Save current layout** in the layouts menu. **Use this for new conversations** makes the
current layout the default, and **Always use this for this project** sets a default for one project,
which wins over the general one. **Reset to default** returns the conversation to the default.

Rename and delete layouts, and see every project default, in **Settings > Layouts**.

A layout opens panels by kind. Panels that show something specific, such as a file or pull request,
are not reopened, though they return to the same place when you open them.

## Split view

To show conversations side by side, drag one from the sidebar to the edge of the conversation, or
choose **Open in split view** from its menu. Ctrl+\ (Cmd+\ on macOS) opens an empty pane, where you
can pick a related conversation. Up to four panes fit, as width allows.

Each pane has its own composer and run state. The focused pane is the one the sidebar highlights,
and it takes keyboard input; click a pane to focus it, or press Ctrl+Alt+Right and Ctrl+Alt+Left
(Cmd+Option on macOS) to move between panes. Opening a conversation from the sidebar shows it in the focused
pane.

The link button on a pane's bar compares turns: as you read in the focused pane, the others scroll
to the same turn number, which suits two forks of one conversation.

Panes that do not fit, or that you collapse, become a thin rail showing title and run state. They
keep running on the server, and the conversation reappears when you expand the rail.

Saved layouts remember how many panes are open and their sizes, not which conversations were in
them. Applying one opens any extra panes on the picker. Panel-only layouts such as Review leave a
split as it is and change just the focused conversation.

## IDE mode

The IDE layout turns the conversation into a docked panel beside a file explorer, tabbed editor,
terminal, and diff.

- **Review the agent's edits.** Changes made while a file is open, or in the latest turn, are
  highlighted in the editor as they land, with **Accept** and **Revert** under each change. Accepting
  keeps the change and clears the highlight. Reverting restores that change alone. Your own unsaved
  edits to a file under review appear as changes too.
- **Ask about code.** Select code in the editor and choose **Ask about this**. The selection joins
  the composer as context, and the composer takes focus.

Go to definition, diagnostics, and other language intelligence are not part of IDE mode yet.
