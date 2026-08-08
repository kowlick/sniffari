# Chibi people-with-treats worklog

## Status

Complete. The first `ENTITIES.md` priority has been designed and packaged: eight distinct people-with-treats characters, each with an exact 4 x 3 state sheet. All eight generated sheets were visually reviewed, normalized to transparent RGBA, and assembled into `public/art/people-chibi.png`.

The portable layout and integration contract is documented in `art/chibi-entities/HANDOFF.md`. This file retains the generation-source record for provenance. Runtime atlas SHA-256: `2C70B29F133A5165CA58DC5EC0ADB27B4441A917C6DCFA3289FCBD1A0CE29C21`.

## Selected generated sources

Base directory:

```text
C:\Users\Daniel Chan\.codex\generated_images\019fde68-7477-74b0-b5e0-5b850bf243c4
```

| Cast row | Character | Selected source file |
|---:|---|---|
| 0 | Kid with treat bag | `exec-ecd16420-3dd6-4fc7-bb80-a09d026fadb5.png` |
| 1 | Jogger with belt pouch | `exec-99d6758b-a1d1-4abc-8e86-59b12e606790.png` |
| 2 | Older neighbor with walking stick | `exec-c0d6d85a-84b6-421e-9f27-cfcf212b258a.png` |
| 3 | Barista with puppuccino | `exec-ff22aa97-75ae-4875-a5cb-b508dd2dab23.png` |
| 4 | Skateboarder | `exec-5c6301e8-46cd-4874-8a02-7e55f146ddc7.png` |
| 5 | Parent with pram | `exec-63fdc7ea-1283-4983-96c0-a3cf73b8350a.png` |
| 6 | Cyclist | `exec-806a8a90-b7c8-4619-b914-87e3f646e219.png` |
| 7 | Picnicker | `exec-5ce156b5-f08b-4be4-9d53-81e435638950.png` |

## Generated-sheet layout

Every selected source is an exact 4 columns x 3 rows sheet:

| Source row | State | Frames |
|---:|---|---|
| 0 | Idle, has treat | 4-frame subtle bob/look loop |
| 1 | Giving | 4 sequential frames: notice, crouch/lean, extend treat, finish handoff |
| 2 | Given/empty | Two unique poses repeated A-B-A-B: empty/closed treat source, friendly wave |

Each logical cell contains one complete character plus only that character's persistent role prop. All sheets use a flat green chroma background and need local background removal.

## Packaged deliverables

```text
art/chibi-entities/people-sheets/00-kid.png
art/chibi-entities/people-sheets/01-jogger.png
art/chibi-entities/people-sheets/02-older-neighbor.png
art/chibi-entities/people-sheets/03-barista.png
art/chibi-entities/people-sheets/04-skateboarder.png
art/chibi-entities/people-sheets/05-parent-pram.png
art/chibi-entities/people-sheets/06-cyclist.png
art/chibi-entities/people-sheets/07-picnicker.png
public/art/people-chibi.png
art/chibi-entities/people-preview.jpg
```

Normalized character sheets should be **1024 x 1536 RGBA** with **4 x 3 cells of 256 x 512 px**. Preserve aspect ratio; do not stretch the original logical cells. Crop each visible character/prop group, scale uniformly to fit within about 232 px width and 424 px visible height, center horizontally, and place the ground/contact baseline near `y = 436` (85% of 512).

The runtime atlas should be **1536 x 2048 RGBA**, with **12 columns x 8 rows** of **128 x 256 px** cells:

```text
atlas_row = cast row
atlas_column = state * 4 + frame
```

Column blocks:

- 0-3: idle / has treat
- 4-7: giving
- 8-11: given / empty / wave

Use `anchor: "foot"` and `footRatio: 0.85` with `drawCell()`. Because each runtime cell is 128 x 256, the person renders one tile wide and two tiles high while planting on the normal ground line.

## Transparency cleanup

Use the installed helper on each selected source before normalization:

```text
python C:\Users\Daniel Chan\.codex\skills\.system\imagegen\scripts\remove_chroma_key.py \
  --input <source> \
  --out <alpha-output> \
  --auto-key border \
  --soft-matte \
  --transparent-threshold 12 \
  --opaque-threshold 220 \
  --despill
```

If visual inspection shows a one-pixel green fringe, retry once with `--edge-contract 1`. Clear hidden RGB in fully transparent pixels before LANCZOS resampling, and remove any remaining visibly green-dominant pixels because no character uses green chroma as an intentional color.

## Art direction

The style matches the accepted chibi dog set:

- huge rounded head, compact bean-like torso, tiny limbs
- thick smooth dark-chocolate outline
- clean flat colors and minimal facial features
- expressive personality through posture, eyes, smile, and role prop
- no text, logos, scenery, baked shadow, or second character

Distinct gameplay reads:

- Kid: yellow treat pouch, enthusiastic junior dog expert
- Jogger: belt pouch, upbeat mid-run pause
- Older neighbor: walking stick plus biscuit pocket/tin, patient and kind
- Barista: plain puppuccino cup, cozy café energy
- Skateboarder: teal board and jacket pocket, relaxed/cool
- Parent: navy pram and coral pouch, cheerful multitasker
- Cyclist: turquoise bicycle and helmet, energetic adventurer
- Picnicker: yellow blanket and wicker basket, serene animal lover

## Next work after packaging

Per `art/ENTITIES.md`, the next priorities are:

1. Squirrel-in-tree idle/chased/gone animation
2. Tuckered-out four-frame dog loop
3. Sniff-spot state/animation variants
