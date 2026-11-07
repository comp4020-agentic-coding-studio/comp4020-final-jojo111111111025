import {
  ATTACK_COOLDOWN_MS,
  ATTACK_RANGE_TILES,
  BASE_ATTACK_DAMAGE,
  BOSS_ATTACK_DAMAGE,
  BOSS_ATTACK_RADIUS_TILES,
  BOSS_COOLDOWN_MS,
  BOSS_MAX_HEALTH,
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
  PLAYER_RADIUS,
  PLAYER_SPEED_TILES_PER_SEC,
  SWORD_BONUS_DAMAGE,
  WANDERER_CONTACT_DAMAGE,
  WANDERER_MAX_HEALTH,
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

export type ChestDirection = "deposit" | "withdraw";

interface InternalPlayer extends PlayerState {
  inputDx: number;
  inputDy: number;
  lastAttackAt: number;
}

/**
 * Persistence hooks the Room calls after an in-memory mutation succeeds. All
 * optional — tests can omit them entirely.
 */
export interface RoomPersistence {
  nodeRemaining?: (objectId: string, remaining: number) => void;
  /** Called after an in-memory building placement succeeds. Returns false if persistence itself rejects it (e.g. a UNIQUE(x, y) race lost to a concurrent request) — the caller then rolls back the in-memory placement too. */
  building?: (building: Building) => boolean;
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
    const speed = isWanderer ? WANDERER_SPEED_TILES_PER_SEC : GUARDIAN_SPEED_TILES_PER_SEC;
    const contactDamage = isWanderer ? WANDERER_CONTACT_DAMAGE : GUARDIAN_CONTACT_DAMAGE;

    // Every enemy chases unconditionally from the moment it exists — no
    // aggro range, no leash, no day/night passivity (day/night is
    // visual/ambience only; see constants.ts's note). The only thing that
    // still holds an enemy back is a placed campfire's safe radius (the
    // brief's "defensive structure reduces danger" note), which still only
    // applies to wanderers.
    const target = this.nearestLivingPlayer(enemy.x, enemy.y);

    let moveX = 0;
    let moveY = 0;

    if (target && !(isWanderer && this.isNearSafeCampfire(target.x, target.y))) {
      const dx = target.x - enemy.x;
      const dy = target.y - enemy.y;
      const len = Math.hypot(dx, dy) || 1;
      moveX = dx / len;
      moveY = dy / len;

      if (len <= ENEMY_CONTACT_RANGE_TILES) {
        const now = this.now();
        if (now - enemy.lastContactAt >= ENEMY_CONTACT_COOLDOWN_MS) {
          enemy.lastContactAt = now;
          this.damagePlayer(target, contactDamage);
        }
      }
    }

    if (moveX !== 0 || moveY !== 0) {
      const dist = speed * dtSeconds;
      const targetX = enemy.x + moveX * dist;
      const targetY = enemy.y + moveY * dist;
      if (!this.isEnemyBlocked(targetX, enemy.y)) enemy.x = targetX;
      if (!this.isEnemyBlocked(enemy.x, targetY)) enemy.y = targetY;
    }
  }

  /** The boss never moves — it telegraphs, then hits every living player within BOSS_ATTACK_RADIUS_TILES. No passive contact damage: the telegraphed cycle is its only damage source. */
  private tickBoss(enemy: EnemyState, _dtSeconds: number): void {
    const now = this.now();
    if (now < enemy.nextActionAt) return;

    if (!enemy.telegraphing) {
      enemy.telegraphing = true;
      enemy.nextActionAt = now + BOSS_WINDUP_MS;
      return;
    }

    // Windup finished: land the hit.
    enemy.telegraphing = false;
    enemy.nextActionAt = now + BOSS_COOLDOWN_MS;
    for (const player of this.players.values()) {
      if (!player.alive) continue;
      if (Math.hypot(player.x - enemy.x, player.y - enemy.y) <= BOSS_ATTACK_RADIUS_TILES) {
        this.damagePlayer(player, BOSS_ATTACK_DAMAGE);
      }
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
    const damage = BASE_ATTACK_DAMAGE + (player.inventory.sword > 0 ? SWORD_BONUS_DAMAGE : 0);
    enemy.health = Math.max(0, enemy.health - damage);

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
    return [...this.players.values()].map(({ inputDx, inputDy, lastAttackAt, ...rest }) => rest);
  }

  getBuildings(): Building[] {
    return [...this.buildingsById.values()];
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

    const granted = this.addItem(player, object.resource.kind, 1);
    if (granted <= 0) return { ok: false, reason: "inventory_full" };

    object.resource.remaining -= 1;
    this.persistence.nodeRemaining?.(object.id, object.resource.remaining);
    this.persistInventory(player);

    return {
      ok: true,
      inventory: { ...player.inventory },
      objectRemaining: object.resource.remaining,
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
    }
    this.persistHealth(player);
  }

  /**
   * Validates and applies a respawn: only a dead player may respawn, and
   * respawning never touches inventory — death costs nothing but time,
   * matching the project's documented "no item loss on death" rule.
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

    return { ok: true, health: player.health };
  }
}

function cellKey(x: number, y: number): string {
  return `${x},${y}`;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}
