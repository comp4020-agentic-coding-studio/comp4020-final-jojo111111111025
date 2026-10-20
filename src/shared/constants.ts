export const TILE_SIZE = 16;
export const MAP_WIDTH = 64;
export const MAP_HEIGHT = 64;

export const TICK_RATE_HZ = 20;
export const TICK_MS = 1000 / TICK_RATE_HZ;

export const SNAPSHOT_RATE_HZ = 10;
export const SNAPSHOT_MS = 1000 / SNAPSHOT_RATE_HZ;

export const PLAYER_SPEED_TILES_PER_SEC = 4;
export const PLAYER_RADIUS = 0.3;

export const GATHER_RANGE_TILES = 1.5;
export const BUILD_RANGE_TILES = 2.5;
export const FARM_RANGE_TILES = 2.5;

export const ITEM_STACK_LIMIT = 99;

export const MAX_PLAYERS = 4;

/**
 * Crop growth timing, in milliseconds, for the timestamp-based farming
 * model: a plot's stage is derived from `Date.now() - plantedAt` rather
 * than ticked, so growth continues correctly across restarts and while no
 * browser is open. Short (minutes, not hours) so a course demonstration can
 * actually observe a full growth cycle.
 */
export const CROP_GROWING_MS = 60_000;
export const CROP_MATURE_MS = 120_000;
/** A crop that goes this long without being (re-)watered stops progressing until watered again. */
export const CROP_WATER_VALID_MS = 180_000;

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

/** How close a player must be to a dungeon_entrance/dungeon_exit object to use it. */
export const ZONE_TRANSITION_RANGE_TILES = 1.5;

// --- Day/night ---------------------------------------------------------------

/**
 * Time-of-day is derived purely from elapsed wall-clock time since the
 * world was created (`world.created_at`), the same timestamp-derivation
 * approach `farming.ts`'s computeCropStage already uses — no ticking, no
 * persisted "current time of day" field, so a restart can't desync it.
 */
export const DAY_DURATION_MS = 5 * 60 * 1000;
export const NIGHT_DURATION_MS = 2 * 60 * 1000;
export const DAY_NIGHT_CYCLE_MS = DAY_DURATION_MS + NIGHT_DURATION_MS;

// --- Enemies -----------------------------------------------------------------

export const WANDERER_MAX_HEALTH = 30;
export const WANDERER_CONTACT_DAMAGE = 5;
export const WANDERER_SPEED_TILES_PER_SEC = 2;
export const WANDERER_AGGRO_RANGE_TILES = 4;
export const WANDERER_LEASH_RANGE_TILES = 8;
export const CAMPFIRE_SAFE_RADIUS_TILES = 3;

export const GUARDIAN_MAX_HEALTH = 60;
export const GUARDIAN_CONTACT_DAMAGE = 10;
export const GUARDIAN_SPEED_TILES_PER_SEC = 1.5;
export const GUARDIAN_AGGRO_RANGE_TILES = 5;

export const BOSS_MAX_HEALTH = 300;
export const BOSS_WINDUP_MS = 1200;
export const BOSS_ATTACK_RADIUS_TILES = 2;
export const BOSS_ATTACK_DAMAGE = 25;
export const BOSS_COOLDOWN_MS = 3000;

/** Minimum time between an enemy's contact-damage hits on the same player, so standing in an enemy doesn't melt health every tick. */
export const ENEMY_CONTACT_COOLDOWN_MS = 800;
export const ENEMY_CONTACT_RANGE_TILES = 0.8;

/** Trash enemies (wanderer/guardian) respawn fresh at their spawn point this long after death — in-memory only, not persisted (see Room's enemy-persistence note). */
export const ENEMY_RESPAWN_MS = 30_000;

// --- Beacon victory ------------------------------------------------------------

export const BEACON_REQUIRED_ANCIENT_CORE = 1;
export const BEACON_REQUIRED_WOOD = 20;
export const BEACON_REQUIRED_STONE = 10;
export const BEACON_RANGE_TILES = 2.5;
