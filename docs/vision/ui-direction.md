# UI direction

This is a **brief for the designer** (human or Opus), not a design. It sets the feeling and the
hard constraints, and leaves composition, typography, color, and motion to the person doing the work.
If a better idea serves the feeling, take it.

## Feeling

Modern, minimal, and a little playful. The reference is the **Claude Code Desktop app**: generous
space, quiet chrome, content first, a sense that the tool is getting out of your way. Underneath the
calm there is craft, and ASCII art is where the personality lives.

Words to aim for: *calm, precise, warm, fast, a bit nerdy*.
Words to avoid: *busy, glossy, dashboard-y, gamer, skeuomorphic*.

## ASCII identity

The signature moment is the **empty new conversation**. Like the Claude Code terminal's startup, it
greets you with ASCII art: a distinctive, atmospheric background that makes opening the app feel like
something.

Ideas, not requirements:

- A large piece of ASCII or box-drawing art as the wallpaper of the empty state: a logo, a landscape,
  a machine, something that can be recognized as T3-plus-plus.
- It can be **alive in small, event-driven ways**: a gentle shimmer on load, characters resolving
  into the logo, reacting once to keystrokes or the first message. When you send a message, the art
  recedes and the conversation takes over.
- Variants: seasonal, per project, per workspace, or randomly chosen. Possibly user-supplied.
- ASCII as a **motif beyond the empty state**: spinners, progress bars, box-drawn panels in the
  [git graph](./git-and-source-control.md), tiny glyph status icons, section dividers. A monospaced
  accent face for labels and metadata, paired with a refined text face for reading.
- Restraint matters. ASCII is the seasoning. Long-form reading (transcripts, documents) stays
  typographically excellent.

## Principles

1. **Content first.** The conversation is the page. Panels, toolbars, and controls earn their
   place and recede when not in use.
2. **Progressive disclosure.** A new conversation shows almost nothing. Advanced features
   (layouts, remote control, orchestrator, git) are one gesture or one palette command away, never all
   visible at once.
3. **Keyboard and command palette first.** Every feature in this folder is reachable by palette and
   rebindable keys.
4. **Honest state.** No lying spinners or stale labels. Running, waiting, failed, and done are always
   distinguishable at a glance.
5. **Consistent and few.** A small set of components and variants, per the repo's UI rules
   ([web UI](../internals/web-ui.md)). Features look native to one another.
6. **Themeable.** Light, dark, and custom palettes. The ASCII art must look good in all of them.

## Hard constraints

These come from the project's core values and are not negotiable.

- **Performance.** No continuously repainting animation; they peg the GPU on high-refresh displays.
  Motion is short, event-driven, and uses compositor-friendly properties. ASCII animation must be
  budgeted (render to canvas or limited DOM, cap frame rate, pause when hidden or the window is
  unfocused, and respect reduced-motion).
- **Reduced motion and accessibility.** `prefers-reduced-motion` gets a static version of every
  animation. Meet contrast requirements. ASCII art is decorative: hidden from screen readers
  (`aria-hidden`) and never carries meaning alone.
- **Surfaces.** Web, desktop, and mobile are all in scope. The overhaul defines a shared visual
  language; mobile can adapt layout and gestures but should read as the same product.
- **Remote.** Everything must render well over a slow relay: no large assets in the critical path,
  so the ASCII art should be text or small generated output.
- **Long lists.** Transcript, sidebar, and graph stay virtualized and fast with thousands of items.
- **Density control.** Provide comfortable and compact density settings.

## Areas the redesign touches

- **Shell:** sidebar (projects, folders, nested sessions), header, command palette.
- **Empty state:** the ASCII landing described above.
- **Conversation:** transcript, composer, tool activity, approvals, plans.
- **Panels:** diff, terminal, files, git graph, task board, documents, orchestrator.
- **Layouts:** how saved [layouts](./layouts-workspaces-and-folders.md) and split view look and feel.
- **Settings and onboarding:** simpler, searchable, with a first-run that shows off the ASCII identity.
- **Remote page:** the phone view for [remote control](./remote-control.md).

## What the designer decides

Palette, typefaces, grid, iconography, the actual ASCII art, motion language, and how dense or airy
the result is. Prototype in the app, try it in light and dark, on a phone, over a slow connection, and
with a thousand-message conversation, then keep what survives.
