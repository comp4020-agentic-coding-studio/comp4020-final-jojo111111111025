import type { Building, ItemKind, WorldMap } from "../shared/types.js";
import { ITEM_KINDS, SOLID_OBJECTS, SOLID_TERRAIN } from "../shared/types.js";

export interface SnapshotPlayer {
  id: string;
  x: number;
  y: number;
  health: number;
  alive: boolean;
  inventory: Record<ItemKind, number>;
}

export interface SnapshotEnemy {
  id: string;
  kind: string;
  x: number;
  y: number;
  health: number;
  maxHealth: number;
  telegraphing: boolean;
}

export interface RosterPlayer {
  id: string;
  name: string;
  connected: boolean;
}

export interface ClientHandlers {
  onJoined: (playerId: string, roomCode: string) => void;
  onSnapshot: (
    world: WorldMap,
    players: SnapshotPlayer[],
    buildings: Building[],
    enemies: SnapshotEnemy[],
    serverTime: number,
  ) => void;
  onRoster: (players: RosterPlayer[]) => void;
  onPlayerState: (
    players: Array<{ id: string; x: number; y: number; health: number; alive: boolean }>,
    enemies: Array<{ id: string; x: number; y: number; health: number; telegraphing: boolean }>,
    isNight: boolean,
  ) => void;
  onActionResult: (result: {
    requestId: string;
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
  }) => void;
  onEntitySpawned: (building: Building) => void;
  onCombatEvent: (event: {
    attackerId: string;
    targetId: string;
    damage: number;
    enemyHealth: number;
    enemyDied: boolean;
  }) => void;
  onObjectDepleted: (event: { objectId: string; remaining: number }) => void;
  /** Fired exactly once, the instant the killing blow leaves every enemy on the map dead — the room's shared win condition. */
  onGameVictory: (lastKillBy: string) => void;
  onError: (message: string) => void;
  onClose: () => void;
}

/** Errors the server sends that explain themselves — the client should not auto-retry these; something has to change first (name, room code) or the person must wait out the reconnect grace window. */
const TERMINAL_ERRORS = new Set(["invalid_room_code", "room_full", "superseded"]);

/**
 * Updates the depleted object's `resource.remaining` in place. An
 * `object.depleted` broadcast reaches every player in the room, so the
 * object is looked up by id in `world.objects` directly. The object itself
 * is never removed, even once `remaining` reaches 0 — it stays visible
 * (render.ts draws a depleted node differently, it doesn't hide it) so a
 * player can still see where it was and that it'll regrow.
 */
export function applyObjectDepleted(world: WorldMap | null, event: { objectId: string; remaining: number }): void {
  if (!world) return;
  const obj = world.objects.find((o) => o.id === event.objectId);
  if (obj?.resource) obj.resource.remaining = event.remaining;
}

/**
 * Finds which ItemKind increased between a pre-gather inventory snapshot
 * and a gather's resulting inventory, for the pickup toast's "Gathered
 * {item}." message — a player.interact (gather) result's `inventory`
 * field never says which resource kind was granted on its own (see
 * room.ts's doInteract), so it's derived by diffing. Returns undefined if
 * nothing increased (shouldn't happen for a successful gather, but a
 * caller showing a generic fallback message is cheaper than this function
 * asserting an invariant it can't enforce).
 */
export function findGainedItem(
  before: Record<ItemKind, number>,
  after: Record<ItemKind, number>,
): ItemKind | undefined {
  return ITEM_KINDS.find((kind) => (after[kind] ?? 0) > (before[kind] ?? 0));
}

/**
 * Mirrors Room.doBuild's occupancy check — isCellBlocked's terrain/world-
 * object rule, plus "any building at all on this cell blocks a new one"
 * (doBuild's own separate buildingsByCell check, which is stricter than
 * isCellBlocked alone: even a non-solid `floor` building occupies its cell
 * against a second placement) — purely for the build-target preview ring's
 * colour in main.ts. A local, non-authoritative guess so the ring can read
 * green/red before the player commits to a placement, never a substitute
 * for the server's own doBuild validation, which re-checks everything
 * server-side regardless of what this says.
 */
export function isBuildCellFree(
  world: WorldMap | null,
  buildings: ReadonlyMap<string, Building>,
  cx: number,
  cy: number,
): boolean {
  if (!world) return false;
  if (cx < 0 || cy < 0 || cx >= world.width || cy >= world.height) return false;
  const tile = world.tiles[cy * world.width + cx];
  if (tile && SOLID_TERRAIN.has(tile.terrain)) return false;
  for (const obj of world.objects) {
    if (obj.x === cx && obj.y === cy && SOLID_OBJECTS.has(obj.kind)) return false;
  }
  for (const building of buildings.values()) {
    if (building.x === cx && building.y === cy) return false;
  }
  return true;
}

export class GameClient {
  private socket: WebSocket | null = null;
  private seq = 0;
  private lastName = "";
  private lastRoomCode = "";
  private retryAttempt = 0;
  private stopped = false;
  private lastErrorWasTerminal = false;

  constructor(private readonly handlers: ClientHandlers) {}

  connect(name: string, roomCode: string): void {
    this.lastName = name;
    this.lastRoomCode = roomCode;
    this.stopped = false;
    this.retryAttempt = 0;
    this.lastErrorWasTerminal = false;
    this.openSocket();
  }

  /** Stops any pending auto-reconnect attempts (e.g. the user navigated away from the join flow). */
  disconnect(): void {
    this.stopped = true;
    this.socket?.close();
  }

  private openSocket(): void {
    const protocol = location.protocol === "https:" ? "wss" : "ws";
    const socket = new WebSocket(`${protocol}://${location.host}/ws`);
    this.socket = socket;

    socket.addEventListener("open", () => {
      this.retryAttempt = 0;
      this.send({ type: "room.join", requestId: crypto.randomUUID(), name: this.lastName, roomCode: this.lastRoomCode });
    });

    socket.addEventListener("message", (event) => {
      let msg: any;
      try {
        msg = JSON.parse(event.data);
      } catch {
        return;
      }
      this.dispatch(msg);
    });

    socket.addEventListener("close", () => {
      this.handlers.onClose();
      if (this.stopped || this.lastErrorWasTerminal) return;
      // The identity cookie persists across the retry, so if the server
      // still recognises this player within its reconnect grace window,
      // rejoining restores the same room slot and state.
      if (this.retryAttempt < 5) {
        this.retryAttempt++;
        setTimeout(() => {
          if (!this.stopped) this.openSocket();
        }, Math.min(1000 * this.retryAttempt, 5000));
      }
    });
  }

  private dispatch(msg: any): void {
    switch (msg.type) {
      case "room.joined":
        this.handlers.onJoined(msg.playerId, msg.roomCode);
        break;
      case "world.snapshot":
        this.handlers.onSnapshot(msg, msg.players, msg.buildings ?? [], msg.enemies ?? [], msg.serverTime ?? Date.now());
        break;
      case "room.roster":
        this.handlers.onRoster(msg.players);
        break;
      case "player.state":
        this.handlers.onPlayerState(msg.players, msg.enemies ?? [], msg.isNight ?? false);
        break;
      case "action.result":
        this.handlers.onActionResult(msg);
        break;
      case "entity.spawned":
        this.handlers.onEntitySpawned(msg.building);
        break;
      case "combat.event":
        this.handlers.onCombatEvent(msg);
        break;
      case "object.depleted":
        this.handlers.onObjectDepleted(msg);
        break;
      case "game.victory":
        this.handlers.onGameVictory(msg.lastKillBy);
        break;
      case "server.error":
        this.lastErrorWasTerminal = TERMINAL_ERRORS.has(msg.message);
        this.handlers.onError(msg.message);
        break;
    }
  }

  sendInput(dx: number, dy: number): void {
    this.send({ type: "player.input", seq: this.seq++, dx, dy });
  }

  interact(objectId: string, requestId: string): void {
    this.send({ type: "player.interact", requestId, objectId });
  }

  craft(recipeId: string, requestId: string): void {
    this.send({ type: "craft.request", requestId, recipeId });
  }

  build(recipeId: string, x: number, y: number, requestId: string): void {
    this.send({ type: "building.place", requestId, recipeId, x, y });
  }

  chestTransfer(
    chestId: string,
    itemKind: string,
    quantity: number,
    direction: "deposit" | "withdraw",
    requestId: string,
  ): void {
    this.send({ type: "chest.transfer", requestId, chestId, itemKind, quantity, direction });
  }

  respawn(requestId: string): void {
    this.send({ type: "player.respawn", requestId });
  }

  attack(targetId: string, requestId: string): void {
    this.send({ type: "combat.attack", requestId, targetId });
  }

  private send(message: unknown): void {
    if (this.socket?.readyState === WebSocket.OPEN) {
      this.socket.send(JSON.stringify(message));
    }
  }
}
