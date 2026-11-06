# Art asset credits

## ansimuz — Tiny RPG Forest & Mountain

- `forest/tileset.png` — from [Tiny RPG - Forest](https://opengameart.org/content/tiny-rpg-forest) by Luis Zuno (@ansimuz)
- `mountain/tileset.png` — from [Tiny RPG Mountain Tileset](https://opengameart.org/content/tiny-rpg-mountain-tileset) by Luis Zuno (@ansimuz)
- **License: CC0.** Public domain, free for personal or commercial use. Credit
  is not required but appreciated — attribution given here as a courtesy.

## Calciumtrice — Dungeon Tileset

- `dungeon/tileset.png` — from [Dungeon tileset](https://opengameart.org/content/dungeon-tileset-1) by Calciumtrice
- **License: CC-BY 3.0.** Attribution is required by this license.

  > Dungeon tileset by Calciumtrice (https://opengameart.org/content/dungeon-tileset-1),
  > used under CC-BY 3.0 (https://creativecommons.org/licenses/by/3.0/).

  Every character and monster sprite in this pack is a single static pose —
  there is no walk, attack, hurt, or death animation included. Last Shelter's
  dungeon characters/enemies are rendered as static sprites for this reason;
  see `docs/adr/` and `PROCESS.md` for how this limitation is handled.

## ansimuz — Tiny RPG Town

- `tiny-rpg-town/bush-2.png` — from [Tiny RPG Fantasy](https://ansimuz.itch.io/tiny-rpg-town)
  (also listed under the title "Tiny RPG Town") by Luis Zuno (@ansimuz), free
  tier, file `tiny-rpg-town-files.zip` → `Assets/Environments/Vegetation
  props/bush-2.png`. The original 30x32 canvas is kept unmodified; only this
  file's own opaque region (`x:3,y:1,w:25,h:30`) is drawn — see
  `src/client/sprites.ts`'s `OBJECT_SPRITES.bush`.
- **License: CC0.** Public domain, free for personal or commercial use, no
  attribution required, no restriction on modification or redistribution.
  Confirmed from three independent sources, not inferred from the author's
  name alone: (1) the itch.io page's own structured "Asset license" field
  states "Creative Commons Zero v1.0 Universal"; (2) the pack's own bundled
  `public-license.pdf` states the same in its own words; (3) the author's
  most recent direct reply to a licensing question in the page's comments
  (superseding an older, inconsistent "CCBy 4" reply from years earlier)
  confirms "CC0". All three evidence sources were saved during Stage 4's
  asset inspection.
- This same pack's tree sprites (`tree-1.png`, `tree-2.png`) and its one
  standalone rock sprite were evaluated and explicitly **not** used — see
  `src/client/sprites.ts`'s `OBJECT_SPRITES` doc-comment and `PROCESS.md`'s
  Stage 4 section for why (scale mismatch for the trees, colour/style
  mismatch for the rock). A water sprite from this same pack's town tileset
  was also evaluated and **not** used — its source art isn't a tileable
  texture, and tiling it at this game's 16px grid produces a visible
  repeating pattern; `water` remains on the pre-existing flat-colour
  fallback.
