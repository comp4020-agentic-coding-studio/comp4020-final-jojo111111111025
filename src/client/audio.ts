/**
 * Loads the game's sound effects and background music, and exposes
 * `playSound()` (one-shot SFX) plus `startBgm()`/`setBgmZone()` (a
 * continuous looping track). Same load-once, fail-silently shape as
 * sprites.ts's loadSprites/getImage — a sound that hasn't finished loading
 * (or failed to) just doesn't play, the rest of the game still runs. See
 * public/assets/CREDITS.md for each clip's source and license (all CC0).
 */
export type SoundName =
  | "swordAttack"
  | "death"
  | "gather"
  | "craftSuccess"
  | "chestOpen"
  | "actionError"
  | "victory";

const SOUND_PATHS: Record<SoundName, string> = {
  swordAttack: "/assets/audio/sword-attack.ogg",
  death: "/assets/audio/death.ogg",
  gather: "/assets/audio/gather.ogg",
  craftSuccess: "/assets/audio/craft-success.ogg",
  chestOpen: "/assets/audio/chest-open.ogg",
  actionError: "/assets/audio/action-error.ogg",
  victory: "/assets/audio/victory.wav",
};

/** One continuous looping track per zone — the overworld's own calm ambience, the dungeon's own cave/wind atmosphere. */
export type BgmZone = "overworld" | "dungeon";

const BGM_PATHS: Record<BgmZone, string> = {
  overworld: "/assets/audio/bgm-overworld.mp3",
  dungeon: "/assets/audio/bgm-dungeon.ogg",
};

/** Background music plays quieter than a foreground sound effect — it's meant to sit under the game, not compete with a sword hit or a pickup chime — but still audible, not just a faint hint of ambience. */
const BGM_VOLUME = 0.4;

const buffers = new Map<SoundName, HTMLAudioElement>();

/**
 * Starts loading every clip exactly once; safe to call repeatedly. Unlike
 * loadSprites, there's no returned promise to await — nothing in the game
 * blocks on audio being ready, a clip that hasn't loaded yet by the time
 * it's first played is handled the same as one that failed to load at all
 * (see playSound).
 */
export function loadSounds(): void {
  if (buffers.size > 0) return;
  for (const [name, path] of Object.entries(SOUND_PATHS) as Array<[SoundName, string]>) {
    const audio = new Audio(path);
    audio.preload = "auto";
    buffers.set(name, audio);
  }
}

/**
 * Plays a loaded clip from the start. Browsers only allow audio playback
 * after a user gesture (a keypress or click) has occurred on the page —
 * play() rejects with a thrown/rejected promise until then, and the catch
 * here silently swallows that (and any other playback error, e.g. a clip
 * that never finished loading) rather than letting it surface as an
 * unhandled rejection. Cloning the node (rather than reusing the one
 * `buffers` holds and calling `.play()` directly) lets the same sound
 * overlap itself — e.g. two gather hits landing within the same clip's
 * duration both get heard, instead of the second cutting the first off.
 */
export function playSound(name: SoundName): void {
  const base = buffers.get(name);
  if (!base) return;
  const instance = base.cloneNode(true) as HTMLAudioElement;
  instance.volume = base.volume;
  instance.play().catch(() => {});
}

const bgmPlayers = new Map<BgmZone, HTMLAudioElement>();
let currentBgmZone: BgmZone | null = null;
let bgmStarted = false;

/**
 * Starts the game's background music, one continuous looping track per
 * zone — unlike playSound's one-shot clips (which clone a node per play so
 * overlapping triggers don't cut each other off), BGM keeps a single
 * long-lived `<audio loop>` element per zone, since there's only ever one
 * track playing (or about to play) at a time. Call once, after the first
 * user gesture the page has seen (e.g. the join button's click handler) —
 * calling it before that gesture is harmless (play() rejects and is
 * swallowed, same as playSound), it just means no music starts until the
 * next call. Defaults to the overworld zone; setBgmZone switches it.
 */
export function startBgm(): void {
  if (bgmStarted) return;
  bgmStarted = true;
  for (const [zone, path] of Object.entries(BGM_PATHS) as Array<[BgmZone, string]>) {
    const audio = new Audio(path);
    audio.loop = true;
    audio.volume = BGM_VOLUME;
    bgmPlayers.set(zone, audio);
  }
  setBgmZone("overworld");
}

/**
 * Switches which zone's track is audibly playing — pauses whichever track
 * was playing (resetting it to the start, so re-entering the same zone
 * later doesn't resume mid-track) and plays the new zone's, muted-autoplay
 * restrictions permitting (see startBgm's doc-comment; the same
 * catch-and-swallow as playSound applies here). A no-op if the requested
 * zone is already the one playing, so main.ts can call this on every
 * world.snapshot/player.state without needing to track "did the zone
 * actually change" itself.
 */
export function setBgmZone(zone: BgmZone): void {
  if (zone === currentBgmZone) return;
  const previous = currentBgmZone ? bgmPlayers.get(currentBgmZone) : undefined;
  if (previous) {
    previous.pause();
    previous.currentTime = 0;
  }
  currentBgmZone = zone;
  const next = bgmPlayers.get(zone);
  next?.play().catch(() => {});
}
