import {
  ATTACK_COOLDOWN_MS,
  ATTACK_RANGE_TILES,
  AXE_WOOD_YIELD,
  BANDAGE_HEAL_AMOUNT,
  BASE_ATTACK_DAMAGE,
  BASE_GATHER_YIELD,
  BOSS_ATTACK_DAMAGE,
  BOSS_ATTACK_RADIUS_TILES,
  BOSS_COOLDOWN_MS,
  BOSS_MAX_HEALTH,
  BOSS_SPEED_TILES_PER_SEC,
  BOSS_WINDUP_MS,
  BUILD_RANGE_TILES,
  CAMPFIRE_SAFE_RADIUS_TILES,
  ENEMY_CONTACT_COOLDOWN_MS,
  ENEMY_CONTACT_RANGE_TILES,
  GATHER_RANGE_TILES,
  GUARDIAN_CONTACT_DAMAGE,
  GUARDIAN_MAX_HEALTH,
  GUARDIAN_SPEED_TILES_PER_SEC,
  ITEM_STACK_LIMIT,
  MAX_HEALTH,
  MAX_PLAYERS,
  PICKAXE_STONE_YIELD,
  PLAYER_RADIUS,
  PLAYER_SPEED_TILES_PER_SEC,
  SWORD_BONUS_DAMAGE,
  TOOL_DURABILITY_USES,
  WANDERER_CONTACT_DAMAGE,
  WANDERER_MAX_HEALTH,
  WANDERER_NIGHT_SPEED_MULTIPLIER,
  WANDERER_SPEED_TILES_PER_SEC,
} from "../shared/constants.js";
import { computeTimeOfDay } from "../shared/daynight.js";
import { getRecipe } from "../shared/recipes.js";
import type {
  Building,
  EnemyKind,
  EnemySpawn,
  EnemyState,
  ItemKind,
  MapObject,
  MapTile,
  PlayerState,
  ResourceKind,
  WorldMap,
} from "../shared/types.js";
import { SOLID_BUILDINGS, SOLID_OBJECTS, SOLID_TERRAIN, emptyInventory } from "../shared/types.js";

export interface ActionResult {
  ok: boolean;
  reason?: string;
  inventory?: Record<ItemKind, number>;
  objectRemaining?: number;
  recipeId?: string;
  buildingId?: string;
  chestItems?: Record<ItemKind, number>;
  health?: number;
  enemyHealth?: number;
  enemyDied?: boolean;
  damageDealt?: number;
  /** Set true only on the killing blow that leaves every enemy on the map dead — the signal net.ts uses to broadcast victory, never set on any other result. */
  allEnemiesDefeated?: boolean;
  /** Set to the tool's ItemKind on the exact gather/attack whose use wore it out to 0 and removed it from inventory — the signal main.ts uses to tell the player their tool just broke, not just that inventory changed. */
  toolBroke?: ItemKind;
}

/** Wire-safe view of an enemy — omits internal-only fields (spawn point, timers) that broadcasts never need. */
export interface EnemyView {
  id: string;
  kind: EnemyKind;
  x: number;
  y: number;
  health: number;
  maxHealth: number;
  telegraphing: boolean;
}

/** Emitted once per player death (health reaching 0), for net.ts to broadcast as `player.died`. */
export interface PlayerDeathEvent {
  playerId: string;
  /** Every building this player owned, just removed from the shared map. */
  removedBuildingIds: string[];
  /** The player's inventory after the death wipe — always all-zero. */
  inventory: Record<ItemKind, number>;
}

export type ChestDirection = "deposit" | "withdraw";

interface InternalPlayer extends PlayerState {
  inputDx: number;
  inputDy: number;
  lastAttackAt: number;
  /**
   * Uses applied so far toward TOOL_DURABILITY_USES for each tool kind —
   * in-memory simulation state (same category as lastAttackAt), not
   * persisted, so a reconnect/restart resets a tool's wear along with the
   * rest of the per-tick state. Resets to 0 the instant a tool breaks (see
   * useToolCharge), so a freshly broken-and-replaced tool always starts at
   * full durability.
   */
  toolUses: { axe: number; pickaxe: number; sword: number };
}

/**
 * Persistence hooks the Room calls after an in-memory mutation succeeds. All
 * optional — tests can omit them entirely.
 */
export interface RoomPersistence {
  nodeRemaining?: (objectId: string, remaining: number) => void;
  /** Called after an in-memory building placement succeeds. Returns false if persistence itself rejects it (e.g. a UNIQUE(x, y) race lost to a concurrent request) — the caller then rolls back the in-memory placement too. */
  building?: (building: Building) => boolean;
  /** Called once per building after an in-memory removal (e.g. the owner's death wipes every building they placed). */
  removeBuilding?: (buildingId: string) => void;
  chestItem?: (chestId: string, kind: ItemKind, quantity: number) => void;
  /**
   * Called after a player's inventory changes. Keyed by the player's stable
   * identity id (Phase C), not a per-connection id, so it survives
   * reconnects and restarts — see `src/server/identity.ts`.
   */
  playerInventory?: (playerId: string, inventory: Record<ItemKind, number>) => void;
  /** Called after a player's health changes (damage, healing, or respawn). */
  playerHealth?: (playerId: string, health: number) => void;
}

/**
 * The single authoritative room: one shared world, movement and gathering
 * are both applied synchronously (no `await` between reading and writing
 * player/object state), so JS's single-threaded execution is what actually
 * gives us atomicity here — there is no interleaving point for two
 * "requests" to race inside a tick or inside `interact`.
 *
 * Killing every enemy on the map is the room's shared win condition (see
 * `allEnemiesDefeated`). Enemies are in-memory-only, transient simulation
 * state, never persisted — a server restart regenerates the full roster
 * from the deterministic map seed, resetting any in-progress kill count.
 * This is a known, accepted limitation (see PROCESS.md), not an oversight.
 */
export class Room {
  readonly map: WorldMap;
  private readonly players = new Map<string, InternalPlayer>();
  private readonly objectsById = new Map<string, MapObject>();
  private readonly solidCells = new Set<string>();
  private readonly buildingsById = new Map<string, Building>();
  private readonly buildingsByCell = new Map<string, Building>();
  private readonly solidBuildingCells = new Set<string>();
  private readonly chestInventories = new Map<string, Record<ItemKind, number>>();
  private readonly persistence: RoomPersistence;
  private readonly recentActions = new Map<string, ActionResult>();
  private readonly now: () => number;
  private readonly worldCreatedAt: number;
  private readonly enemies = new Map<string, EnemyState>();
  /** Deaths accumulated since the last drainDeathEvents() call — net.ts drains and broadcasts these after every tick(). */
  private readonly pendingDeathEvents: PlayerDeathEvent[] = [];
  /**
   * Per-tick cache of distanceFieldTo's BFS result, keyed by the target
   * cell. Multiple enemies converging on the same player (the common case)
   * would otherwise each re-run an identical map-wide BFS every tick they're
   * both blocked on their direct line — this makes it one BFS per distinct
   * target cell per tick instead of one per blocked enemy. Cleared at the
   * start of every tick() so a player who's moved gets a fresh field, never
   * served a stale one from an earlier tick.
   */
  private readonly distanceFieldCache = new Map<string, Int32Array>();

  constructor(
    map: WorldMap,
    persistence: RoomPersistence = {},
    initialBuildings: Building[] = [],
    initialChestItems: Map<string, Record<ItemKind, number>> = new Map(),
    now: () => number = Date.now,
    worldCreatedAt: number = now(),
    enemySpawns: EnemySpawn[] = [],
  ) {
    this.map = map;
    this.persistence = persistence;
    this.now = now;
    this.worldCreatedAt = worldCreatedAt;
    for (const obj of map.objects) {
      this.objectsById.set(obj.id, obj);
      if (SOLID_OBJECTS.has(obj.kind)) {
        this.solidCells.add(cellKey(obj.x, obj.y));
      }
    }
    for (const building of initialBuildings) {
      this.registerBuilding(building);
      if (building.kind === "chest") {
        this.chestInventories.set(building.id, initialChestItems.get(building.id) ?? emptyInventory());
      }
    }
    let enemySeq = 0;
    for (const spawn of enemySpawns) {
      const id = `enemy-${spawn.kind}-${enemySeq++}`;
      this.enemies.set(id, this.makeEnemyState(id, spawn));
    }
  }

  private registerBuilding(building: Building): void {
    this.buildingsById.set(building.id, building);
    this.buildingsByCell.set(cellKey(building.x, building.y), building);
    if (SOLID_BUILDINGS.has(building.kind)) {
      this.solidBuildingCells.add(cellKey(building.x, building.y));
    }
  }

  /** Removes a building from every in-memory index (the mirror image of registerBuilding), plus its chest contents if it was a chest. */
  private unregisterBuilding(building: Building): void {
    this.buildingsById.delete(building.id);
    this.buildingsByCell.delete(cellKey(building.x, building.y));
    this.solidBuildingCells.delete(cellKey(building.x, building.y));
    this.chestInventories.delete(building.id);
  }

  /**
   * Returns every death event recorded since the last call, then clears the
   * queue. `damagePlayer` is the only place a death can happen — called from
   * `tickEnemy` (wanderer/guardian contact) and `tickBoss` (the telegraphed
   * AoE), both only ever invoked from `tick()` — so net.ts draining this
   * once after every `tick()` call is enough to broadcast `player.died`
   * exactly once per death, regardless of which enemy caused it.
   */
  drainDeathEvents(): PlayerDeathEvent[] {
    return this.pendingDeathEvents.splice(0, this.pendingDeathEvents.length);
  }

  get playerCount(): number {
    return this.players.size;
  }

  canJoin(): boolean {
    return this.players.size < MAX_PLAYERS;
  }

  addPlayer(id: string, name: string, inventory?: Record<ItemKind, number>, health?: number): PlayerState {
    const spawn = this.map.spawnPoint;
    const initialHealth = health ?? MAX_HEALTH;
    const player: InternalPlayer = {
      id,
      name,
      x: spawn.x + 0.5,
      y: spawn.y + 0.5,
      health: initialHealth,
      alive: initialHealth > 0,
      inventory: inventory ?? emptyInventory(),
      connected: true,
      inputDx: 0,
      inputDy: 0,
      lastAttackAt: -Infinity,
      toolUses: { axe: 0, pickaxe: 0, sword: 0 },
    };
    this.players.set(id, player);
    return player;
  }

  /**
   * Adds up to `qty` of `kind` to the player's inventory, clamped at
   * ITEM_STACK_LIMIT. Returns how much actually fit — a gather or craft
   * that overflows the cap grants only the space available rather than
   * discarding or duplicating anything.
   */
  private addItem(player: InternalPlayer, kind: ItemKind, qty: number): number {
    const current = player.inventory[kind];
    const fit = Math.min(qty, ITEM_STACK_LIMIT - current);
    if (fit <= 0) return 0;
    player.inventory[kind] = current + fit;
    return fit;
  }

  /** Removes `qty` of `kind` if the player has enough; otherwise mutates nothing and returns false. */
  private removeItem(player: InternalPlayer, kind: ItemKind, qty: number): boolean {
    if (player.inventory[kind] < qty) return false;
    player.inventory[kind] -= qty;
    return true;
  }

  /**
   * Records one use of `tool` (axe/pickaxe/sword) toward TOOL_DURABILITY_USES
   * — called only on a gather/attack that actually applied the tool's
   * effect, never on a tool-less action. At the durability cap, removes one
   * copy of the tool from inventory and resets the counter, so a second
   * copy in inventory (or one crafted later) starts back at full
   * durability. Returns true exactly when this call broke the tool, so the
   * caller can surface that to the player.
   */
  private useToolCharge(player: InternalPlayer, tool: "axe" | "pickaxe" | "sword"): boolean {
    player.toolUses[tool] += 1;
    if (player.toolUses[tool] < TOOL_DURABILITY_USES) return false;

    player.toolUses[tool] = 0;
    this.removeItem(player, tool, 1);
    return true;
  }

  /** Persists a player's current inventory. Called once per successful action, not once per addItem/removeItem. */
  private persistInventory(player: InternalPlayer): void {
    this.persistence.playerInventory?.(player.id, player.inventory);
  }

  removePlayer(id: string): void {
    this.players.delete(id);
  }

  /** Toggles connection status without removing/re-adding — used on disconnect/reconnect so in-flight position and inventory survive a brief drop. */
  setConnected(id: string, connected: boolean): void {
    const player = this.players.get(id);
    if (!player) return;
    player.connected = connected;
  }

  hasPlayer(id: string): boolean {
    return this.players.has(id);
  }

  setInput(id: string, dx: number, dy: number): void {
    const player = this.players.get(id);
    if (!player) return;
    player.inputDx = clamp(dx, -1, 1);
    player.inputDy = clamp(dy, -1, 1);
  }

  /** Advances the simulation by dtSeconds, applying movement + collision for every player, then enemy AI and contact damage. */
  tick(dtSeconds: number): void {
    for (const player of this.players.values()) {
      this.movePlayer(player, dtSeconds);
    }
    this.distanceFieldCache.clear();
    for (const enemy of this.enemies.values()) {
      this.tickEnemy(enemy, dtSeconds);
    }
  }

  private makeEnemyState(id: string, spawn: EnemySpawn): EnemyState {
    const maxHealth =
      spawn.kind === "wanderer" ? WANDERER_MAX_HEALTH : spawn.kind === "guardian" ? GUARDIAN_MAX_HEALTH : BOSS_MAX_HEALTH;
    return {
      id,
      kind: spawn.kind,
      x: spawn.x,
      y: spawn.y,
      health: maxHealth,
      maxHealth,
      spawnX: spawn.x,
      spawnY: spawn.y,
      alive: true,
      lastContactAt: -Infinity,
      telegraphing: false,
      nextActionAt: -Infinity,
    };
  }

  /** True if any living player is within CAMPFIRE_SAFE_RADIUS_TILES of a placed campfire — the brief's "defensive structure reduces danger" note. */
  private isNearSafeCampfire(x: number, y: number): boolean {
    for (const building of this.buildingsById.values()) {
      if (building.kind !== "campfire") continue;
      if (Math.hypot(x - (building.x + 0.5), y - (building.y + 0.5)) <= CAMPFIRE_SAFE_RADIUS_TILES) return true;
    }
    // The overworld's world-gen campfire object counts too (it's a MapObject, not a placed Building).
    for (const obj of this.objectsById.values()) {
      if (obj.kind !== "campfire") continue;
      if (Math.hypot(x - (obj.x + 0.5), y - (obj.y + 0.5)) <= CAMPFIRE_SAFE_RADIUS_TILES) return true;
    }
    return false;
  }

  private nearestLivingPlayer(x: number, y: number): InternalPlayer | undefined {
    let best: InternalPlayer | undefined;
    let bestDist = Infinity;
    for (const player of this.players.values()) {
      if (!player.alive) continue;
      const dist = Math.hypot(player.x - x, player.y - y);
      if (dist < bestDist) {
        bestDist = dist;
        best = player;
      }
    }
    return best;
  }

  private tickEnemy(enemy: EnemyState, dtSeconds: number): void {
    if (!enemy.alive) return;
    if (enemy.kind === "boss") {
      this.tickBoss(enemy, dtSeconds);
      return;
    }

    const isWanderer = enemy.kind === "wanderer";
    // Wanderers alone speed up at night (see constants.ts's
    // WANDERER_NIGHT_SPEED_MULTIPLIER note) — guardians and the boss hold
    // their day speed regardless of time of day.
    const speed = isWanderer
      ? WANDERER_SPEED_TILES_PER_SEC * (this.isNight() ? WANDERER_NIGHT_SPEED_MULTIPLIER : 1)
      : GUARDIAN_SPEED_TILES_PER_SEC;
    const contactDamage = isWanderer ? WANDERER_CONTACT_DAMAGE : GUARDIAN_CONTACT_DAMAGE;

    // Every enemy chases unconditionally from the moment it exists — no
    // aggro range, no leash, no day/night passivity beyond the wanderer
    // night-speed bump above. The only thing that still holds an enemy back
    // is a placed campfire's safe radius (the brief's "defensive structure
    // reduces danger" note), which still only applies to wanderers.
    const chase = this.chaseNearestPlayer(enemy, dtSeconds, speed, isWanderer);
    if (chase && chase.dist <= ENEMY_CONTACT_RANGE_TILES) {
      const now = this.now();
      if (now - enemy.lastContactAt >= ENEMY_CONTACT_COOLDOWN_MS) {
        enemy.lastContactAt = now;
        this.damagePlayer(chase.target, contactDamage);
      }
    }
  }

  /**
   * Moves `enemy` one tick toward the nearest living player at `speed`,
   * respecting the same solid-cell checks as a player. `respectCampfireSafety`
   * (true only for wanderers — see tickEnemy's comment) skips the chase
   * entirely while the target stands in a placed campfire's safe radius.
   * Returns the target and the pre-move distance to it, or undefined if
   * there's no player to chase, so callers can decide what proximity means
   * for them (contact damage, attack range, nothing at all).
   */
  private chaseNearestPlayer(
    enemy: EnemyState,
    dtSeconds: number,
    speed: number,
    respectCampfireSafety: boolean,
  ): { target: InternalPlayer; dist: number } | undefined {
    const target = this.nearestLivingPlayer(enemy.x, enemy.y);
    if (!target) return undefined;
    if (respectCampfireSafety && this.isNearSafeCampfire(target.x, target.y)) return undefined;

    const dx = target.x - enemy.x;
    const dy = target.y - enemy.y;
    const len = Math.hypot(dx, dy) || 1;
    const dist = speed * dtSeconds;

    this.stepToward(enemy, dx / len, dy / len, dist, target.x, target.y);

    return { target, dist: len };
  }

  /**
   * Moves `enemy` one tick toward (targetX, targetY), `dist` tiles at
   * `speed * dtSeconds`. When *both* axes of the direct-line heading
   * (moveX, moveY) are fully open, just takes that step — cheap, and
   * smoothly diagonal in open terrain, the overwhelming majority of ticks.
   *
   * The instant *either* axis is blocked, this defers entirely to
   * distanceFieldTo's BFS distance field rather than taking the open axis's
   * partial step — unconditionally, not just when the field and the direct
   * line clearly disagree. A softer rule tried first — compare the open
   * axis's direction against the field's recommended cardinal via a dot
   * product, and only override when they disagree outright (dot <= 0) —
   * has a failure mode neither "both axes blocked" nor "clear disagreement"
   * catches: a direct line that's *almost* axis-aligned with the blocked
   * axis (e.g. heading 89.9° west with a sliver of north in it, while west
   * is blocked) still reads as "roughly agreeing" with the field's actual
   * recommendation (due north) by dot-product sign, so the direct line
   * keeps getting trusted — but its contribution along the one open axis
   * shrinks every tick in proportion to the remaining distance on that axis
   * (classic Zeno's-paradox decay), so the enemy asymptotically creeps
   * toward — but mathematically never reaches — the next cell boundary.
   * Confirmed by pinning a boss just west of a tree at a near-exact
   * east-west alignment with its target and watching it approach the
   * boundary for 1000+ simulated seconds without ever crossing it. Since
   * there's no scalar threshold on "how aligned is aligned enough" that
   * can't eventually be defeated by *some* angle arbitrarily close to the
   * blocked axis, the only robust rule is binary: fully open on both axes,
   * or hand off to the field entirely.
   *
   * Once handed off, this finds the cardinally-adjacent cell with the
   * smallest distance-to-target (if any beats the enemy's own cell) and
   * commits to it as `enemy.routeCell`, walking only that cell's exact
   * cardinal direction (followRoute) until the enemy's own cell matches it
   * — never re-deriving the decision from scratch every tick. Committing
   * matters for the same reason a softer per-tick re-check would: letting
   * the (still at least partly blocked) direct line fight the detour every
   * tick is what produced the lake-shoreline oscillation an even earlier
   * version of this method hit before routeCell existed at all.
   *
   * Candidates are deliberately CARDINAL_NEIGHBOURS, the same 4 directions
   * the BFS field expands through, never a diagonal: a diagonal neighbour
   * the field ranks as closer isn't necessarily reachable in one step (the
   * cell on the diagonal between the enemy and that neighbour might itself
   * be solid), and the field's own distances only ever account for cardinal
   * moves — restricting candidates to the same 4 cardinals the field was
   * built from keeps "the field says it's closer" and "actually reachable
   * in one step" in sync.
   */
  private stepToward(enemy: EnemyState, moveX: number, moveY: number, dist: number, targetX: number, targetY: number): void {
    if (enemy.routeCell) {
      if (Math.floor(enemy.x) === enemy.routeCell.cx && Math.floor(enemy.y) === enemy.routeCell.cy) {
        enemy.routeCell = undefined; // arrived — hand control back to the direct line below
      } else {
        this.followRoute(enemy, dist);
        return;
      }
    }

    const stepX = moveX * dist;
    const stepY = moveY * dist;
    const xOpen = stepX === 0 || !this.isEnemyBlocked(enemy.x + stepX, enemy.y);
    const yOpen = stepY === 0 || !this.isEnemyBlocked(enemy.x, enemy.y + stepY);
    if (xOpen && yOpen) {
      this.tryAxisMove(enemy, stepX, stepY);
      return;
    }

    const field = this.distanceFieldTo(targetX, targetY);
    if (field) {
      const fromCx = Math.floor(enemy.x);
      const fromCy = Math.floor(enemy.y);
      const fromDist = this.fieldAt(field, fromCx, fromCy);
      if (fromDist > 0) {
        // fromDist > 0 excludes both "already in the target's cell" (0 —
        // fall through to the partial direct-line move below) and "not on
        // the walkable field at all" (-1 — shouldn't happen, but never
        // route off a bad read).
        let best: readonly [number, number] | undefined;
        let bestDist = fromDist;
        for (const [cx, cy] of CARDINAL_NEIGHBOURS) {
          const neighbourDist = this.fieldAt(field, fromCx + cx, fromCy + cy);
          if (neighbourDist >= 0 && neighbourDist < bestDist) {
            bestDist = neighbourDist;
            best = [cx, cy];
          }
        }
        if (best) {
          enemy.routeCell = { cx: fromCx + best[0], cy: fromCy + best[1] };
          this.followRoute(enemy, dist);
          return;
        }
      }
    }

    // No field, or no improving neighbour (e.g. already in the target's
    // cell, or genuinely walled in) — the partial direct-line move is the
    // best available, same as the open-terrain case above.
    this.tryAxisMove(enemy, stepX, stepY);
  }

  /**
   * Advances `enemy` one tick toward its committed `routeCell`. Each
   * candidate from stepToward's CARDINAL_NEIGHBOURS search differs from the
   * enemy's current cell along exactly one axis, so moving `dist` along
   * only that axis (never both at once, unlike the direct-line case) is
   * guaranteed not to introduce the diagonal-clipping risk stepToward's
   * comment describes, and guarantees the enemy's position on that axis
   * moves monotonically toward the boundary every tick until it crosses it.
   */
  private followRoute(enemy: EnemyState, dist: number): void {
    const route = enemy.routeCell!;
    const stepX = route.cx > Math.floor(enemy.x) ? dist : route.cx < Math.floor(enemy.x) ? -dist : 0;
    const stepY = route.cy > Math.floor(enemy.y) ? dist : route.cy < Math.floor(enemy.y) ? -dist : 0;
    this.tryAxisMove(enemy, stepX, stepY);
  }

  /** Applies up to (stepX, stepY) to `enemy` per-axis (the same "slide along a wall" split `movePlayer` uses), skipping either axis that's a no-op. Returns true if either axis actually moved. */
  private tryAxisMove(enemy: EnemyState, stepX: number, stepY: number): boolean {
    let moved = false;
    if (stepX !== 0) {
      const targetX = enemy.x + stepX;
      if (!this.isEnemyBlocked(targetX, enemy.y)) {
        enemy.x = targetX;
        moved = true;
      }
    }
    if (stepY !== 0) {
      const targetY = enemy.y + stepY;
      if (!this.isEnemyBlocked(enemy.x, targetY)) {
        enemy.y = targetY;
        moved = true;
      }
    }
    return moved;
  }

  /** Reads `field`'s BFS distance for cell (cx, cy), or -1 if out of bounds or never reached (solid, or cut off from the target by solid terrain). */
  private fieldAt(field: Int32Array, cx: number, cy: number): number {
    if (cx < 0 || cy < 0 || cx >= this.map.width || cy >= this.map.height) return -1;
    return field[cy * this.map.width + cx]!;
  }

  /**
   * BFS distance field (in cells) from every walkable cell to the cell
   * containing (targetX, targetY), cached per tick per target cell (see
   * distanceFieldCache) since every enemy converging on the same player
   * shares the same field. Returns undefined if the target's own cell is
   * solid (unreachable from anywhere, so there's nothing to route toward —
   * shouldn't happen for a living player's actual position, but this is the
   * one caller-facing way that could surface if it ever did).
   */
  private distanceFieldTo(targetX: number, targetY: number): Int32Array | undefined {
    const targetCx = Math.floor(targetX);
    const targetCy = Math.floor(targetY);
    if (this.isEnemyBlocked(targetX, targetY)) return undefined;

    const key = cellKey(targetCx, targetCy);
    const cached = this.distanceFieldCache.get(key);
    if (cached) return cached;

    const { width, height } = this.map;
    const field = new Int32Array(width * height).fill(-1);
    const startIdx = targetCy * width + targetCx;
    field[startIdx] = 0;
    const queue: number[] = [startIdx];
    let head = 0;
    while (head < queue.length) {
      const idx = queue[head++]!;
      const cx = idx % width;
      const cy = Math.floor(idx / width);
      const d = field[idx]!;
      for (const [dx, dy] of CARDINAL_NEIGHBOURS) {
        const ncx = cx + dx;
        const ncy = cy + dy;
        if (ncx < 0 || ncy < 0 || ncx >= width || ncy >= height) continue;
        if (this.isCellBlocked(ncx, ncy)) continue;
        const nidx = ncy * width + ncx;
        if (field[nidx]! !== -1) continue;
        field[nidx] = d + 1;
        queue.push(nidx);
      }
    }

    this.distanceFieldCache.set(key, field);
    return field;
  }

  /**
   * The boss chases the nearest player like every other enemy, but plants
   * itself the instant it's close enough to engage: once in range and off
   * cooldown, it stops to telegraph, holds still through the whole windup,
   * then hits every living player within BOSS_ATTACK_RADIUS_TILES when it
   * lands and resumes chasing on cooldown (so it can close in again if its
   * target fled). No passive contact damage even while closing the distance
   * — the telegraphed cycle is its only damage source.
   */
  private tickBoss(enemy: EnemyState, dtSeconds: number): void {
    const now = this.now();

    if (enemy.telegraphing) {
      if (now < enemy.nextActionAt) return; // holds still through the windup

      // Windup finished: land the hit.
      enemy.telegraphing = false;
      enemy.nextActionAt = now + BOSS_COOLDOWN_MS;
      for (const player of this.players.values()) {
        if (!player.alive) continue;
        if (Math.hypot(player.x - enemy.x, player.y - enemy.y) <= BOSS_ATTACK_RADIUS_TILES) {
          this.damagePlayer(player, BOSS_ATTACK_DAMAGE);
        }
      }
      return;
    }

    const chase = this.chaseNearestPlayer(enemy, dtSeconds, BOSS_SPEED_TILES_PER_SEC, false);
    if (now < enemy.nextActionAt) return; // still cooling down from its last hit

    if (chase && chase.dist <= BOSS_ATTACK_RADIUS_TILES) {
      enemy.telegraphing = true;
      enemy.nextActionAt = now + BOSS_WINDUP_MS;
    }
  }

  /** Enemies use the same solid-cell checks as players, but ignore other enemies/players (no enemy-enemy or enemy-player collision, only contact-damage proximity). */
  private isEnemyBlocked(x: number, y: number): boolean {
    return this.isCellBlocked(Math.floor(x), Math.floor(y));
  }

  getEnemies(): EnemyView[] {
    return [...this.enemies.values()]
      .filter((e) => e.alive)
      .map((e) => ({
        id: e.id,
        kind: e.kind,
        x: e.x,
        y: e.y,
        health: e.health,
        maxHealth: e.maxHealth,
        telegraphing: e.telegraphing,
      }));
  }

  getEnemy(id: string): EnemyState | undefined {
    return this.enemies.get(id);
  }

  /** The room's shared win condition: true once every enemy ever placed on the map has been killed. A room with zero enemies (e.g. a bare test fixture) is never "won" by default — only a kill transitions this to true. */
  allEnemiesDefeated(): boolean {
    if (this.enemies.size === 0) return false;
    return [...this.enemies.values()].every((e) => !e.alive);
  }

  /**
   * Validates and applies a player's melee attack on an enemy. Range,
   * cooldown, alive-target, and alive-attacker are all checked server-side —
   * the client reports only *who* it's attacking, never damage or timing.
   * Damage and the alive->dead transition happen inside this one
   * synchronous call, so two "simultaneous" killing blows are actually
   * sequential turns of the event loop: whichever request runs first sees
   * the enemy alive and kills it; the second sees it already dead and gets
   * `already_dead`.
   */
  attack(playerId: string, targetId: string, requestId: string): ActionResult {
    return this.withDedupe("attack", playerId, requestId, () => this.doAttack(playerId, targetId));
  }

  private doAttack(playerId: string, targetId: string): ActionResult {
    const player = this.players.get(playerId);
    if (!player) return { ok: false, reason: "unknown_player" };
    if (!player.alive) return { ok: false, reason: "dead" };

    const enemy = this.enemies.get(targetId);
    if (!enemy) return { ok: false, reason: "unknown_target" };
    if (!enemy.alive) return { ok: false, reason: "already_dead" };

    const now = this.now();
    if (now - player.lastAttackAt < ATTACK_COOLDOWN_MS) return { ok: false, reason: "on_cooldown" };

    const dist = Math.hypot(player.x - enemy.x, player.y - enemy.y);
    if (dist > ATTACK_RANGE_TILES) return { ok: false, reason: "too_far" };

    player.lastAttackAt = now;
    const hasSword = player.inventory.sword > 0;
    const damage = BASE_ATTACK_DAMAGE + (hasSword ? SWORD_BONUS_DAMAGE : 0);
    enemy.health = Math.max(0, enemy.health - damage);
    // The sword only wears on a hit it actually boosted — an unarmed attack
    // never touches toolUses.
    const toolBroke = hasSword && this.useToolCharge(player, "sword") ? "sword" : undefined;
    if (toolBroke) this.persistInventory(player);

    const died = enemy.health === 0;
    if (died) {
      enemy.alive = false;
    }

    return {
      ok: true,
      enemyHealth: enemy.health,
      enemyDied: died,
      damageDealt: damage,
      allEnemiesDefeated: died ? this.allEnemiesDefeated() : undefined,
      toolBroke,
    };
  }

  private movePlayer(player: InternalPlayer, dtSeconds: number): void {
    if (!player.alive) return;
    const len = Math.hypot(player.inputDx, player.inputDy);
    if (len === 0) return;
    const nx = player.inputDx / len;
    const ny = player.inputDy / len;
    const dist = PLAYER_SPEED_TILES_PER_SEC * dtSeconds;

    const targetX = player.x + nx * dist;
    const targetY = player.y + ny * dist;

    if (!this.isBlocked(targetX, player.y)) player.x = this.clampToMap(targetX, this.map.width);
    if (!this.isBlocked(player.x, targetY)) player.y = this.clampToMap(targetY, this.map.height);
  }

  private clampToMap(value: number, size: number): number {
    return clamp(value, PLAYER_RADIUS, size - PLAYER_RADIUS);
  }

  /** True if a player-sized circle centred at (x, y) would overlap a solid tile, object, or placed building. */
  private isBlocked(x: number, y: number): boolean {
    const offsets = [
      [0, 0],
      [PLAYER_RADIUS, 0],
      [-PLAYER_RADIUS, 0],
      [0, PLAYER_RADIUS],
      [0, -PLAYER_RADIUS],
    ];
    for (const [ox, oy] of offsets) {
      const cx = Math.floor(x + (ox ?? 0));
      const cy = Math.floor(y + (oy ?? 0));
      if (this.isCellBlocked(cx, cy)) return true;
    }
    return false;
  }

  /** True if the integer cell (cx, cy) is out of bounds or occupied by solid terrain, a world object, or a building. */
  private isCellBlocked(cx: number, cy: number): boolean {
    if (cx < 0 || cy < 0 || cx >= this.map.width || cy >= this.map.height) return true;
    const tile = this.map.tiles[cy * this.map.width + cx];
    if (tile && SOLID_TERRAIN.has(tile.terrain)) return true;
    if (this.solidCells.has(cellKey(cx, cy))) return true;
    if (this.solidBuildingCells.has(cellKey(cx, cy))) return true;
    return false;
  }

  getPlayer(id: string): PlayerState | undefined {
    return this.players.get(id);
  }

  getPlayers(): PlayerState[] {
    return [...this.players.values()].map(({ inputDx, inputDy, lastAttackAt, toolUses, ...rest }) => rest);
  }

  getBuildings(): Building[] {
    return [...this.buildingsById.values()];
  }

  /** True if at least one player currently holds an open connection (a reconnect-grace-window slot with `connected: false` doesn't count). */
  hasConnectedPlayers(): boolean {
    for (const player of this.players.values()) {
      if (player.connected) return true;
    }
    return false;
  }

  /**
   * Restocks every gatherable object on the map back to its maxRemaining —
   * called once the last connected player disconnects, so a map nobody is
   * actively playing on doesn't stay picked over for whoever joins next.
   * Persists each node's new remaining the same way a gather does, and
   * returns the objects that actually changed so the caller can broadcast
   * the restock to any clients still displaying the (now stale) map.
   */
  resetAllResources(): MapObject[] {
    const changed: MapObject[] = [];
    for (const object of this.objectsById.values()) {
      if (!object.resource || object.resource.remaining === object.resource.maxRemaining) continue;
      object.resource.remaining = object.resource.maxRemaining;
      this.persistence.nodeRemaining?.(object.id, object.resource.remaining);
      changed.push(object);
    }
    return changed;
  }

  getBuilding(id: string): Building | undefined {
    return this.buildingsById.get(id);
  }

  /**
   * Runs `fn` deduplicated by `${kind}:${playerId}:${requestId}` — a
   * repeated request (client retry, network blip) returns the cached result
   * of the first attempt instead of re-running `fn`, so retried actions
   * never double-consume materials or double-grant rewards. Shared by
   * every mutating action (gather, craft, build, chest, attack).
   */
  private withDedupe(kind: string, playerId: string, requestId: string, fn: () => ActionResult): ActionResult {
    const dedupeKey = `${kind}:${playerId}:${requestId}`;
    const cached = this.recentActions.get(dedupeKey);
    if (cached) return cached;

    const result = fn();
    this.recentActions.set(dedupeKey, result);
    if (this.recentActions.size > 2000) {
      const oldestKey = this.recentActions.keys().next().value;
      if (oldestKey !== undefined) this.recentActions.delete(oldestKey);
    }
    return result;
  }

  /**
   * Validates and applies a gather interaction. Synchronous end-to-end: the
   * availability check and the decrement happen in the same call with no
   * `await` between them, so two "simultaneous" interacts on the same node
   * (e.g. from two in-flight requests on the event loop) are actually
   * serialised by JS and the second one always sees the first's decrement.
   */
  interact(playerId: string, objectId: string, requestId: string): ActionResult {
    return this.withDedupe("interact", playerId, requestId, () => this.doInteract(playerId, objectId));
  }

  /** The per-gather yield for `kind`, doubled while the player holds the matching tool (axe for wood, pickaxe for stone) — berries have no tool, so always the base yield. */
  private gatherYieldFor(player: InternalPlayer, kind: ResourceKind): number {
    if (kind === "wood" && player.inventory.axe > 0) return AXE_WOOD_YIELD;
    if (kind === "stone" && player.inventory.pickaxe > 0) return PICKAXE_STONE_YIELD;
    return BASE_GATHER_YIELD;
  }

  private doInteract(playerId: string, objectId: string): ActionResult {
    const player = this.players.get(playerId);
    if (!player) return { ok: false, reason: "unknown_player" };
    if (!player.alive) return { ok: false, reason: "dead" };

    const object = this.objectsById.get(objectId);
    if (!object) return { ok: false, reason: "unknown_object" };

    if (!object.resource) return { ok: false, reason: "not_gatherable" };
    if (object.resource.remaining <= 0) return { ok: false, reason: "depleted" };

    const dist = Math.hypot(player.x - (object.x + 0.5), player.y - (object.y + 0.5));
    if (dist > GATHER_RANGE_TILES) return { ok: false, reason: "too_far" };

    const resourceKind = object.resource.kind;
    const tool = resourceKind === "wood" && player.inventory.axe > 0 ? "axe" : resourceKind === "stone" && player.inventory.pickaxe > 0 ? "pickaxe" : undefined;
    const yieldAmount = this.gatherYieldFor(player, resourceKind);
    const granted = this.addItem(player, resourceKind, yieldAmount);
    if (granted <= 0) return { ok: false, reason: "inventory_full" };

    object.resource.remaining -= 1;
    this.persistence.nodeRemaining?.(object.id, object.resource.remaining);
    // The tool only wears if it actually boosted this gather — a plain,
    // tool-less gather (or one with the wrong tool for this resource) never
    // touches toolUses.
    const toolBroke = tool && this.useToolCharge(player, tool) ? tool : undefined;
    this.persistInventory(player);

    return {
      ok: true,
      inventory: { ...player.inventory },
      objectRemaining: object.resource.remaining,
      toolBroke,
    };
  }

  /**
   * Validates and applies a craft. Checks every input quantity before
   * removing any of them — an insufficient-materials craft mutates nothing
   * (checked first with no partial consumption), and the remove+grant pair
   * that follows runs with no `await` between them, so there's no window
   * for a concurrent action on the same player to observe a half-applied
   * craft.
   */
  craft(playerId: string, recipeId: string, requestId: string): ActionResult {
    return this.withDedupe("craft", playerId, requestId, () => this.doCraft(playerId, recipeId));
  }

  private doCraft(playerId: string, recipeId: string): ActionResult {
    const player = this.players.get(playerId);
    if (!player) return { ok: false, reason: "unknown_player" };
    if (!player.alive) return { ok: false, reason: "dead" };

    const recipe = getRecipe(recipeId);
    if (!recipe) return { ok: false, reason: "unknown_recipe" };

    for (const [kind, qty] of Object.entries(recipe.inputs) as Array<[ItemKind, number]>) {
      if (player.inventory[kind] < qty) {
        return { ok: false, reason: "insufficient_materials", recipeId };
      }
    }

    // Crafting a building-producing recipe hands off placement to build();
    // craft() alone only ever grants inventory items.
    if (recipe.output.type !== "item") {
      return { ok: false, reason: "not_an_item_recipe", recipeId };
    }

    const roomForOutput = ITEM_STACK_LIMIT - player.inventory[recipe.output.kind];
    if (roomForOutput < recipe.output.qty) {
      return { ok: false, reason: "inventory_full", recipeId };
    }

    for (const [kind, qty] of Object.entries(recipe.inputs) as Array<[ItemKind, number]>) {
      this.removeItem(player, kind, qty);
    }
    this.addItem(player, recipe.output.kind, recipe.output.qty);
    this.persistInventory(player);

    return { ok: true, inventory: { ...player.inventory }, recipeId };
  }

  /**
   * Validates and applies a building placement. Checks, in order: player
   * exists; recipe exists and produces a building; target cell in bounds;
   * within BUILD_RANGE_TILES of the player; target cell not already solid
   * (terrain/object/building) or already occupied by any building; player
   * has the materials. Only once every check passes are materials consumed
   * and the building created — an invalid placement never touches inventory.
   */
  build(playerId: string, recipeId: string, x: number, y: number, requestId: string): ActionResult {
    return this.withDedupe("build", playerId, requestId, () => this.doBuild(playerId, recipeId, x, y));
  }

  private doBuild(playerId: string, recipeId: string, x: number, y: number): ActionResult {
    const player = this.players.get(playerId);
    if (!player) return { ok: false, reason: "unknown_player" };
    if (!player.alive) return { ok: false, reason: "dead" };

    const recipe = getRecipe(recipeId);
    if (!recipe) return { ok: false, reason: "unknown_recipe" };
    if (recipe.output.type !== "building") return { ok: false, reason: "not_a_building_recipe", recipeId };

    const cx = Math.floor(x);
    const cy = Math.floor(y);
    if (cx < 0 || cy < 0 || cx >= this.map.width || cy >= this.map.height) {
      return { ok: false, reason: "out_of_bounds", recipeId };
    }

    const dist = Math.hypot(player.x - (cx + 0.5), player.y - (cy + 0.5));
    if (dist > BUILD_RANGE_TILES) return { ok: false, reason: "too_far", recipeId };

    if (this.isCellBlocked(cx, cy) || this.buildingsByCell.has(cellKey(cx, cy))) {
      return { ok: false, reason: "cell_occupied", recipeId };
    }

    for (const [kind, qty] of Object.entries(recipe.inputs) as Array<[ItemKind, number]>) {
      if (player.inventory[kind] < qty) {
        return { ok: false, reason: "insufficient_materials", recipeId };
      }
    }

    const building: Building = {
      id: `building-${cx}-${cy}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      kind: recipe.output.kind,
      x: cx,
      y: cy,
      ownerId: playerId,
      placedAt: Date.now(),
    };

    if (this.persistence.building && !this.persistence.building(building)) {
      // The database's UNIQUE(x, y) lost a race to a concurrent placement
      // that committed first — treat it exactly like any other occupied-cell
      // rejection, and don't touch the player's materials.
      return { ok: false, reason: "cell_occupied", recipeId };
    }

    for (const [kind, qty] of Object.entries(recipe.inputs) as Array<[ItemKind, number]>) {
      this.removeItem(player, kind, qty);
    }
    this.registerBuilding(building);
    if (building.kind === "chest") {
      this.chestInventories.set(building.id, emptyInventory());
    }
    this.persistInventory(player);

    return { ok: true, inventory: { ...player.inventory }, recipeId, buildingId: building.id };
  }

  /**
   * Moves items between a player's inventory and a shared chest's contents.
   * Chests have no owner check — any player within range can deposit or
   * withdraw, per the project's shared-storage policy. The source side is
   * checked and both sides updated with no `await` in between, so this is
   * atomic the same way craft's remove-then-add pair is.
   */
  chestTransfer(
    playerId: string,
    chestId: string,
    kind: ItemKind,
    qty: number,
    direction: ChestDirection,
    requestId: string,
  ): ActionResult {
    return this.withDedupe("chest", playerId, requestId, () =>
      this.doChestTransfer(playerId, chestId, kind, qty, direction),
    );
  }

  private doChestTransfer(
    playerId: string,
    chestId: string,
    kind: ItemKind,
    qty: number,
    direction: ChestDirection,
  ): ActionResult {
    const player = this.players.get(playerId);
    if (!player) return { ok: false, reason: "unknown_player" };
    if (!player.alive) return { ok: false, reason: "dead" };
    if (qty <= 0) return { ok: false, reason: "invalid_quantity" };

    const chest = this.buildingsById.get(chestId);
    if (!chest || chest.kind !== "chest") return { ok: false, reason: "unknown_chest" };

    const dist = Math.hypot(player.x - (chest.x + 0.5), player.y - (chest.y + 0.5));
    if (dist > BUILD_RANGE_TILES) return { ok: false, reason: "too_far" };

    const chestItems = this.chestInventories.get(chestId) ?? emptyInventory();

    if (direction === "deposit") {
      if (player.inventory[kind] < qty) return { ok: false, reason: "insufficient_materials" };
      const roomInChest = ITEM_STACK_LIMIT - chestItems[kind];
      if (roomInChest < qty) return { ok: false, reason: "chest_full" };
      this.removeItem(player, kind, qty);
      chestItems[kind] += qty;
    } else {
      if (chestItems[kind] < qty) return { ok: false, reason: "insufficient_materials" };
      const roomInInventory = ITEM_STACK_LIMIT - player.inventory[kind];
      if (roomInInventory < qty) return { ok: false, reason: "inventory_full" };
      chestItems[kind] -= qty;
      this.addItem(player, kind, qty);
    }

    this.chestInventories.set(chestId, chestItems);
    this.persistence.chestItem?.(chestId, kind, chestItems[kind]);
    this.persistInventory(player);

    return { ok: true, inventory: { ...player.inventory }, chestItems: { ...chestItems } };
  }

  /** Whether it's currently night — visual/ambience only (see constants.ts's note); derived purely from elapsed time since world creation, see computeTimeOfDay. */
  isNight(): boolean {
    return computeTimeOfDay(this.worldCreatedAt, this.now()).isNight;
  }

  /** Persists a player's current health. Called once per successful damage/heal/respawn, not every tick. */
  private persistHealth(player: InternalPlayer): void {
    this.persistence.playerHealth?.(player.id, player.health);
  }

  /**
   * Applies damage to a player, clamping at 0 and flipping `alive` false the
   * instant health reaches 0. Used by both enemy contact damage and the
   * boss's telegraphed AoE — the single place player damage is ever applied,
   * so death can only happen here, exactly once per crossing.
   */
  private damagePlayer(player: InternalPlayer, amount: number): void {
    if (!player.alive) return;
    player.health = Math.max(0, player.health - amount);
    if (player.health === 0) {
      player.alive = false;
      this.persistHealth(player);
      this.wipePlayerOnDeath(player);
      return;
    }
    this.persistHealth(player);
  }

  /**
   * Death's cost: every building the player owns is removed from the shared
   * map (and its chest contents, if any, discarded with it), and their
   * inventory is emptied — a deliberate reversal of the earlier "death costs
   * nothing but time" design, now that dying has a real stake. Position and
   * health are respawn's job, not this one. Queues a PlayerDeathEvent for
   * net.ts to broadcast, since every other player's client needs to drop
   * this player's buildings from its own view of the shared map too.
   */
  private wipePlayerOnDeath(player: InternalPlayer): void {
    const removedBuildingIds: string[] = [];
    for (const building of [...this.buildingsById.values()]) {
      if (building.ownerId !== player.id) continue;
      this.unregisterBuilding(building);
      this.persistence.removeBuilding?.(building.id);
      removedBuildingIds.push(building.id);
    }

    player.inventory = emptyInventory();
    this.persistInventory(player);

    this.pendingDeathEvents.push({
      playerId: player.id,
      removedBuildingIds,
      inventory: { ...player.inventory },
    });
  }

  /**
   * Validates and applies a respawn: only a dead player may respawn.
   * Inventory and buildings were already cleared at the moment of death
   * (see wipePlayerOnDeath) — respawn itself restores health and position,
   * and also resets every enemy on the map (see resetAllEnemies) back to
   * full health at its spawn point, dead ones included — a respawn is a
   * fresh start at the fight, not a quiet continuation of wherever it left
   * off.
   */
  respawn(playerId: string): ActionResult {
    const player = this.players.get(playerId);
    if (!player) return { ok: false, reason: "unknown_player" };
    if (player.alive) return { ok: false, reason: "not_dead" };

    const spawn = this.map.spawnPoint;
    player.health = MAX_HEALTH;
    player.alive = true;
    player.x = spawn.x + 0.5;
    player.y = spawn.y + 0.5;
    player.inputDx = 0;
    player.inputDy = 0;
    this.persistHealth(player);
    this.resetAllEnemies();

    return { ok: true, health: player.health };
  }

  /**
   * Validates and applies a "play again" after the shared win condition has
   * already been hit: only valid once allEnemiesDefeated() is true (there's
   * nothing to reset otherwise), and it only resets enemies — unlike
   * respawn(), the requesting player is alive and mid-celebration, not dead,
   * so their health/position/inventory are left exactly as they are. Any
   * connected player can trigger it; net.ts broadcasts the reset to every
   * client so the whole room's victory screen clears together, not just the
   * requester's.
   */
  playAgain(playerId: string): ActionResult {
    if (!this.players.has(playerId)) return { ok: false, reason: "unknown_player" };
    if (!this.allEnemiesDefeated()) return { ok: false, reason: "not_won" };

    this.resetAllEnemies();
    return { ok: true };
  }

  /**
   * Resets every enemy on the map — alive or dead — back to full health at
   * its original spawn point. Called on every respawn (see respawn()) and
   * on playAgain() so neither leaves the fight partway won: the shared win
   * condition (allEnemiesDefeated) only means something if those paths
   * can't quietly dodge it by leaving already-dead enemies dead while
   * reviving everything else.
   */
  private resetAllEnemies(): void {
    for (const enemy of this.enemies.values()) {
      enemy.health = enemy.maxHealth;
      enemy.alive = true;
      enemy.x = enemy.spawnX;
      enemy.y = enemy.spawnY;
      enemy.lastContactAt = -Infinity;
      enemy.telegraphing = false;
      enemy.nextActionAt = -Infinity;
      enemy.routeCell = undefined;
    }
  }

  /**
   * Validates and applies using a bandage: consumes one, restores
   * BANDAGE_HEAL_AMOUNT health (clamped at MAX_HEALTH — healing at full
   * health, or past the cap, still costs the bandage; the client disables
   * the button at full health to steer players away from that, but the
   * server doesn't need to reject it for correctness).
   */
  useBandage(playerId: string, requestId: string): ActionResult {
    return this.withDedupe("bandage", playerId, requestId, () => this.doUseBandage(playerId));
  }

  private doUseBandage(playerId: string): ActionResult {
    const player = this.players.get(playerId);
    if (!player) return { ok: false, reason: "unknown_player" };
    if (!player.alive) return { ok: false, reason: "dead" };
    if (player.inventory.bandage <= 0) return { ok: false, reason: "insufficient_materials" };

    this.removeItem(player, "bandage", 1);
    player.health = Math.min(MAX_HEALTH, player.health + BANDAGE_HEAL_AMOUNT);
    this.persistHealth(player);
    this.persistInventory(player);

    return { ok: true, inventory: { ...player.inventory }, health: player.health };
  }
}

function cellKey(x: number, y: number): string {
  return `${x},${y}`;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/**
 * The 4 cardinal (non-diagonal) cell offsets both distanceFieldTo's BFS
 * expands through and stepToward's fallback ranks as candidate next steps.
 * Diagonal adjacency is deliberately excluded from both: the field's
 * distances would otherwise claim a diagonal shortcut past a solid corner
 * that tryAxisMove's per-axis movement check can't actually take in one
 * step (see stepToward's comment) — restricting both the field and its
 * candidates to the same 4 directions keeps "the field says it's closer"
 * and "tryAxisMove can actually get there" in sync.
 */
const CARDINAL_NEIGHBOURS: ReadonlyArray<readonly [number, number]> = [
  [1, 0],
  [-1, 0],
  [0, 1],
  [0, -1],
];
