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

export const FarmActionMessage = z.object({
  type: z.literal("farm.action"),
  requestId: z.string().min(1).max(64),
  buildingId: z.string().min(1).max(64),
  action: z.enum(["plant", "water", "harvest"]),
  seedKind: z.string().min(1).max(32).optional(),
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

export const BeaconDepositMessage = z.object({
  type: z.literal("beacon.deposit"),
  requestId: z.string().min(1).max(64),
  itemKind: z.string().min(1).max(32),
  quantity: z.number().int().positive().max(99),
});

export const BeaconActivateMessage = z.object({
  type: z.literal("beacon.activate"),
  requestId: z.string().min(1).max(64),
});

/**
 * Requests a zone transition via a specific dungeon_entrance/dungeon_exit
 * object. `target` is the zone the player is trying to enter — the server
 * never infers direction from the object alone, since that keeps the
 * validation symmetric (object exists, player is in range of it, player is
 * in the zone that object's own `zone` sits in, target is the other zone).
 */
export const ZoneEnterMessage = z.object({
  type: z.literal("zone.enter"),
  requestId: z.string().min(1).max(64),
  objectId: z.string().min(1).max(64),
  target: z.enum(["overworld", "dungeon"]),
});

export const ClientMessage = z.discriminatedUnion("type", [
  RoomJoinMessage,
  PlayerInputMessage,
  PlayerInteractMessage,
  CraftRequestMessage,
  BuildingPlaceMessage,
  ChestTransferMessage,
  FarmActionMessage,
  PlayerRespawnMessage,
  CombatAttackMessage,
  BeaconDepositMessage,
  BeaconActivateMessage,
  ZoneEnterMessage,
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
  zone: z.enum(["overworld", "dungeon"]).optional(),
  resource: z.object({ kind: z.string(), remaining: z.number(), maxRemaining: z.number() }).optional(),
});

export const WorldSnapshotMessage = z.object({
  type: z.literal("world.snapshot"),
  seed: z.string(),
  width: z.number(),
  height: z.number(),
  tiles: z.array(z.object({ terrain: z.string() })),
  objects: z.array(MapObjectSchema),
  dungeon: z.object({
    width: z.number(),
    height: z.number(),
    tiles: z.array(z.object({ terrain: z.string() })),
    objects: z.array(MapObjectSchema),
    entryPoint: z.object({ x: z.number(), y: z.number() }),
    beaconLocation: z.object({ x: z.number(), y: z.number() }),
  }),
  players: z.array(
    z.object({
      id: z.string(),
      name: z.string(),
      x: z.number(),
      y: z.number(),
      zone: z.enum(["overworld", "dungeon"]),
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
  farmPlots: z.array(
    z.object({
      buildingId: z.string(),
      seedKind: z.string().nullable(),
      plantedAt: z.number().nullable(),
      wateredAt: z.number().nullable(),
    }),
  ),
  enemies: z.array(
    z.object({
      id: z.string(),
      kind: z.string(),
      zone: z.enum(["overworld", "dungeon"]),
      x: z.number(),
      y: z.number(),
      health: z.number(),
      maxHealth: z.number(),
      telegraphing: z.boolean(),
    }),
  ),
  beaconProgress: z.object({
    wood: z.number(),
    stone: z.number(),
    ancientCore: z.number(),
    requiredWood: z.number(),
    requiredStone: z.number(),
    requiredAncientCore: z.number(),
    bossDefeated: z.boolean(),
    activated: z.boolean(),
  }),
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
  cropStage: z.string().optional(),
  farmPlot: z
    .object({
      buildingId: z.string(),
      seedKind: z.string().nullable(),
      plantedAt: z.number().nullable(),
      wateredAt: z.number().nullable(),
    })
    .optional(),
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

export const BeaconProgressMessage = z.object({
  type: z.literal("beacon.progress"),
  wood: z.number(),
  stone: z.number(),
  ancientCore: z.number(),
  requiredWood: z.number(),
  requiredStone: z.number(),
  requiredAncientCore: z.number(),
  bossDefeated: z.boolean(),
  activated: z.boolean(),
});

export const BeaconVictoryMessage = z.object({
  type: z.literal("beacon.victory"),
  activatedBy: z.string(),
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
  | z.infer<typeof BeaconProgressMessage>
  | z.infer<typeof BeaconVictoryMessage>
  | z.infer<typeof EntitySpawnedMessage>
  | z.infer<typeof ServerErrorMessage>;
