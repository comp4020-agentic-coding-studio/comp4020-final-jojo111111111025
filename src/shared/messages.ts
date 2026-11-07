import { z } from "zod";

// --- Client -> server --------------------------------------------------

export const RoomJoinMessage = z.object({
  type: z.literal("room.join"),
  requestId: z.string().min(1).max(64),
  name: z.string().min(1).max(24),
  roomCode: z.string().min(1).max(32),
});

export const PlayerInputMessage = z.object({
  type: z.literal("player.input"),
  seq: z.number().int().nonnegative(),
  dx: z.number().min(-1).max(1),
  dy: z.number().min(-1).max(1),
});

export const PlayerInteractMessage = z.object({
  type: z.literal("player.interact"),
  requestId: z.string().min(1).max(64),
  objectId: z.string().min(1).max(64),
});

export const CraftRequestMessage = z.object({
  type: z.literal("craft.request"),
  requestId: z.string().min(1).max(64),
  recipeId: z.string().min(1).max(64),
});

export const BuildingPlaceMessage = z.object({
  type: z.literal("building.place"),
  requestId: z.string().min(1).max(64),
  recipeId: z.string().min(1).max(64),
  x: z.number(),
  y: z.number(),
});

export const ChestTransferMessage = z.object({
  type: z.literal("chest.transfer"),
  requestId: z.string().min(1).max(64),
  chestId: z.string().min(1).max(64),
  itemKind: z.string().min(1).max(32),
  quantity: z.number().int().positive().max(99),
  direction: z.enum(["deposit", "withdraw"]),
});

export const PlayerRespawnMessage = z.object({
  type: z.literal("player.respawn"),
  requestId: z.string().min(1).max(64),
});

export const CombatAttackMessage = z.object({
  type: z.literal("combat.attack"),
  requestId: z.string().min(1).max(64),
  targetId: z.string().min(1).max(64),
});

export const UseBandageMessage = z.object({
  type: z.literal("item.useBandage"),
  requestId: z.string().min(1).max(64),
});

export const ClientMessage = z.discriminatedUnion("type", [
  RoomJoinMessage,
  PlayerInputMessage,
  PlayerInteractMessage,
  CraftRequestMessage,
  BuildingPlaceMessage,
  ChestTransferMessage,
  PlayerRespawnMessage,
  CombatAttackMessage,
  UseBandageMessage,
]);

export type ClientMessage = z.infer<typeof ClientMessage>;

/** Hard cap on raw incoming message size, enforced before JSON.parse. */
export const MAX_CLIENT_MESSAGE_BYTES = 4096;

// --- Server -> client ----------------------------------------------------

export const RoomJoinedMessage = z.object({
  type: z.literal("room.joined"),
  requestId: z.string(),
  playerId: z.string(),
  roomCode: z.string(),
});

export const RoomRosterMessage = z.object({
  type: z.literal("room.roster"),
  players: z.array(
    z.object({
      id: z.string(),
      name: z.string(),
      connected: z.boolean(),
    }),
  ),
});

const MapObjectSchema = z.object({
  id: z.string(),
  kind: z.string(),
  x: z.number(),
  y: z.number(),
  resource: z.object({ kind: z.string(), remaining: z.number(), maxRemaining: z.number() }).optional(),
});

export const WorldSnapshotMessage = z.object({
  type: z.literal("world.snapshot"),
  seed: z.string(),
  width: z.number(),
  height: z.number(),
  tiles: z.array(z.object({ terrain: z.string() })),
  objects: z.array(MapObjectSchema),
  players: z.array(
    z.object({
      id: z.string(),
      name: z.string(),
      x: z.number(),
      y: z.number(),
      health: z.number(),
      alive: z.boolean(),
      inventory: z.record(z.string(), z.number()),
      connected: z.boolean(),
    }),
  ),
  worldCreatedAt: z.number(),
  buildings: z.array(
    z.object({
      id: z.string(),
      kind: z.string(),
      x: z.number(),
      y: z.number(),
      ownerId: z.string(),
      placedAt: z.number(),
    }),
  ),
  enemies: z.array(
    z.object({
      id: z.string(),
      kind: z.string(),
      x: z.number(),
      y: z.number(),
      health: z.number(),
      maxHealth: z.number(),
      telegraphing: z.boolean(),
    }),
  ),
  serverTime: z.number(),
});

export const PlayerStateMessage = z.object({
  type: z.literal("player.state"),
  players: z.array(
    z.object({ id: z.string(), x: z.number(), y: z.number(), health: z.number(), alive: z.boolean() }),
  ),
  enemies: z.array(
    z.object({ id: z.string(), x: z.number(), y: z.number(), health: z.number(), telegraphing: z.boolean() }),
  ),
  isNight: z.boolean(),
});

export const ActionResultMessage = z.object({
  type: z.literal("action.result"),
  requestId: z.string(),
  ok: z.boolean(),
  reason: z.string().optional(),
  inventory: z.record(z.string(), z.number()).optional(),
  objectRemaining: z.number().optional(),
  recipeId: z.string().optional(),
  buildingId: z.string().optional(),
  chestItems: z.record(z.string(), z.number()).optional(),
  health: z.number().optional(),
  enemyHealth: z.number().optional(),
  enemyDied: z.boolean().optional(),
  damageDealt: z.number().optional(),
});

/** Broadcast to every connected client the instant an attack lands, so everyone sees the hit/damage/death, not just the attacker. */
export const CombatEventMessage = z.object({
  type: z.literal("combat.event"),
  attackerId: z.string(),
  targetId: z.string(),
  damage: z.number(),
  enemyHealth: z.number(),
  enemyDied: z.boolean(),
});

/** Broadcast to every connected client the instant a resource node is gathered, so everyone's view of its remaining yield stays in sync, not just the gatherer's. */
export const ObjectDepletedMessage = z.object({
  type: z.literal("object.depleted"),
  objectId: z.string(),
  remaining: z.number(),
});

export const EntitySpawnedMessage = z.object({
  type: z.literal("entity.spawned"),
  building: z.object({
    id: z.string(),
    kind: z.string(),
    x: z.number(),
    y: z.number(),
    ownerId: z.string(),
    placedAt: z.number(),
  }),
});

/**
 * Broadcast the instant a player dies, so every client drops that player's
 * buildings from the shared map the same moment the server removes them.
 * Carries the victim's now-emptied inventory too — the periodic
 * `player.state` broadcast never includes inventory, so without this the
 * victim's own client would have no way to learn its inventory was wiped
 * until its next full `world.snapshot` (only sent once, at join/reconnect).
 */
export const PlayerDiedMessage = z.object({
  type: z.literal("player.died"),
  playerId: z.string(),
  removedBuildingIds: z.array(z.string()),
  inventory: z.record(z.string(), z.number()),
});

/** Broadcast exactly once, the instant the killing blow leaves every enemy on the map dead — the room's shared win condition. */
export const GameVictoryMessage = z.object({
  type: z.literal("game.victory"),
  lastKillBy: z.string(),
});

export const ServerErrorMessage = z.object({
  type: z.literal("server.error"),
  message: z.string(),
});

export type ServerMessage =
  | z.infer<typeof RoomJoinedMessage>
  | z.infer<typeof RoomRosterMessage>
  | z.infer<typeof WorldSnapshotMessage>
  | z.infer<typeof PlayerStateMessage>
  | z.infer<typeof ActionResultMessage>
  | z.infer<typeof CombatEventMessage>
  | z.infer<typeof ObjectDepletedMessage>
  | z.infer<typeof EntitySpawnedMessage>
  | z.infer<typeof PlayerDiedMessage>
  | z.infer<typeof GameVictoryMessage>
  | z.infer<typeof ServerErrorMessage>;
