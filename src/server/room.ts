import {
  ATTACK_COOLDOWN_MS,
  ATTACK_RANGE_TILES,
  BASE_ATTACK_DAMAGE,
  BEACON_RANGE_TILES,
  BEACON_REQUIRED_ANCIENT_CORE,
  BEACON_REQUIRED_STONE,
  BEACON_REQUIRED_WOOD,
  BOSS_ATTACK_DAMAGE,
  BOSS_ATTACK_RADIUS_TILES,
  BOSS_COOLDOWN_MS,
  BOSS_MAX_HEALTH,
  BOSS_WINDUP_MS,
  BUILD_RANGE_TILES,
  CAMPFIRE_SAFE_RADIUS_TILES,
  ENEMY_CONTACT_COOLDOWN_MS,
  ENEMY_CONTACT_RANGE_TILES,
  ENEMY_RESPAWN_MS,
  FARM_RANGE_TILES,
  GATHER_RANGE_TILES,
  GUARDIAN_AGGRO_RANGE_TILES,
  GUARDIAN_CONTACT_DAMAGE,
  GUARDIAN_MAX_HEALTH,
  GUARDIAN_SPEED_TILES_PER_SEC,
  ITEM_STACK_LIMIT,
  MAX_HEALTH,
  MAX_PLAYERS,
  PLAYER_RADIUS,
  PLAYER_SPEED_TILES_PER_SEC,
  SWORD_BONUS_DAMAGE,
  WANDERER_AGGRO_RANGE_TILES,
  WANDERER_CONTACT_DAMAGE,
  WANDERER_LEASH_RANGE_TILES,
  WANDERER_MAX_HEALTH,
  WANDERER_SPEED_TILES_PER_SEC,
  ZONE_TRANSITION_RANGE_TILES,
} from "../shared/constants.js";
import { computeTimeOfDay } from "../shared/daynight.js";
import { computeCropStage, SEED_TO_CROP } from "../shared/farming.js";
import { getRecipe } from "../shared/recipes.js";
import type {
  Building,
  BuildingKind,
  CropStage,
  EnemyKind,
  EnemySpawn,
  EnemyState,
  FarmPlotState,
  ItemKind,
  MapObject,
  MapTile,
  PlayerState,
  WorldMap,
  Zone,
} from "../shared/types.js";
import { SOLID_BUILDINGS, SOLID_OBJECTS, SOLID_TERRAIN, emptyInventory } from "../shared/types.js";

/** A material the beacon accepts deposits of. */
export type BeaconMaterial = "wood" | "stone" | "ancient_core";

export interface BeaconProgress {
  wood: number;
  stone: number;
  ancientCore: number;
  requiredWood: number;
  requiredStone: number;
  requiredAncientCore: number;
  bossDefeated: boolean;
  activated: boolean;
}

export interface ActionResult {
  ok: boolean;
  reason?: string;
  inventory?: Record<ItemKind, number>;
  objectRemaining?: number;
  recipeId?: string;
  buildingId?: string;
  chestItems?: Record<ItemKind, number>;
  cropStage?: CropStage;
  farmPlot?: FarmPlotState;
  health?: number;
  enemyHealth?: number;
  enemyDied?: boolean;
  damageDealt?: number;
}

/** Wire-safe view of an enemy — omits internal-only fields (contributors Set, spawn point, timers) that broadcasts never need. */
export interface EnemyView {
  id: string;
  kind: EnemyKind;
  zone: Zone;
  x: number;
  y: number;
  health: number;
  maxHealth: number;
  telegraphing: boolean;
}

export type FarmAction = "plant" | "water" | "harvest";

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
  farmPlot?: (plot: FarmPlotState) => void;
  /**
   * Called after a player's inventory changes. Keyed by the player's stable
   * identity id (Phase C), not a per-connection id, so it survives
   * reconnects and restarts — see `src/server/identity.ts`.
   */
  playerInventory?: (playerId: string, inventory: Record<ItemKind, number>) => void;
  /** Called after a player's health changes (damage, healing, or respawn). */
  playerHealth?: (playerId: string, health: number) => void;
  /** Called exactly once, the instant the boss dies. Returns false if persistence says it was already marked defeated (a redundant call never re-grants loot). */
  bossDefeated?: () => boolean;
  /** Called after a successful beacon deposit, adding (never setting) to that material's durable total. */
  beaconDeposit?: (kind: BeaconMaterial, qty: number) => void;
  /**
   * Called when a beacon.activate request passes every in-memory check.
   * Returns true only if persistence's own atomic check (a WHERE
   * completed_at IS NULL update) also wins the race — the same
   * "let the constraint resolve the race" pattern persistBuilding's
   * UNIQUE(x, y) and persistBossDefeated's WHERE already use. A false here
   * means another concurrent activate request already won; the caller must
   * not broadcast victory twice.
   */
  activateBeacon?: () => boolean;
  /**
   * Called for a boss-kill contributor who is no longer present in the
   * Room's own `players` map (evicted after a disconnect) by the time the
   * boss actually dies — queues their reward durably so it isn't silently
   * lost. Never called for a contributor who is still present; those are
   * granted directly to their live inventory, the same as before.
   */
  grantPendingReward?: (playerId: string, kind: ItemKind, qty: number, reason: string) => void;
}

/**
 * The single authoritative room for Phase A: one shared world, movement and
 * gathering are both applied synchronously (no `await` between reading and
 * writing player/object state), so JS's single-threaded execution is what
 * actually gives us atomicity here — there is no interleaving point for two
 * "requests" to race inside a tick or inside `interact`.
 */
export class Room {
  readonly map: WorldMap;
  private readonly players = new Map<string, InternalPlayer>();
  private readonly objectsById = new Map<string, MapObject>();
  /** Zone-qualified (`${zone}:${x},${y}`) — the dungeon and overworld are disjoint coordinate spaces that can share numeric (x, y), so every collision/lookup set here is keyed by zone first. */
  private readonly solidCells = new Set<string>();
  private readonly buildingsById = new Map<string, Building>();
  private readonly buildingsByCell = new Map<string, Building>();
  private readonly solidBuildingCells = new Set<string>();
  private readonly chestInventories = new Map<string, Record<ItemKind, number>>();
  private readonly farmPlots = new Map<string, FarmPlotState>();
  private readonly persistence: RoomPersistence;
  private readonly recentActions = new Map<string, ActionResult>();
  private readonly now: () => number;
  private readonly worldCreatedAt: number;
  private readonly enemies = new Map<string, EnemyState>();
  private bossAlreadyDefeated: boolean;
  private beaconActivated: boolean;
  private readonly beaconMaterials: Record<BeaconMaterial, number>;

  constructor(
    map: WorldMap,
    persistence: RoomPersistence = {},
    initialBuildings: Building[] = [],
    initialChestItems: Map<string, Record<ItemKind, number>> = new Map(),
    initialFarmPlots: FarmPlotState[] = [],
    now: () => number = Date.now,
    worldCreatedAt: number = now(),
    enemySpawns: EnemySpawn[] = [],
    bossAlreadyDefeated: boolean = false,
    initialBeaconMaterials: Partial<Record<BeaconMaterial, number>> = {},
    beaconActivated: boolean = false,
  ) {
    this.map = map;
    this.persistence = persistence;
    this.now = now;
    this.worldCreatedAt = worldCreatedAt;
    this.bossAlreadyDefeated = bossAlreadyDefeated;
    this.beaconActivated = beaconActivated;
    this.beaconMaterials = {
      wood: initialBeaconMaterials.wood ?? 0,
      stone: initialBeaconMaterials.stone ?? 0,
      ancient_core: initialBeaconMaterials.ancient_core ?? 0,
    };
    for (const obj of map.objects) {
      this.objectsById.set(obj.id, obj);
      if (SOLID_OBJECTS.has(obj.kind)) {
        this.solidCells.add(zoneCellKey(obj.zone ?? "overworld", obj.x, obj.y));
      }
    }
    for (const obj of map.dungeon.objects) {
      this.objectsById.set(obj.id, obj);
      if (SOLID_OBJECTS.has(obj.kind)) {
        this.solidCells.add(zoneCellKey(obj.zone ?? "dungeon", obj.x, obj.y));
      }
    }
    for (const building of initialBuildings) {
      this.registerBuilding(building);
      if (building.kind === "chest") {
        this.chestInventories.set(building.id, initialChestItems.get(building.id) ?? emptyInventory());
      }
    }
    for (const plot of initialFarmPlots) {
      this.farmPlots.set(plot.buildingId, plot);
    }
    let enemySeq = 0;
    for (const spawn of enemySpawns) {
      if (spawn.kind === "boss" && bossAlreadyDefeated) continue; // a defeated boss never respawns, even across a restart
      const id = `enemy-${spawn.kind}-${enemySeq++}`;
      const maxHealth =
        spawn.kind === "wanderer" ? WANDERER_MAX_HEALTH : spawn.kind === "guardian" ? GUARDIAN_MAX_HEALTH : BOSS_MAX_HEALTH;
      this.enemies.set(id, {
        id,
        kind: spawn.kind,
        zone: spawn.zone,
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
        contributors: new Set(),
        respawnAt: null,
      });
    }
  }

  /** Buildings are overworld-only (the dungeon is a fixed chamber with no player construction), so building cell keys are always zone-qualified as "overworld". */
  private registerBuilding(building: Building): void {
    this.buildingsById.set(building.id, building);
    this.buildingsByCell.set(zoneCellKey("overworld", building.x, building.y), building);
    if (SOLID_BUILDINGS.has(building.kind)) {
      this.solidBuildingCells.add(zoneCellKey("overworld", building.x, building.y));
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
      zone: "overworld",
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

  /** Advances the simulation by dtSeconds, applying movement + collision for every player, then enemy AI, contact damage, and due respawns. */
  tick(dtSeconds: number): void {
    for (const player of this.players.values()) {
      this.movePlayer(player, dtSeconds);
    }
    const now = this.now();
    for (const enemy of this.enemies.values()) {
      if (!enemy.alive) {
        if (enemy.respawnAt !== null && now >= enemy.respawnAt) {
          enemy.alive = true;
          enemy.health = enemy.maxHealth;
          enemy.x = enemy.spawnX;
          enemy.y = enemy.spawnY;
          enemy.lastContactAt = -Infinity;
          enemy.respawnAt = null;
        }
        continue;
      }
      this.tickEnemy(enemy, dtSeconds);
    }
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

  private nearestLivingPlayerInZone(zone: Zone, x: number, y: number): InternalPlayer | undefined {
    let best: InternalPlayer | undefined;
    let bestDist = Infinity;
    for (const player of this.players.values()) {
      if (!player.alive || player.zone !== zone) continue;
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
    const aggroRange = isWanderer ? WANDERER_AGGRO_RANGE_TILES : GUARDIAN_AGGRO_RANGE_TILES;
    const speed = isWanderer ? WANDERER_SPEED_TILES_PER_SEC : GUARDIAN_SPEED_TILES_PER_SEC;
    const contactDamage = isWanderer ? WANDERER_CONTACT_DAMAGE : GUARDIAN_CONTACT_DAMAGE;
    // Wanderers are passive by day — they simply don't aggro at all outside night.
    const canAggro = isWanderer ? this.isNight() : true;

    const target = canAggro ? this.nearestLivingPlayerInZone(enemy.zone, enemy.x, enemy.y) : undefined;
    const distToTarget = target ? Math.hypot(target.x - enemy.x, target.y - enemy.y) : Infinity;
    const distFromSpawn = Math.hypot(enemy.x - enemy.spawnX, enemy.y - enemy.spawnY);

    let moveX = 0;
    let moveY = 0;

    if (target && distToTarget <= aggroRange && !(isWanderer && this.isNearSafeCampfire(target.x, target.y))) {
      // Chase, unless pulled too far from spawn (wanderers only leash).
      if (!isWanderer || distFromSpawn <= WANDERER_LEASH_RANGE_TILES) {
        const dx = target.x - enemy.x;
        const dy = target.y - enemy.y;
        const len = Math.hypot(dx, dy) || 1;
        moveX = dx / len;
        moveY = dy / len;
      } else {
        // Leashed: head home instead.
        const dx = enemy.spawnX - enemy.x;
        const dy = enemy.spawnY - enemy.y;
        const len = Math.hypot(dx, dy);
        if (len > 0.1) {
          moveX = dx / len;
          moveY = dy / len;
        }
      }

      if (distToTarget <= ENEMY_CONTACT_RANGE_TILES) {
        const now = this.now();
        if (now - enemy.lastContactAt >= ENEMY_CONTACT_COOLDOWN_MS) {
          enemy.lastContactAt = now;
          this.damagePlayer(target, contactDamage);
        }
      }
    } else if (distFromSpawn > 0.3) {
      // No target: drift back toward spawn (a simple wander-home, not a full wander pattern).
      const dx = enemy.spawnX - enemy.x;
      const dy = enemy.spawnY - enemy.y;
      const len = Math.hypot(dx, dy);
      moveX = dx / len;
      moveY = dy / len;
    }

    if (moveX !== 0 || moveY !== 0) {
      const dist = speed * dtSeconds;
      const targetX = enemy.x + moveX * dist;
      const targetY = enemy.y + moveY * dist;
      if (!this.isEnemyBlocked(enemy.zone, targetX, enemy.y)) enemy.x = targetX;
      if (!this.isEnemyBlocked(enemy.zone, enemy.x, targetY)) enemy.y = targetY;
    }
  }

  /** The boss never moves — it telegraphs, then hits every living player within BOSS_ATTACK_RADIUS_TILES in its zone. No passive contact damage: the telegraphed cycle is its only damage source. */
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
      if (!player.alive || player.zone !== enemy.zone) continue;
      if (Math.hypot(player.x - enemy.x, player.y - enemy.y) <= BOSS_ATTACK_RADIUS_TILES) {
        this.damagePlayer(player, BOSS_ATTACK_DAMAGE);
      }
    }
  }

  /** Enemies use the same zone-qualified solid-cell checks as players, but ignore other enemies/players (no enemy-enemy or enemy-player collision, only contact-damage proximity). */
  private isEnemyBlocked(zone: Zone, x: number, y: number): boolean {
    return this.isCellBlocked(zone, Math.floor(x), Math.floor(y));
  }

  getEnemies(): EnemyView[] {
    return [...this.enemies.values()]
      .filter((e) => e.alive)
      .map((e) => ({
        id: e.id,
        kind: e.kind,
        zone: e.zone,
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

  /**
   * Validates and applies a player's melee attack on an enemy. Range,
   * cooldown, alive-target, and alive-attacker are all checked server-side —
   * the client reports only *who* it's attacking, never damage or timing.
   * Damage, the alive->dead transition, and loot payout all happen inside
   * this one synchronous call, so two "simultaneous" killing blows are
   * actually sequential turns of the event loop: whichever request runs
   * first sees the enemy alive and kills it; the second sees it already
   * dead and gets `already_dead`, never a second loot grant.
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
    if (enemy.zone !== player.zone) return { ok: false, reason: "wrong_zone" };

    const now = this.now();
    if (now - player.lastAttackAt < ATTACK_COOLDOWN_MS) return { ok: false, reason: "on_cooldown" };

    const dist = Math.hypot(player.x - enemy.x, player.y - enemy.y);
    if (dist > ATTACK_RANGE_TILES) return { ok: false, reason: "too_far" };

    player.lastAttackAt = now;
    const damage = BASE_ATTACK_DAMAGE + (player.inventory.sword > 0 ? SWORD_BONUS_DAMAGE : 0);
    enemy.health = Math.max(0, enemy.health - damage);

    if (enemy.kind === "boss") {
      enemy.contributors.add(playerId);
    }

    const died = enemy.health === 0;
    if (died) {
      enemy.alive = false;
      this.handleEnemyDeath(enemy);
    }

    return {
      ok: true,
      enemyHealth: enemy.health,
      enemyDied: died,
      damageDealt: damage,
    };
  }

  /** One-shot loot/respawn handling, called exactly once per enemy death — never from anywhere else. */
  private handleEnemyDeath(enemy: EnemyState): void {
    if (enemy.kind === "boss") {
      // Every contributor gets exactly one ancient_core, granted inside this
      // same synchronous death transition — there is no window for a
      // duplicate or a missed grant.
      const alreadyMarked = this.persistence.bossDefeated ? !this.persistence.bossDefeated() : false;
      // Set in-memory regardless of alreadyMarked: a redundant call means the
      // DB already knew, but this Room instance's own flag must still flip so
      // beacon.activate becomes reachable without waiting for a restart.
      this.bossAlreadyDefeated = true;
      if (alreadyMarked) return; // a redundant death-handling call (shouldn't happen, but never re-grant)
      for (const contributorId of enemy.contributors) {
        const contributor = this.players.get(contributorId);
        if (!contributor) {
          // Evicted (disconnected past their grace window) before this kill
          // landed — queue the reward durably rather than silently dropping
          // it. Claimed automatically the next time this stable identity
          // joins (see net.ts's room.join handler).
          this.persistence.grantPendingReward?.(contributorId, "ancient_core", 1, "boss_kill");
          continue;
        }
        this.addItem(contributor, "ancient_core", 1);
        this.persistInventory(contributor);
      }
      return;
    }

    // Trash enemies respawn fresh at their spawn point after a delay — timed
    // and applied by tick()'s own respawnAt check (see above), driven by the
    // same injected clock as everything else in Room. No setTimeout: a real
    // timer would run on wall-clock time regardless of an injected fake
    // clock, and would outlive this Room instance with nothing to cancel it.
    enemy.respawnAt = this.now() + ENEMY_RESPAWN_MS;
  }

  /** The tile grid and dimensions for a given zone — the dungeon is a disjoint coordinate space with its own grid, not a region of the overworld's. */
  private zoneBounds(zone: Zone): { width: number; height: number; tiles: MapTile[] } {
    return zone === "overworld"
      ? { width: this.map.width, height: this.map.height, tiles: this.map.tiles }
      : { width: this.map.dungeon.width, height: this.map.dungeon.height, tiles: this.map.dungeon.tiles };
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
    const bounds = this.zoneBounds(player.zone);

    if (!this.isBlocked(player.zone, targetX, player.y)) player.x = this.clampToMap(targetX, bounds.width);
    if (!this.isBlocked(player.zone, player.x, targetY)) player.y = this.clampToMap(targetY, bounds.height);
  }

  private clampToMap(value: number, size: number): number {
    return clamp(value, PLAYER_RADIUS, size - PLAYER_RADIUS);
  }

  /** True if a player-sized circle centred at (x, y) in `zone` would overlap a solid tile, object, or placed building. */
  private isBlocked(zone: Zone, x: number, y: number): boolean {
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
      if (this.isCellBlocked(zone, cx, cy)) return true;
    }
    return false;
  }

  /** True if the integer cell (cx, cy) in `zone` is out of bounds or occupied by solid terrain, a world object, or (overworld only) a building. */
  private isCellBlocked(zone: Zone, cx: number, cy: number): boolean {
    const bounds = this.zoneBounds(zone);
    if (cx < 0 || cy < 0 || cx >= bounds.width || cy >= bounds.height) return true;
    const tile = bounds.tiles[cy * bounds.width + cx];
    if (tile && SOLID_TERRAIN.has(tile.terrain)) return true;
    if (this.solidCells.has(zoneCellKey(zone, cx, cy))) return true;
    if (zone === "overworld" && this.solidBuildingCells.has(zoneCellKey("overworld", cx, cy))) return true;
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
   * every mutating action (gather, craft, build, farm).
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
    if ((object.zone ?? "overworld") !== player.zone) return { ok: false, reason: "wrong_zone" };

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
    // Buildings are an overworld-only concept — the dungeon is a fixed
    // chamber with no construction, so a build request only ever makes
    // sense from a player who is actually in the overworld.
    if (player.zone !== "overworld") return { ok: false, reason: "wrong_zone", recipeId };

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

    if (this.isCellBlocked("overworld", cx, cy) || this.buildingsByCell.has(zoneCellKey("overworld", cx, cy))) {
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
    if (building.kind === "farm_plot") {
      this.farmPlots.set(building.id, {
        buildingId: building.id,
        seedKind: null,
        plantedAt: null,
        wateredAt: null,
      });
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
    // Chests are only ever placed in the overworld (see doBuild), so a
    // dungeon-side player can never be in range of one anyway — this is an
    // explicit check rather than relying on that incidentally being true.
    if (player.zone !== "overworld") return { ok: false, reason: "wrong_zone" };

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

  /** The farm plot's current stage, derived purely from its stored timestamps and the current time — see computeCropStage. */
  getCropStage(buildingId: string): CropStage | undefined {
    const plot = this.farmPlots.get(buildingId);
    if (!plot) return undefined;
    return computeCropStage(plot, this.now());
  }

  getFarmPlots(): FarmPlotState[] {
    return [...this.farmPlots.values()];
  }

  /**
   * Validates and applies plant/water/harvest. Every sub-action requires
   * proximity to the plot. plant requires an empty plot and consumes a seed;
   * water just stamps wateredAt; harvest requires the derived stage to be
   * "mature" and, on success, clears the plot back to empty in the same call
   * that grants the reward — so a second harvest attempt immediately reads
   * as "not_mature"/empty rather than being able to re-claim the same crop.
   */
  farmAction(
    playerId: string,
    buildingId: string,
    action: FarmAction,
    seedKind: ItemKind | undefined,
    requestId: string,
  ): ActionResult {
    return this.withDedupe("farm", playerId, requestId, () =>
      this.doFarmAction(playerId, buildingId, action, seedKind),
    );
  }

  private doFarmAction(
    playerId: string,
    buildingId: string,
    action: FarmAction,
    seedKind: ItemKind | undefined,
  ): ActionResult {
    const player = this.players.get(playerId);
    if (!player) return { ok: false, reason: "unknown_player" };
    if (!player.alive) return { ok: false, reason: "dead" };
    // Farm plots are only ever placed in the overworld (see doBuild).
    if (player.zone !== "overworld") return { ok: false, reason: "wrong_zone" };

    const building = this.buildingsById.get(buildingId);
    if (!building || building.kind !== "farm_plot") return { ok: false, reason: "unknown_plot" };

    const plot = this.farmPlots.get(buildingId);
    if (!plot) return { ok: false, reason: "unknown_plot" };

    const dist = Math.hypot(player.x - (building.x + 0.5), player.y - (building.y + 0.5));
    if (dist > FARM_RANGE_TILES) return { ok: false, reason: "too_far" };

    const now = this.now();
    const stage = computeCropStage(plot, now);

    if (action === "plant") {
      if (stage !== "empty") return { ok: false, reason: "plot_occupied" };
      if (!seedKind || !(seedKind in SEED_TO_CROP)) return { ok: false, reason: "invalid_seed" };
      if (player.inventory[seedKind] < 1) return { ok: false, reason: "insufficient_materials" };

      this.removeItem(player, seedKind, 1);
      const newPlot: FarmPlotState = { buildingId, seedKind, plantedAt: now, wateredAt: null };
      this.farmPlots.set(buildingId, newPlot);
      this.persistence.farmPlot?.(newPlot);
      this.persistInventory(player);

      return {
        ok: true,
        inventory: { ...player.inventory },
        cropStage: computeCropStage(newPlot, now),
        buildingId,
        farmPlot: newPlot,
      };
    }

    if (action === "water") {
      if (stage === "empty") return { ok: false, reason: "plot_empty" };
      if (stage === "mature") return { ok: false, reason: "already_mature" };

      const newPlot: FarmPlotState = { ...plot, wateredAt: now };
      this.farmPlots.set(buildingId, newPlot);
      this.persistence.farmPlot?.(newPlot);

      return { ok: true, cropStage: computeCropStage(newPlot, now), buildingId, farmPlot: newPlot };
    }

    // harvest
    if (stage !== "mature") return { ok: false, reason: "not_mature" };
    const cropKind = SEED_TO_CROP[plot.seedKind!];
    if (!cropKind) return { ok: false, reason: "invalid_seed" };

    const granted = this.addItem(player, cropKind, 1);
    if (granted <= 0) return { ok: false, reason: "inventory_full" };

    const newPlot: FarmPlotState = { buildingId, seedKind: null, plantedAt: null, wateredAt: null };
    this.farmPlots.set(buildingId, newPlot);
    this.persistence.farmPlot?.(newPlot);
    this.persistInventory(player);

    return { ok: true, inventory: { ...player.inventory }, cropStage: "empty", buildingId, farmPlot: newPlot };
  }

  /** Whether it's currently night, purely derived from elapsed time since world creation — see computeTimeOfDay. */
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
    player.zone = "overworld";
    player.x = spawn.x + 0.5;
    player.y = spawn.y + 0.5;
    player.inputDx = 0;
    player.inputDy = 0;
    this.persistHealth(player);

    return { ok: true, health: player.health };
  }

  /** The beacon's current shared progress — the static requirements alongside the durable totals, so a client can render both from one message. */
  getBeaconProgress(): BeaconProgress {
    return {
      wood: this.beaconMaterials.wood,
      stone: this.beaconMaterials.stone,
      ancientCore: this.beaconMaterials.ancient_core,
      requiredWood: BEACON_REQUIRED_WOOD,
      requiredStone: BEACON_REQUIRED_STONE,
      requiredAncientCore: BEACON_REQUIRED_ANCIENT_CORE,
      bossDefeated: this.bossAlreadyDefeated,
      activated: this.beaconActivated,
    };
  }

  private beaconObject(): MapObject | undefined {
    return this.map.dungeon.objects.find((o) => o.kind === "ancient_beacon");
  }

  /**
   * Validates and applies a beacon material deposit. The player must be in
   * the dungeon, in range of the beacon, and hold at least `qty` of `kind` —
   * deposited materials are removed from inventory and added to the shared,
   * durable pool in the same synchronous call, so two concurrent deposits
   * from different players both land (this is additive, not a single slot
   * a second request could race the first out of — unlike beacon.activate,
   * which is a one-shot transition and does need that race resolved).
   */
  depositBeacon(playerId: string, kind: BeaconMaterial, qty: number, requestId: string): ActionResult {
    return this.withDedupe("beacon-deposit", playerId, requestId, () => this.doDepositBeacon(playerId, kind, qty));
  }

  private doDepositBeacon(playerId: string, kind: BeaconMaterial, qty: number): ActionResult {
    const player = this.players.get(playerId);
    if (!player) return { ok: false, reason: "unknown_player" };
    if (!player.alive) return { ok: false, reason: "dead" };
    if (player.zone !== "dungeon") return { ok: false, reason: "wrong_zone" };
    if (qty <= 0) return { ok: false, reason: "invalid_quantity" };

    const beacon = this.beaconObject();
    if (!beacon) return { ok: false, reason: "unknown_object" };
    const dist = Math.hypot(player.x - (beacon.x + 0.5), player.y - (beacon.y + 0.5));
    if (dist > BEACON_RANGE_TILES) return { ok: false, reason: "too_far" };

    if (player.inventory[kind] < qty) return { ok: false, reason: "insufficient_materials" };

    this.removeItem(player, kind, qty);
    this.beaconMaterials[kind] += qty;
    this.persistence.beaconDeposit?.(kind, qty);
    this.persistInventory(player);

    return { ok: true, inventory: { ...player.inventory } };
  }

  /**
   * Validates and applies beacon activation: the player must be in the
   * dungeon, in range, the boss must already be defeated, and every
   * material requirement must be met. The persistence layer's own atomic
   * check (activateBeacon's WHERE completed_at IS NULL) is what actually
   * resolves a race between two concurrent activate requests — in-memory
   * `beaconActivated` is set only after persistence confirms this call won,
   * so a losing concurrent call sees `already_activated` rather than a
   * second victory broadcast going out.
   */
  activateBeacon(playerId: string, requestId: string): ActionResult {
    return this.withDedupe("beacon-activate", playerId, requestId, () => this.doActivateBeacon(playerId));
  }

  private doActivateBeacon(playerId: string): ActionResult {
    const player = this.players.get(playerId);
    if (!player) return { ok: false, reason: "unknown_player" };
    if (!player.alive) return { ok: false, reason: "dead" };
    if (player.zone !== "dungeon") return { ok: false, reason: "wrong_zone" };
    if (this.beaconActivated) return { ok: false, reason: "already_activated" };
    if (!this.bossAlreadyDefeated) return { ok: false, reason: "boss_not_defeated" };

    const beacon = this.beaconObject();
    if (!beacon) return { ok: false, reason: "unknown_object" };
    const dist = Math.hypot(player.x - (beacon.x + 0.5), player.y - (beacon.y + 0.5));
    if (dist > BEACON_RANGE_TILES) return { ok: false, reason: "too_far" };

    if (
      this.beaconMaterials.wood < BEACON_REQUIRED_WOOD ||
      this.beaconMaterials.stone < BEACON_REQUIRED_STONE ||
      this.beaconMaterials.ancient_core < BEACON_REQUIRED_ANCIENT_CORE
    ) {
      return { ok: false, reason: "insufficient_materials" };
    }

    if (this.persistence.activateBeacon && !this.persistence.activateBeacon()) {
      // Lost the race to a concurrent activate that committed first.
      this.beaconActivated = true;
      return { ok: false, reason: "already_activated" };
    }

    this.beaconActivated = true;
    return { ok: true };
  }

  /**
   * Validates and applies a zone transition through a specific
   * dungeon_entrance/dungeon_exit object: the object must exist, the player
   * must be in that object's own zone (never the target zone — you can't
   * "enter the dungeon" by using the exit that's already inside it) and
   * within range of it, and `target` must actually be the other zone. On
   * success the player's position is moved to the destination zone's own
   * entry point, so they never retain overworld/dungeon coordinates that
   * happen to overlap the other zone's space.
   */
  enterZone(playerId: string, objectId: string, target: Zone, requestId: string): ActionResult {
    return this.withDedupe("zone-enter", playerId, requestId, () => this.doEnterZone(playerId, objectId, target));
  }

  private doEnterZone(playerId: string, objectId: string, target: Zone): ActionResult {
    const player = this.players.get(playerId);
    if (!player) return { ok: false, reason: "unknown_player" };
    if (!player.alive) return { ok: false, reason: "dead" };

    const object = this.objectsById.get(objectId);
    if (!object) return { ok: false, reason: "unknown_object" };
    if (object.kind !== "dungeon_entrance" && object.kind !== "dungeon_exit") {
      return { ok: false, reason: "not_a_zone_transition" };
    }

    const objectZone = object.zone ?? "overworld";
    if (objectZone !== player.zone) return { ok: false, reason: "wrong_zone" };
    if (target === player.zone) return { ok: false, reason: "already_in_zone" };

    const dist = Math.hypot(player.x - (object.x + 0.5), player.y - (object.y + 0.5));
    if (dist > ZONE_TRANSITION_RANGE_TILES) return { ok: false, reason: "too_far" };

    player.zone = target;
    if (target === "dungeon") {
      player.x = this.map.dungeon.entryPoint.x + 0.5;
      player.y = this.map.dungeon.entryPoint.y + 0.5;
    } else {
      player.x = this.map.dungeonEntrance.x + 0.5;
      player.y = this.map.dungeonEntrance.y + 0.5;
    }
    player.inputDx = 0;
    player.inputDy = 0;

    return { ok: true };
  }
}

function zoneCellKey(zone: Zone, x: number, y: number): string {
  return `${zone}:${x},${y}`;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}
