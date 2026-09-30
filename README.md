# Paragraph Swipe

WARNING: the plugin is in the active development and testing phase; anything can happen.

Sort your thoughts with comfort!

Swipe right on a paragraph → a compact picker window with your notes → the paragraph is
moved to the **end** of the note you picked.

Made for **Android** (touch screen, no keyboard).

## Usage

Swipe right on paragraph that you want to send to another file. Choose destination. Done.

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

