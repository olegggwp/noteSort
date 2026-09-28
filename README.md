# Paragraph Swipe

Swipe right on a paragraph → a compact picker window with your notes → the paragraph is
moved to the **end** of the note you picked.

Made for **Android** (touch screen, no keyboard), works on desktop too. The UI is in Russian.

```
A paragraph that stays here

This paragraph is about to move    ← swipe right on it
to another note

The rest of the text
```

## Install

Search for **Paragraph Swipe** in Obsidian → *Settings → Community plugins*.

## Usage

| Trigger | When to use it |
| --- | --- |
| **Swipe right** on a paragraph | the main way, works in any note |
| **Ribbon icon** (right edge) | if the swipe feels unreliable |
| Command `Move paragraph to another note` | desktop, bind your own hotkey |

In the picker: tap a note, or type its name. Fuzzy matching is included (`кт` finds
`Projects/Kotik.md`). If nothing matches, a **"new"** row appears — the file is created
and the paragraph lands there.

After the move you get a toast with **Undo**, which puts the paragraph back byte for byte.
If either file changed in the meantime, it refuses instead of clobbering your edits.

## Settings

| Setting | Meaning |
| --- | --- |
| Swipe right | enable/disable the gesture |
| Swipe threshold | 30–220 px. Higher = fewer false triggers (default 72) |
| Ribbon icon | button on the right edge |
| Use selection | if text is selected, move only the selection |
| Folder filter | limit the list to one folder (empty = whole vault) |

## What counts as a paragraph

A paragraph is a run of consecutive non-empty lines, separated by a blank line. Adjacent
blank lines are collapsed, so no gaps are left behind. If the swipe lands on a blank line,
the nearest non-empty paragraph is taken (preferring the one below) — an imprecise finger
is not a problem.

## Development

Plain ES modules, no build step: `main.js` is what ships.

```bash
npm install
npm run lint     # official Obsidian guidelines (eslint-plugin-obsidianmd)
npm test         # 101 checks, no Obsidian required
```

| Test file | Covers |
| --- | --- |
| `tests/test.js` | paragraph boundaries, blank-line collapsing, fuzzy search, file appending |
| `tests/modal-test.js` | file list, folder filter, "new note" row, tap/arrow/Enter selection |
| `tests/gesture-test.js` | swipe recognition, scroll rejection, screen edges, multi-touch |
| `tests/move-test.js` | writing the file, removing from the editor, undo, conflict refusal |

## License

MIT
