import type { IncomingMessage } from "node:http";
import type Database from "better-sqlite3";
import { WebSocket, WebSocketServer } from "ws";
import { DEFAULT_ROOM_CODE, RECONNECT_GRACE_MS, SNAPSHOT_MS, TICK_MS } from "../shared/constants.js";
import { createAnonymousId, resolveIdentity, touchPlayerRecord } from "./identity.js";
import { claimAndApplyPendingRewards, loadPlayerHealth } from "./world.js";
import { ClientMessage, MAX_CLIENT_MESSAGE_BYTES } from "../shared/messages.js";
import { ITEM_KINDS, type ItemKind } from "../shared/types.js";
import type { Room } from "./room.js";
import { log } from "./log.js";

function isItemKind(value: string): value is ItemKind {
  return (ITEM_KINDS as readonly string[]).includes(value);
}

const BEACON_MATERIALS = ["wood", "stone", "ancient_core"] as const;
type BeaconMaterial = (typeof BEACON_MATERIALS)[number];

function isBeaconMaterial(value: string): value is BeaconMaterial {
  return (BEACON_MATERIALS as readonly string[]).includes(value);
}

interface Connection {
  /** The stable identity id this socket is acting as — resolved once, at connection open, from the signed cookie. Never taken from client-supplied message fields. */
  id: string;
  /** True once this socket has successfully sent room.join and been admitted. */
  joined: boolean;
  /** This socket's generation for `id`, assigned at admission time. A later connection for the same id bumps the generation; a stale socket's messages/close are recognised by generation mismatch and ignored. */
  generation: number;
  lastInputSeq: number;
}

/** Minimal fixed-window rate limiter, per key. */
class RateLimiter {
  private readonly counts = new Map<string, { windowStart: number; count: number }>();
  constructor(private readonly limit: number, private readonly windowMs: number) {}

  allow(key: string): boolean {
    const now = Date.now();
    const entry = this.counts.get(key);
    if (!entry || now - entry.windowStart >= this.windowMs) {
      this.counts.set(key, { windowStart: now, count: 1 });
      return true;
    }
    entry.count += 1;
    return entry.count <= this.limit;
  }
}

export interface NetOptions {
  db: Database.Database;
  secret: Buffer;
  roomCode?: string;
  reconnectGraceMs?: number;
  /** The world's creation timestamp, sent to clients so they can compute day/night locally via computeTimeOfDay. */
  worldCreatedAt?: number;
}

export interface AttachedServer {
  /** Clears the tick/snapshot intervals and any pending eviction timers. Call when tearing down a server (e.g. in tests) so the process can exit cleanly. */
  stop(): void;
}

export function attachWebSocketServer(wss: WebSocketServer, room: Room, options: NetOptions): AttachedServer {
  const { db, secret } = options;
  const roomCode = options.roomCode ?? DEFAULT_ROOM_CODE;
  const reconnectGraceMs = options.reconnectGraceMs ?? RECONNECT_GRACE_MS;

  const connections = new Map<WebSocket, Connection>();
  /** The currently-authoritative socket + generation for each stable identity id that holds a room slot. */
  const activeSockets = new Map<string, { socket: WebSocket; generation: number }>();
  /** Pending eviction timers for ids that have disconnected but are still within their reconnect grace window. */
  const pendingEviction = new Map<string, NodeJS.Timeout>();
  let nextGeneration = 1;

  const interactLimiter = new RateLimiter(10, 1000);
  const inputLimiter = new RateLimiter(40, 1000);
  const connectionLimiter = new RateLimiter(20, 60_000);

  function broadcastRoster(): void {
    const players = room.getPlayers().map((p) => ({ id: p.id, name: p.name, connected: p.connected }));
    broadcast(connections, { type: "room.roster", players });
  }

  /** True if `conn` is still the authoritative connection for its id — false once superseded by a newer connection. */
  function isCurrent(conn: Connection): boolean {
    const current = activeSockets.get(conn.id);
    return current !== undefined && current.generation === conn.generation;
  }

  wss.on("connection", (socket: WebSocket, req: IncomingMessage) => {
    const remoteAddress = req.socket.remoteAddress ?? "unknown";
    if (!connectionLimiter.allow(remoteAddress)) {
      socket.close(1013, "rate_limited");
      return;
    }

    const resolved = resolveIdentity(db, secret, req.headers.cookie);
    const conn: Connection = {
      id: resolved?.id ?? createAnonymousId(),
      joined: false,
      generation: 0,
      lastInputSeq: -1,
    };

    socket.on("message", (raw, isBinary) => {
      if (isBinary) return;
      const buf = raw as Buffer;
      if (buf.byteLength > MAX_CLIENT_MESSAGE_BYTES) {
        send(socket, { type: "server.error", message: "message_too_large" });
        return;
      }

      let parsed: unknown;
      try {
        parsed = JSON.parse(buf.toString("utf8"));
      } catch {
        send(socket, { type: "server.error", message: "invalid_json" });
        return;
      }

      const result = ClientMessage.safeParse(parsed);
      if (!result.success) {
        send(socket, { type: "server.error", message: "invalid_message" });
        return;
      }

      const msg = result.data;

      if (msg.type === "room.join") {
        if (conn.joined) return; // already joined on this socket

        if (msg.roomCode !== roomCode) {
          log("join_rejected", { player_id: conn.id, reason: "invalid_room_code" });
          send(socket, { type: "server.error", message: "invalid_room_code" });
          socket.close();
          return;
        }

        const hasRoomSlot = room.hasPlayer(conn.id);
        if (!hasRoomSlot && !room.canJoin()) {
          log("join_rejected", { player_id: conn.id, reason: "room_full" });
          send(socket, { type: "server.error", message: "room_full" });
          socket.close();
          return;
        }

        // A second connection for the same identity supersedes the first —
        // the old socket is told why and closed; its own close handler sees
        // the generation has already moved on and does not touch room state
        // (no disconnect/eviction double-processing, no stale-socket writes).
        const existing = activeSockets.get(conn.id);
        if (existing && existing.socket !== socket) {
          send(existing.socket, { type: "server.error", message: "superseded" });
          existing.socket.close();
        }

        const pending = pendingEviction.get(conn.id);
        if (pending) {
          clearTimeout(pending);
          pendingEviction.delete(conn.id);
        }

        conn.generation = nextGeneration++;
        conn.joined = true;
        activeSockets.set(conn.id, { socket, generation: conn.generation });
        connections.set(socket, conn);

        touchPlayerRecord(db, conn.id, msg.name);

        if (hasRoomSlot) {
          log("player_reconnected", { player_id: conn.id, name: msg.name });
          room.setConnected(conn.id, true);
        } else {
          // Claim any durably-queued rewards (e.g. a boss-kill ancient_core
          // earned while this identity was evicted) before building the
          // starting inventory handed to addPlayer — a reward can only ever
          // have been queued for an identity that was *not* currently
          // holding a room slot, so this can't double-grant something a
          // still-connected contributor already received directly. The
          // claim, the inventory merge, and marking the reward settled all
          // happen inside one transaction in claimAndApplyPendingRewards, so
          // a crash between "claimed" and "in inventory" is not possible —
          // see that function's doc comment in world.ts.
          const { inventory } = claimAndApplyPendingRewards(db, conn.id);
          room.addPlayer(conn.id, msg.name, inventory, loadPlayerHealth(db, conn.id));
          log("player_joined", { player_id: conn.id, name: msg.name, room_code: roomCode });
        }

        send(socket, { type: "room.joined", requestId: msg.requestId, playerId: conn.id, roomCode });
        send(socket, {
          type: "world.snapshot",
          seed: room.map.seed,
          width: room.map.width,
          height: room.map.height,
          tiles: room.map.tiles,
          objects: room.map.objects,
          dungeon: room.map.dungeon,
          players: room.getPlayers(),
          buildings: room.getBuildings(),
          farmPlots: room.getFarmPlots(),
          enemies: room.getEnemies(),
          beaconProgress: room.getBeaconProgress(),
          serverTime: Date.now(),
          worldCreatedAt: options.worldCreatedAt ?? Date.now(),
        });
        broadcastRoster();
        return;
      }

      if (!conn.joined) {
        send(socket, { type: "server.error", message: "not_joined" });
        return;
      }

      // A superseded socket's further messages are silently dropped — it is
      // no longer allowed to act as this identity.
      if (!isCurrent(conn)) return;

      if (msg.type === "player.input") {
        if (!inputLimiter.allow(conn.id)) return;
        if (msg.seq <= conn.lastInputSeq) return; // stale/out-of-order, drop
        conn.lastInputSeq = msg.seq;
        room.setInput(conn.id, msg.dx, msg.dy);
        return;
      }

      if (msg.type === "player.interact") {
        if (!interactLimiter.allow(conn.id)) {
          send(socket, {
            type: "action.result",
            requestId: msg.requestId,
            ok: false,
            reason: "rate_limited",
          });
          return;
        }
        const result = room.interact(conn.id, msg.objectId, msg.requestId);
        send(socket, {
          type: "action.result",
          requestId: msg.requestId,
          ok: result.ok,
          reason: result.reason,
          inventory: result.inventory,
          objectRemaining: result.objectRemaining,
        });
        return;
      }

      if (msg.type === "craft.request") {
        if (!interactLimiter.allow(conn.id)) {
          send(socket, {
            type: "action.result",
            requestId: msg.requestId,
            ok: false,
            reason: "rate_limited",
          });
          return;
        }
        const result = room.craft(conn.id, msg.recipeId, msg.requestId);
        send(socket, {
          type: "action.result",
          requestId: msg.requestId,
          ok: result.ok,
          reason: result.reason,
          inventory: result.inventory,
          recipeId: result.recipeId,
        });
        return;
      }

      if (msg.type === "building.place") {
        if (!interactLimiter.allow(conn.id)) {
          send(socket, {
            type: "action.result",
            requestId: msg.requestId,
            ok: false,
            reason: "rate_limited",
          });
          return;
        }
        const result = room.build(conn.id, msg.recipeId, msg.x, msg.y, msg.requestId);
        send(socket, {
          type: "action.result",
          requestId: msg.requestId,
          ok: result.ok,
          reason: result.reason,
          inventory: result.inventory,
          recipeId: result.recipeId,
          buildingId: result.buildingId,
        });
        if (result.ok && result.buildingId) {
          const building = room.getBuilding(result.buildingId);
          if (building) broadcast(connections, { type: "entity.spawned", building });
        }
        return;
      }

      if (msg.type === "chest.transfer") {
        if (!interactLimiter.allow(conn.id)) {
          send(socket, {
            type: "action.result",
            requestId: msg.requestId,
            ok: false,
            reason: "rate_limited",
          });
          return;
        }
        if (!isItemKind(msg.itemKind)) {
          send(socket, {
            type: "action.result",
            requestId: msg.requestId,
            ok: false,
            reason: "unknown_item_kind",
          });
          return;
        }
        const result = room.chestTransfer(
          conn.id,
          msg.chestId,
          msg.itemKind,
          msg.quantity,
          msg.direction,
          msg.requestId,
        );
        send(socket, {
          type: "action.result",
          requestId: msg.requestId,
          ok: result.ok,
          reason: result.reason,
          inventory: result.inventory,
          chestItems: result.chestItems,
        });
        return;
      }

      if (msg.type === "farm.action") {
        if (!interactLimiter.allow(conn.id)) {
          send(socket, {
            type: "action.result",
            requestId: msg.requestId,
            ok: false,
            reason: "rate_limited",
          });
          return;
        }
        if (msg.seedKind !== undefined && !isItemKind(msg.seedKind)) {
          send(socket, {
            type: "action.result",
            requestId: msg.requestId,
            ok: false,
            reason: "unknown_item_kind",
          });
          return;
        }
        const result = room.farmAction(conn.id, msg.buildingId, msg.action, msg.seedKind, msg.requestId);
        send(socket, {
          type: "action.result",
          requestId: msg.requestId,
          ok: result.ok,
          reason: result.reason,
          inventory: result.inventory,
          cropStage: result.cropStage,
          buildingId: result.buildingId,
          farmPlot: result.farmPlot ?? undefined,
        });
        return;
      }

      if (msg.type === "player.respawn") {
        const result = room.respawn(conn.id);
        send(socket, {
          type: "action.result",
          requestId: msg.requestId,
          ok: result.ok,
          reason: result.reason,
          health: result.health,
        });
        return;
      }

      if (msg.type === "combat.attack") {
        if (!interactLimiter.allow(conn.id)) {
          send(socket, {
            type: "action.result",
            requestId: msg.requestId,
            ok: false,
            reason: "rate_limited",
          });
          return;
        }
        const result = room.attack(conn.id, msg.targetId, msg.requestId);
        send(socket, {
          type: "action.result",
          requestId: msg.requestId,
          ok: result.ok,
          reason: result.reason,
          enemyHealth: result.enemyHealth,
          enemyDied: result.enemyDied,
          damageDealt: result.damageDealt,
        });
        if (result.ok) {
          log("combat_attack", {
            player_id: conn.id,
            target_id: msg.targetId,
            damage: result.damageDealt ?? 0,
            enemy_died: result.enemyDied ?? false,
          });
          broadcast(connections, {
            type: "combat.event",
            attackerId: conn.id,
            targetId: msg.targetId,
            damage: result.damageDealt ?? 0,
            enemyHealth: result.enemyHealth ?? 0,
            enemyDied: result.enemyDied ?? false,
          });
          if (result.enemyDied) {
            const enemy = room.getEnemy(msg.targetId);
            if (enemy?.kind === "boss") {
              log("boss_defeated", { player_id: conn.id });
              broadcast(connections, { type: "beacon.progress", ...room.getBeaconProgress() });
            }
          }
        }
        return;
      }

      if (msg.type === "beacon.deposit") {
        if (!interactLimiter.allow(conn.id)) {
          send(socket, {
            type: "action.result",
            requestId: msg.requestId,
            ok: false,
            reason: "rate_limited",
          });
          return;
        }
        if (!isBeaconMaterial(msg.itemKind)) {
          send(socket, {
            type: "action.result",
            requestId: msg.requestId,
            ok: false,
            reason: "unknown_item_kind",
          });
          return;
        }
        const result = room.depositBeacon(conn.id, msg.itemKind, msg.quantity, msg.requestId);
        send(socket, {
          type: "action.result",
          requestId: msg.requestId,
          ok: result.ok,
          reason: result.reason,
          inventory: result.inventory,
        });
        if (result.ok) {
          log("beacon_deposit", { player_id: conn.id, item_kind: msg.itemKind, quantity: msg.quantity });
          broadcast(connections, { type: "beacon.progress", ...room.getBeaconProgress() });
        }
        return;
      }

      if (msg.type === "beacon.activate") {
        if (!interactLimiter.allow(conn.id)) {
          send(socket, {
            type: "action.result",
            requestId: msg.requestId,
            ok: false,
            reason: "rate_limited",
          });
          return;
        }
        const result = room.activateBeacon(conn.id, msg.requestId);
        send(socket, {
          type: "action.result",
          requestId: msg.requestId,
          ok: result.ok,
          reason: result.reason,
        });
        if (result.ok) {
          log("beacon_activated", { player_id: conn.id });
          broadcast(connections, { type: "beacon.victory", activatedBy: conn.id });
        }
        return;
      }

      if (msg.type === "zone.enter") {
        if (!interactLimiter.allow(conn.id)) {
          send(socket, {
            type: "action.result",
            requestId: msg.requestId,
            ok: false,
            reason: "rate_limited",
          });
          return;
        }
        const result = room.enterZone(conn.id, msg.objectId, msg.target, msg.requestId);
        send(socket, {
          type: "action.result",
          requestId: msg.requestId,
          ok: result.ok,
          reason: result.reason,
        });
        return;
      }
    });

    socket.on("close", () => {
      connections.delete(socket);
      if (!conn.joined) return;

      // A stale (already-superseded) socket's close must not clobber the
      // newer connection's state — only the current generation's close
      // starts the disconnect/eviction sequence.
      if (!isCurrent(conn)) return;

      log("player_disconnected", { player_id: conn.id });
      room.setConnected(conn.id, false);
      broadcastRoster();

      const timer = setTimeout(() => {
        pendingEviction.delete(conn.id);
        // Only evict if nothing reconnected in the meantime (generation unchanged).
        if (isCurrent(conn)) {
          activeSockets.delete(conn.id);
          room.removePlayer(conn.id);
          broadcastRoster();
          log("player_evicted", { player_id: conn.id, reason: "grace_window_expired" });
        }
      }, reconnectGraceMs);
      pendingEviction.set(conn.id, timer);
    });
  });

  const tickTimer = setInterval(() => {
    room.tick(TICK_MS / 1000);
  }, TICK_MS);

  const snapshotTimer = setInterval(() => {
    const players = room.getPlayers().map((p) => ({ id: p.id, x: p.x, y: p.y, health: p.health, alive: p.alive }));
    if (players.length === 0) return;
    const enemies = room.getEnemies().map((e) => ({ id: e.id, x: e.x, y: e.y, health: e.health, telegraphing: e.telegraphing }));
    const payload = JSON.stringify({ type: "player.state", players, enemies, isNight: room.isNight() });
    for (const socket of connections.keys()) {
      if (socket.readyState === WebSocket.OPEN) socket.send(payload);
    }
  }, SNAPSHOT_MS);

  return {
    stop() {
      clearInterval(tickTimer);
      clearInterval(snapshotTimer);
      for (const timer of pendingEviction.values()) clearTimeout(timer);
      pendingEviction.clear();
    },
  };
}

function send(socket: WebSocket, message: unknown): void {
  if (socket.readyState === WebSocket.OPEN) {
    socket.send(JSON.stringify(message));
  }
}

function broadcast(connections: Map<WebSocket, { id: string }>, message: unknown): void {
  const payload = JSON.stringify(message);
  for (const conn of connections.keys()) {
    if (conn.readyState === WebSocket.OPEN) conn.send(payload);
  }
}
