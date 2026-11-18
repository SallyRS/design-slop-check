---
name: design-slop-check
description: Check an HTML web page or an HTML slide deck against the AI slop design list (88 patterns, from eyebrow labels and purple-to-blue gradients to takeaway banners and bullets-left-image-right slides) and write one fix list, with the pattern number and name, location, evidence and a concrete fix for each finding, ready for another agent to work through. Recheck after fixes. Use whenever someone asks to check a page, landing page, site, mockup or HTML deck for AI slop, "does this look AI-generated", "slop check this design", "run the design slop check", "audit this page against the slop list", "what makes this look generic", or wants a fix list for an HTML page or deck before it ships, even if they don't say "slop". Flags only; it does not redesign. Not for PowerPoint, Google Slides, PDFs or images alone, and not for checking writing (use a writing checker for copy).
---

# Design Slop Check

Find every pattern from the AI slop design list (linked in the README) on an HTML page or HTML deck, and hand back one fix list. You flag and explain; you don't redesign the page. The fix list is written for another agent to work through, so every item needs a place it can find and a fix it can act on.

The list has 88 patterns, plus one extra check, #101 (content pushed to the top or bottom of a slide; it is not on the published list and always goes to "confirm first"). Each one is checked one of three ways:

- **Scripts** (`scripts/check.mjs`): reads the HTML and CSS and renders the page in headless Chrome to read computed styles and layout.
- **impeccable's detector**, if the impeccable plugin (https://impeccable.style) is installed. If it is installed in an unusual place, set `IMPECCABLE_BIN` to its executable. The script calls it and maps its rule ids to the pattern numbers.
- **Your judgement**, for the 13 patterns a script can't decide (default hero, stock page order, mixed number formats, generic 3D imagery, AI clip-art, and so on), using the screenshots and page facts the script saves.

`scripts/patterns.json` holds all 88 patterns plus the extra #101 (marked `"extra": true`): number, the pattern name, the slides name where it differs, scope (web, slides or both), how it is checked, the one-line description and the default fix.

## Inputs

An HTML file, a folder of HTML files, or a URL (local server or `file://`). Decks are found automatically (reveal.js, `.slide`, `section.slide`, `[data-slide]`, `.deck > section`). Each slide is checked as its own page. If a deck isn't detected, pass `--slides "<css selector>"` or `--mode slides`.

## Step 1: run the scripts

```bash
node <skill-dir>/scripts/check.mjs <file|folder|url> --out <report-dir>
```

Useful options: `--brand "#1f5f4a,#e8b04b"` turns on the off-brand color check (#79, decks only); `--viewport 1440x900` and `--slide-viewport 1600x900` set the screen size; `--mode web|slides`; `--compare <old report.json>` for a recheck. Needs Node 22+ and Chrome or Chromium (set `CHROME_PATH` if Chrome isn't in the usual place). Nothing to install.

It writes, in `<report-dir>`:
- `report.md` and `report.json`: the fix list so far
- `screenshots/`: for web, the first screen, the full page, and a full-size close-up of each section and each large image; for decks, one image per slide
- `judgement-pack.md`: the facts you need for Step 2 (sections in order, h1, buttons, every number, groups of three, images, modals, the copy)
- `judgement.json`: an empty file for your calls

Check the "Read as" line at the top of report.md. A page with a `.slide` carousel can be misread as a deck, and an unusual deck as a web page; rerun with `--mode web` or `--mode slides` if so.

If Chrome or impeccable is missing, the script still runs what it can and the report says which patterns were not checked. Say so to the person; don't fill the gap by guessing.

## Step 2: the judgement review

This step needs a model that can read images (Sonnet or Opus class). A smaller model may run Step 1 and hand the report to a stronger one. Read `references/judgement-guide.md`, then `judgement-pack.md`, then look at every screenshot with the Read tool (all slides of a deck, not a sample). The full-page screenshot is shrunk when you view it, so read details (text inside images, small labels, logos) from the close-ups the pack lists. Three jobs:

1. **Confirm or dismiss** each script finding marked "confirm first" (`confidence: review`). These are real measurements that need a human-level call, for example whether an accent color really covers everything or whether four similar slides are one template.
2. **Judge** the patterns listed under "Patterns to judge" in the pack.
3. **Sanity-check the rest.** Every other finding is a measurement and is usually right, but impeccable reads static CSS and can misjudge what's behind an element (for example, calling a faint shadow on a white slide a "glow" because the page behind the slides is dark). When a screenshot plainly contradicts a finding, dismiss it with the reason. Don't re-litigate findings the screenshot agrees with.

Write what you decide to `judgement.json`:

```json
{
  "add": [
    {"pattern": 3, "page": "site/index.html", "selector": "header.hero", "evidence": "Centered 'The modern platform for modern teams', one subline, a filled and an outline button, then a gray logo row", "fix": "optional: a fix specific to this page"}
  ],
  "confirm": ["F012"],
  "dismiss": [{"id": "F031", "reason": "The cream background is the client's printed brand color"}],
  "judged": [{"pattern": 9, "reason": "Sections run tool list, how borrowing works, hours: an order set by the content"}, 13, 32],
  "still": []
}
```

- `page` must be the page label exactly as the report shows it. Use `slide` (a number) for decks.
- Evidence quotes what is on the page (the headline text, the numbers, the slide). A reader should be able to check it without your screenshot.
- Put every pattern you looked at in `judged`, including the ones you found clear. Give a one-line reason for the ones you clear (`{"pattern": 9, "reason": "..."}`); the report shows it, so a reader can see what was looked at.
- A problem that fits no pattern on the list goes in your reply, not in the fix list. A pattern you didn't look at stays "not checked" in the report, which is the honest result.
- Flag a judgement pattern only when you'd defend it to the page's designer. When it's a close call, leave it out and mention it in your reply instead. The fix list should not send another agent off to change things that are fine.

Then merge:

```bash
node <skill-dir>/scripts/check.mjs --merge <report-dir>/judgement.json --report <report-dir>/report.json
```

If the merge prints entries it could not use, fix them and merge again.

## Step 3: hand back the fix list

Give the person the path to `report.md` and a short summary: the count first, the most visible problems, and anything not checked and why. Don't paste the whole report into chat. Don't start fixing the page unless they ask; this skill flags.

If they say the fix list is going to another agent, `report.json` is the structured version: each finding has `id`, `pattern`, `name`, `location` (page, slide, selector, line), `evidence`, `fix` and `confidence`.

## Recheck after fixes

Run the script again with `--compare <old report.json>` into a new folder, then redo Step 2. The pack lists last run's judgement findings by id: put the ones still on the page in `still` (they are carried over and paired up); the ones you leave out count as fixed. The report leads with fixed, still there and new.

## What the scripts can't check

- #79 Off-brand colors (decks) needs brand colors (`--brand`). Without them it is listed as not checked.
- #64 Text baked into an image, #81 Garbled text in images and #80 Approximated logo depend on reading the image; they are judgement calls on the screenshots.
- #14 Design drift between pages needs more than one page (give a folder) or a deck.
- Canvas charts and cross-origin images can't be read pixel by pixel, so #65 and #72 only see SVG and HTML charts and same-origin images.
- Layout thresholds (empty space, equal cards) are tuned for desktop screens. For a phone view, run again with `--viewport 390x844`, and expect some layout findings to change.
