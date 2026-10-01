# Paragraph Swipe

WARNING: the plugin is in the active development and testing phase; anything can happen.

Sort your thoughts with comfort!

Swipe right on a paragraph → a compact picker window with your notes → the paragraph is
moved to the **end** of the note you picked.

Made for **Android** (touch screen, no keyboard).

## Usage

Swipe right on paragraph that you want to send to another file. Choose destination. Done.

While the finger travels, the paragraph you are moving is cut out of the note and
carried to the right together with your finger, leaving a dashed slot behind. It
glows brighter the closer you are to the threshold. Reach the threshold and it flies
off to the right; let go earlier and it slides back into its slot without doing
anything.

Everything is intuitive.

## Settings

| Setting | Meaning |
| --- | --- |
| Debug | enable/disable the debug tosts |
| Swipe threshold | horisontal trashhold |

## What counts as a paragraph

A paragraph is a run of consecutive non-empty lines, separated by a blank line. Adjacent
blank lines are collapsed, so no gaps are left behind. If the swipe lands on a blank line,
the nearest non-empty paragraph is taken (preferring the one below) — an imprecise finger
is not a problem.

