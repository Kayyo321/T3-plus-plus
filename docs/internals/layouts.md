# Layouts and split view

> For maintainers. Using T3++? See [Layouts, split view, and IDE mode](../user/layouts.md).

## Why a flat tree, not a docking framework

A layout is a split tree with tab groups at its leaves
([`layoutDocument.ts`](../../apps/web/src/layouts/layoutDocument.ts)), and it renders flat:
`flattenLayout` turns the tree into rectangles, and every group, surface, and the chat column are
absolutely positioned siblings under ChatView's root. Nothing nests.

That choice carries the feature's one hard promise. React remounts a child when its parent changes,
so nested split containers would reload whatever crossed between them. Flat siblings keyed by surface
id only change style when a layout applies, which also makes the animation a CSS transition on
geometry. Lengths are `percent + pixels`, so a collapsed group is fixed pixels without measuring the
container, and window resizes run no JavaScript.

The chat column is the one panel that cannot be rendered from the layer: it is ChatView itself. It
takes its rectangle from CSS variables that `ThreadWorkbench` writes on the shared parent, so a
resize drag moves it without rendering ChatView. For the same reason the conversation never stacks
into a tab group.

## Documents hold kinds, not surfaces

Groups route surface _kinds_. A document that named surfaces would carry paths and ids, and could
not apply to another conversation. A tab dragged away from its kind's group is recorded in the live
arrangement's `placements`, which saving does not keep.

The live `ThreadArrangement` sits in the right panel store beside the surfaces it places, because
every existing action (open a file, close a tab) must keep working on it. No caller knows about
groups: `withReconciledArrangement` runs after each store update and keeps per-group state true.
Absent means the plain right panel, so a user who never applies a layout runs none of this.

Terminal and browser tabs need ChatView's session actions, so `applyArrangement` leaves them in
`pendingOpens` and ChatView opens them.

Layouts are per device. Syncing through an environment would put one person's window geometry on a
server several clients share, and a layout's meaning depends on the screen it was made for.

## Split view: panes own their ChatView, the route follows focus

Empty `panes` is the ordinary case and the route drives the one pane directly. Once split, panes
render from [the store](../../apps/web/src/layouts/splitView.logic.ts) and the route follows the
focused pane, in both directions: focusing a pane navigates to it, and a navigation either focuses
the pane showing that conversation or fills the focused one. The URL, sidebar highlight, and global
commands therefore always agree on the conversation that takes input, and nothing else needs to know
about panes.

Panes render targets from the store, never the route, because navigation commits asynchronously: a
focus change would otherwise show the old route's conversation in the new pane for a frame.

An unfocused pane sets `BackgroundThreadContext`, the existing switch for standing down window
shortcuts, plus `InactivePaneContext` for the listeners that switch does not cover. Focus reaching a
pane by pointer must not move DOM focus, or clicking a terminal in it would hand focus to the
composer; the composer-focus effects read `InactivePaneContext` through an effect event for that
reason.

Fixed-position titlebar controls would stack at the window corner, so each pane sets
`contain: layout`, which makes it their containing block.

## Performance

- A pane that is collapsed or does not fit unmounts its ChatView. That ends its projection
  subscription, so hidden panes do not stream; the rail reads one shell atom.
- Transcript cost does not grow as a pane narrows. The timeline is a LegendList with a pixel draw
  distance, so taller wrapped rows mean fewer mounted rows, and `MIN_PANE_WIDTH_PX` sets a floor.
- Linked scrolling adds no per-frame work. It hangs off the turn the minimap already computes, and
  fires only when the leading pane crosses a turn.
- Layout and hunk work has benchmarks in [`performance.bench.ts`](../../apps/web/src/performance.bench.ts).

## Edit review

The baseline is client state, in memory. A file changing under an open editor makes its previous
text the baseline, which works for every provider and mid-turn, before any checkpoint exists. A file
opened after the fact seeds from the latest turn's checkpoint diff. Accept moves the baseline
forward, revert writes the file through the ordinary save session; both are one hunk of
`@pierre/diffs`' resolver over the pair, so there is no hunk state to keep in step with the file.

The client cannot tell an agent's edit from a formatter or a `git pull`, so the UI says "changed",
not "the agent changed".

## Mobile

Mobile does not get layouts. It has one screen's worth of navigation of its own
([mobile navigation](./mobile-navigation.md)), and panel geometry has no meaning there.

## Language intelligence

Deferred. IDE mode's bar is file editing with agent awareness. Reusing the machine's language
servers needs a server-side process model per environment, which is a separate project from this
layout work.
