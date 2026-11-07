/**
 * Loads the game's sound effects and exposes a single `playSound()` call.
 * Same load-once, fail-silently shape as sprites.ts's loadSprites/getImage —
 * a sound that hasn't finished loading (or failed to) just doesn't play,
 * the rest of the game still runs. See public/assets/CREDITS.md for each
 * clip's source and license (all CC0).
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
