# Art and audio asset credits

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
  repeating pattern. (`water` is sprited as of Stage 5, from a different
  pack — see below.)

## LimeZu — Serene Village (revamped)

- `serene-village/terrains.png` — from [Serene Village - revamped - RPG
  Tileset \[16x16\]](https://limezu.itch.io/serenevillagerevamped) by
  LimeZu, free download, file `Serene_Village_revamped_v1.9.zip` →
  `RPG_MAKER_MV/Terrains_TILESET_B-C-D-E.png`. The original 768x768 canvas
  is kept unmodified; `src/client/sprites.ts`'s `TERRAIN_SPRITES` and
  `WATER_GRASS_EDGE_SPRITE` each draw a specific 16x16 sub-region of it —
  this sheet is laid out as hand-painted scene fragments, not a
  systematically-authored RPG-Maker A2 autotile grid (verified by
  programmatic scan, not assumed — see `PROCESS.md`'s Stage 5 section), so
  each coordinate used here was individually confirmed, not derived from a
  formula.
- **License: CC-BY 4.0.** Attribution is required.

  > Serene Village - revamped by LimeZu (https://limezu.itch.io/serenevillagerevamped),
  > used under CC-BY 4.0 (https://creativecommons.org/licenses/by/4.0/).

  Confirmed from the page's own licence badge (a formal "Creative Commons
  Attribution 4.0 International" declaration, not inferred from a comment)
  and the author's own direct reply confirming edits are permitted.
- Used for `grass` and `water` (`TERRAIN_SPRITES`, replacing/filling the
  two gaps Stage 1/2/4 left — see `PROCESS.md`'s Stage 5 section for why
  those specific two, and why `forest`/`rock` deliberately did **not**
  move to this pack), and for a single water/grass boundary tile
  (`WATER_GRASS_EDGE_SPRITE`, drawn in one of four rotations so a grass
  tile next to water gets a soft edge instead of a hard colour cut — see
  `src/client/sprites.ts`'s own doc-comment for exactly what is and isn't
  covered, including why there's no corner variant). This pack also ships
  a 14-frame animated water-wave variant and a rock-pile object sprite;
  neither is used in this stage — the wave animation would require an
  animation system (explicitly out of scope), and the rock candidate was
  not evaluated against the existing `rock` terrain/object decisions in
  this pass.

## Kenney — Interface Sounds

- `audio/craft-success.ogg` (from `confirmation_001.ogg`), `audio/chest-open.ogg`
  (from `open_002.ogg`), `audio/action-error.ogg` (from `error_002.ogg`) — from
  the [Interface Sounds](https://opengameart.org/content/interface-sounds) pack
  by Kenney (www.kenney.nl), 104-file download (`kenney_interfaceSounds.zip`,
  mirrored on OpenGameArt), file `Audio/confirmation_001.ogg` /
  `Audio/open_002.ogg` / `Audio/error_002.ogg` respectively. Each file is used
  unmodified.
- **License: CC0.** Public domain, free for personal or commercial use, no
  attribution required. Confirmed from two independent sources: (1) the
  OpenGameArt page's own structured "License(s)" field states "CC0"; (2) the
  zip's own bundled `License.txt` states the same in its own words
  ("Creative Commons Zero, CC0 ... free to use in personal, educational and
  commercial projects").

## StarNinjas — sword and coin sound effects

- `audio/sword-attack.ogg` (from `sword.3.ogg`) — from [20 Sword Sound
  Effects (Attacks and
  Clashes)](https://opengameart.org/content/20-sword-sound-effects-attacks-and-clashes)
  by StarNinjas, one of ten attack variants in the pack's
  `sword_-_starninjas_1.zip`, used unmodified. The pack's other ten
  variants, and its separate ten-variant `sword_clash_-_starninjas_0.zip`
  (a block/parry-style clash sound), were downloaded and evaluated but are
  **not** used — the game has no block/parry mechanic for the clash sound
  to attach to.
- `audio/gather.ogg` (from `coin.7.ogg`) — from [12 Coin Sound
  Effects](https://opengameart.org/content/12-coin-sound-effects) by the same
  author, file `coins_-_starninjas.zip`, one of twelve variants used
  unmodified.
- **License: CC0.** Confirmed from the OpenGameArt page's own structured
  "License(s)" field on each of the two pages, which states "CC0" with a
  link to the CC0 1.0 deed. No bundled license file ships inside these
  particular zips — the page's own structured field is the evidence here, the
  same standard already used for Stage 4's bush sprite's itch.io field.

## MrGrs — Dead Sound Effect

- `audio/death.ogg` (from `deadsound.ogg`) — from [Dead Sound
  Effect](https://opengameart.org/content/dead-sound-effect) by MrGrs, a
  single `.ogg` file, used unmodified.
- **License: CC0.** Confirmed from the OpenGameArt page's own structured
  "License(s)" field, which states "CC0".

## cynicmusic — Victory Fanfare Short

- `audio/victory.wav` (from `Heavy_ConceptB.wav`) — from [Victory Fanfare
  Short](https://opengameart.org/content/victory-fanfare-short) by
  cynicmusic, a single `.wav` file (~12s orchestral fanfare), used
  unmodified.
- **License: CC0.** Confirmed from the OpenGameArt page's own structured
  "License(s)" field, which states "CC0".
- A second CC0 candidate — [Glorious victory fanfare
  NES](https://opengameart.org/content/glorious-victory-fanfare-nes) by
  congusbongus, a shorter 8-bit/chiptune-style fanfare — was evaluated
  alongside this one and not used; this orchestral fanfare was chosen
  instead for the beacon-activation victory screen.

## TinyWorlds — Forest Ambience

- `audio/bgm-overworld.mp3` (from `Forest_Ambience.mp3`) — from [Forest
  Ambience](https://opengameart.org/content/forest-ambience) by
  TinyWorlds, a single `.mp3` file, used unmodified. Loops continuously
  while the local player is in the overworld.
- **License: CC0.** Confirmed from the OpenGameArt page's own structured
  "License(s)" field, which states "CC0". The author's own description on
  the page ("It loops seamlessly and is ready to be used in your
  projects!") was also checked before relying on `audio.ts`'s plain
  `loop = true` to handle the repeat.
- Two other CC0 candidates — [Heavenly Loop](https://opengameart.org/content/heavenly-loop)
  (isaiah658, a dreamier synth-pad ambience) and [Overworld
  Theme](https://opengameart.org/content/overworld-theme-0) (Louswan, an
  upbeat 8-bit/chiptune melody) — were downloaded and compared directly (a
  local listening page serving all three) before this calmer, less
  attention-grabbing ambience track was chosen for a track meant to loop
  for the entire length of a play session.

## JaggedStone — Loopable Dungeon Ambience

- `audio/bgm-dungeon.ogg` (from `dungeon_ambient_1_0.ogg`) — from
  [Loopable Dungeon Ambience](https://opengameart.org/content/loopable-dungeon-ambience)
  by JaggedStone, a single `.ogg` file (wind/water-drip cave atmosphere),
  used unmodified. Loops continuously while the local player is in the
  dungeon, replacing the overworld track for the duration.
- **License: CC0.** Confirmed from the OpenGameArt page's own structured
  "License(s)" field, which states "CC0".
