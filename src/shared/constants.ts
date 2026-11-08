export const TILE_SIZE = 16;
export const MAP_WIDTH = 128;
export const MAP_HEIGHT = 128;

export const TICK_RATE_HZ = 20;
export const TICK_MS = 1000 / TICK_RATE_HZ;

export const SNAPSHOT_RATE_HZ = 10;
export const SNAPSHOT_MS = 1000 / SNAPSHOT_RATE_HZ;

export const PLAYER_SPEED_TILES_PER_SEC = 4;
export const PLAYER_RADIUS = 0.3;

export const GATHER_RANGE_TILES = 1.5;
export const BUILD_RANGE_TILES = 2.5;

export const ITEM_STACK_LIMIT = 99;

export const MAX_PLAYERS = 4;

export const DEFAULT_WORLD_SEED = "last-shelter-dev-seed";

/** Single-shared-world stand-in for "room creation/joining" — a fixed code validated on every join. */
export const DEFAULT_ROOM_CODE = "LAST-SHELTER";

/** How long a disconnected player's room slot is held before being freed for someone else. */
export const RECONNECT_GRACE_MS = 5 * 60 * 1000;

// --- Survival --------------------------------------------------------------

export const MAX_HEALTH = 100;
export const BASE_ATTACK_DAMAGE = 10;
export const SWORD_BONUS_DAMAGE = 15;
export const ATTACK_RANGE_TILES = 1.2;
export const ATTACK_COOLDOWN_MS = 600;

/** How much health a bandage restores (clamped at MAX_HEALTH, never wasted on overheal beyond that). */
export const BANDAGE_HEAL_AMOUNT = 30;

/** Per-gather yield for wood/stone — doubled while holding the matching tool (axe for wood, pickaxe for stone). */
export const BASE_GATHER_YIELD = 1;
export const AXE_WOOD_YIELD = 2;
export const PICKAXE_STONE_YIELD = 2;

/**
 * How many times a single axe/pickaxe/sword can apply its effect before it
 * breaks and is removed from inventory — an axe-boosted gather, a
 * pickaxe-boosted gather, and a sword-boosted attack each count as one use
 * of that tool. Tracked per-player as in-memory simulation state (the same
 * category as attack cooldown), not per physical item, so holding more than
 * one of the same tool just means the next one is full strength the instant
 * the current one breaks.
 */
export const TOOL_DURABILITY_USES = 10;

// --- Day/night (every enemy aggros unconditionally regardless of time of
// day, since the "kill everything to win" redesign — see room.ts's
// tickEnemy. The one gameplay effect night still has is
// WANDERER_NIGHT_SPEED_MULTIPLIER, above; everything else here is purely
// visual/ambience.) ----------------------------------------------------

/**
 * Time-of-day is derived purely from elapsed wall-clock time since the
 * world was created (`world.created_at`) — no ticking, no persisted
 * "current time of day" field, so a restart can't desync it.
 */
export const DAY_DURATION_MS = 5 * 60 * 1000;
export const NIGHT_DURATION_MS = 2 * 60 * 1000;
export const DAY_NIGHT_CYCLE_MS = DAY_DURATION_MS + NIGHT_DURATION_MS;

// --- Enemies -----------------------------------------------------------------

export const WANDERER_MAX_HEALTH = 30;
export const WANDERER_CONTACT_DAMAGE = 5;
/** Slower than every other enemy and well under the player's own 4 tiles/sec — every enemy chases unconditionally the instant it exists (no aggro range, no leash), so a low chase speed is what keeps a wanderer escapable on foot rather than an inevitable hit. */
export const WANDERER_SPEED_TILES_PER_SEC = 1;
/** Wanderers alone move faster at night — the one piece of day/night that isn't purely visual/ambience (see the block comment above). Guardians and the boss are unaffected. */
export const WANDERER_NIGHT_SPEED_MULTIPLIER = 1.5;
export const CAMPFIRE_SAFE_RADIUS_TILES = 3;

export const GUARDIAN_MAX_HEALTH = 60;
export const GUARDIAN_CONTACT_DAMAGE = 10;
export const GUARDIAN_SPEED_TILES_PER_SEC = 1.5;

export const BOSS_MAX_HEALTH = 300;
export const BOSS_WINDUP_MS = 1200;
export const BOSS_ATTACK_RADIUS_TILES = 2;
export const BOSS_ATTACK_DAMAGE = 25;
export const BOSS_COOLDOWN_MS = 3000;
/** Slower than a guardian — the boss chases like every other enemy, but its real danger is the telegraphed AoE it opens up once in range, not out-walking a fleeing player. */
export const BOSS_SPEED_TILES_PER_SEC = 1.2;

/** Minimum time between an enemy's contact-damage hits on the same player, so standing in an enemy doesn't melt health every tick. */
export const ENEMY_CONTACT_COOLDOWN_MS = 800;
export const ENEMY_CONTACT_RANGE_TILES = 0.8;
