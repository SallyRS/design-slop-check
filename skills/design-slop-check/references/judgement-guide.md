# Judgement guide

How to decide the patterns a script can't settle. For each: what counts, what doesn't, and where to look in the judgement pack. Sally's one-line description is in `scripts/patterns.json` if you need her exact words.

The bar for every call: would the page's designer, shown your evidence, agree the pattern is there? If you'd need to argue, leave it out and mention it in your reply instead.

## Patterns only you can judge

**#3 Default hero** (web and slides). Counts: the first screen is a centered headline, one line of subtext, a filled button plus an outline button, then a gray logo row, with nothing only this product could show. Doesn't count: a centered headline paired with a real product screenshot, a specific number with a source, or a first screen built around the product. Look at: the first-screen screenshot, `h1`, the first section's buttons.

**#9 Stock page order** (web). Counts: the sections run hero, logo row, three features, stats, three pricing tiers, call to action, four-column footer (most of that order, with little else). Doesn't count: a page that has some of these sections in an order its content needs. Look at: "Sections in order" in the pack.

**#13 Unneeded modal** (web). Counts: a dialog that opens on load or blocks the page for a small reversible choice (newsletter pop-up on arrival, "change density?" confirm). Doesn't count: dialogs for destructive actions, sign-in, or a form the person opened themselves. Look at: "Modals / dialogs"; "open on load" matters most.

**#32 Mixed number formats** (web and slides). Counts: figures that sit together but disagree on format: cents on one and not the next, a leading zero (03.1%), a space before % on one only, "k" on one and "000" on another, mixed currency placement. Doesn't count: different units that need different formats (a percentage next to a count). Look at: "Numbers on the page", then the screenshot for which ones sit together.

**#42 Look picked by category** (web). Counts: the look is the stock one for the product's category and nothing about it comes from this brand: wellness on cream and serif, developer tools on black and neon, finance in navy and gold. Needs you to know the category from the copy. Doesn't count: a brand that uses those colors as its own established identity (say so if the person tells you). Use sparingly; it overlaps #35 and #36, which the scripts check.

**#62 Glossy 3D hero orb / Generic 3D imagery** (web and slides). Counts: a glowing glass sphere, chrome blob, abstract 3D shape or floating render standing where the product or a real photo should be. Look at: the images list and screenshots.

**#63 AI clip-art** (web and slides). Counts: glowing brains, circuit-board lines, robots, network-of-dots globes, standing for "AI". Look at: images and screenshots.

**#64 Text baked into an image** (web and slides). Counts: a headline, logo, fake button or label drawn inside a picture instead of written as live text. Open each image close-up from the pack; compare with the page copy (text in the image won't be in the copy).

**#69 Generic product mockup** (web). Counts: a made-up dashboard of gray boxes, a generic bar chart, a chat bubble, with nothing from the real product. Doesn't count: a real screenshot of the product, even if simple.

**#75 Gradient sparkle logo** (web and slides). Counts: a purple-to-blue tile with a sparkle or star mark, often with a gradient wordmark. Look at: "Logos" and the top-left of the first screenshot.

**#80 Approximated logo** (web and slides). Counts: a logo that looks redrawn from memory: wrong shape, misspelled name, off proportions. Only call it when you know the real mark or the page shows the real one elsewhere to compare.

**#81 Garbled text in images** (slides). Counts: misspelled, doubled or letter-like shapes inside an image. Open the slide screenshot for every image with text-like marks and read it at full size.

**#86 Groups of three by habit** (web and slides). Counts: a group of three where one item is vague padding ("Drive innovation across the business", "And much more") next to two real points. Doesn't count: three real, distinct items. Look at: "Groups of exactly three" and judge the weakest item on its own.

## Script findings marked "confirm first"

These are measured, but the measurement can't tell intent. Confirm (add the id to `confirm`) or dismiss (add it to `dismiss` with a reason).

- **#18 A visual on every section**: confirm when the images are decoration repeated by habit; dismiss when each picture shows something the section needs (a product step, a person quoted).
- **#45 Everything highlighted**: confirm when the accent shows up on most headings, icons, rules and tags so nothing stands out; dismiss when the accent is limited and the count came from one component (for example a chart's own colors).
- **#66 Captions and disclaimers under images**: confirm captions that restate or apologize; dismiss real credits or captions that add information.
- **#77 Repeated templates**: confirm when the slides or sections really share one layout by habit; dismiss when the repeat is a deliberate series (for example one slide per region with the same comparison).
- **#78 Perfect sameness**: confirm when nothing on the slide is bigger, bolder or placed to lead; dismiss when one item clearly leads.
- **#79 Off-brand colors**: confirm when the image's main color is visibly near the brand color but off; dismiss photos whose colors aren't trying to be the brand's.
- **#101 Content pushed to the top or bottom** (an extra check, not on Sally's list): open the slide screenshot named in the finding. Confirm when the content is shoved up under the heading (or down toward the footer) and one side is a big empty band while the other has almost no space, or when most slides in the deck lean the same way. Dismiss when the content is placed on purpose: it is anchored to a bottom strip or a footer element, it is a chart or table that reads best starting right under its title, or the empty side is small next to the content. A single odd slide is worth confirming only when the rest of the deck sits centred between the heading and the footer.

## Spacing under the heading

The normal space between a slide's heading and its content is good spacing. Don't report it on its own, and don't call it an "empty band" or file it under #20 (Dead empty space). #20 is a small block floating in a mostly empty slide, nothing more.

Report placement only when the content looks lopsided against the area it has to live in (the space between the heading block and the footer) and against the rest of the deck: everything shoved up under the title with a big empty area at the bottom, everything pushed down, or one slide placed differently from a deck whose other slides are centred. The script measures this as #101 and sends it as "confirm first"; judge it by eye on the slide screenshot. Never suggest pinning content under the title as the fix for spacing; the fix for a lopsided slide is to centre the content in that area or spread it to fill it.

## Writing a good entry

- Evidence quotes the page: the exact headline, the numbers side by side, the slide number and what is on it.
- The fix says what to change on this page, in one or two sentences. Leave `fix` out to use the pattern's default fix.
- One entry per place. If the same pattern appears on four slides, use `slides: [3, 5, 6, 8]` in one entry, or one entry per slide if the fixes differ.
