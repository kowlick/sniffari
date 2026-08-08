# Animated board-entity worklog

## Status

Complete. Five ImageGen source sheets were generated with the built-in image-generation
tool, reviewed, chroma-keyed to transparent RGBA, normalized, assembled, and wired to real
simulation events.

## Prompt set

Every prompt used `art/chibi-dogs/reference-style.png` and
`art/chibi-entities/people-preview.jpg` as style references only. Shared constraints were:
an exact 4 × 4 logical grid; thick smooth dark-chocolate outlines; clean flat chibi colors;
consistent scale, viewpoint and contact line; no text, logos, watermark, scenery or baked
shadow; and a perfectly flat removable chroma background.

| Sheet | Chroma | Row grammar |
|---|---|---|
| Hydrant | `#00ff00` | fresh, sniffed once, spent, wobble reaction |
| Lamppost | `#00ff00` | fresh flicker, sniffed once, spent/dim, bend reaction |
| Bush | `#ff00ff` | fresh sway, sniffed once, spent, leaf-burst reaction |
| Squirrel tree | `#ff00ff` | idle, chase 1–4, chase 5–8, empty/settling |
| Lake and drain | `#ff00ff` | lake ripple, splash, drain idle, drain reaction |

Generated source IDs:

```text
hydrant: exec-12e42b45-1bf4-4009-a99f-5aa5da018099.png
lamppost: exec-eb675839-1ca9-4543-9297-9cc3fbf452f3.png
bush: exec-cbe22b1c-2996-4b8b-a036-56428758e7d2.png
squirrel tree: exec-fdc1a7da-de67-477a-a7df-4374a5ecf648.png
lake and drain: exec-dd028b7c-9891-4db2-b233-f5186ec68cb8.png
```

## Runtime behavior

- Sniff events now retain both the once-sniffed and spent states on the client.
- Sniff reactions, squirrel chases, splashes and drain reactions are fired from the same
  simulation events that produce their score popup and sound.
- Procedural drawing remains the fallback when an atlas is unavailable or `?art=drawn` is
  requested.
