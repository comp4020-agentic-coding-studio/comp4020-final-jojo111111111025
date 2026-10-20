import type { Building, DungeonMap, FarmPlotState, ItemKind, WorldMap, Zone } from "../shared/types.js";

export interface SnapshotPlayer {
  id: string;
  x: number;
  y: number;
  zone: Zone;
  health: number;
  alive: boolean;
  inventory: Record<ItemKind, number>;
}

export interface SnapshotEnemy {
  id: string;
  kind: string;
  zone: Zone;
  x: number;
  y: number;
  health: number;
  maxHealth: number;
  telegraphing: boolean;
}

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

export interface RosterPlayer {
  id: string;
  name: string;
  connected: boolean;
}

export interface ClientHandlers {
  onJoined: (playerId: string, roomCode: string) => void;
  onSnapshot: (
    world: WorldMap & { dungeon: DungeonMap },
    players: SnapshotPlayer[],
    buildings: Building[],
    farmPlots: FarmPlotState[],
    enemies: SnapshotEnemy[],
    beaconProgress: BeaconProgress,
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
    cropStage?: string;
    farmPlot?: FarmPlotState;
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
  onBeaconProgress: (progress: BeaconProgress) => void;
  onBeaconVictory: (activatedBy: string) => void;
  onError: (message: string) => void;
  onClose: () => void;
}

/** Errors the server sends that explain themselves — the client should not auto-retry these; something has to change first (name, room code) or the person must wait out the reconnect grace window. */
const TERMINAL_ERRORS = new Set(["invalid_room_code", "room_full", "superseded"]);

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
        this.handlers.onSnapshot(
          msg,
          msg.players,
          msg.buildings ?? [],
          msg.farmPlots ?? [],
          msg.enemies ?? [],
          msg.beaconProgress,
          msg.serverTime ?? Date.now(),
        );
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
      case "beacon.progress":
        this.handlers.onBeaconProgress(msg);
        break;
      case "beacon.victory":
        this.handlers.onBeaconVictory(msg.activatedBy);
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

  farmAction(
    buildingId: string,
    action: "plant" | "water" | "harvest",
    seedKind: string | undefined,
    requestId: string,
  ): void {
    this.send({ type: "farm.action", requestId, buildingId, action, seedKind });
  }

  respawn(requestId: string): void {
    this.send({ type: "player.respawn", requestId });
  }

  attack(targetId: string, requestId: string): void {
    this.send({ type: "combat.attack", requestId, targetId });
  }

  depositBeacon(itemKind: string, quantity: number, requestId: string): void {
    this.send({ type: "beacon.deposit", requestId, itemKind, quantity });
  }

  activateBeacon(requestId: string): void {
    this.send({ type: "beacon.activate", requestId });
  }

  enterZone(objectId: string, target: "overworld" | "dungeon", requestId: string): void {
    this.send({ type: "zone.enter", requestId, objectId, target });
  }

  private send(message: unknown): void {
    if (this.socket?.readyState === WebSocket.OPEN) {
      this.socket.send(JSON.stringify(message));
    }
  }
}
