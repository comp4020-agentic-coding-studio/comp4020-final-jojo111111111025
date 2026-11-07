import {
  ATTACK_RANGE_TILES,
  BUILD_RANGE_TILES,
  FARM_RANGE_TILES,
  GATHER_RANGE_TILES,
  SNAPSHOT_MS,
  ZONE_TRANSITION_RANGE_TILES,
} from "../shared/constants.js";
import { computeCropStage, SEED_TO_CROP } from "../shared/farming.js";
import { RECIPES } from "../shared/recipes.js";
import type { Building, CropStage, DungeonMap, FarmPlotState, ItemKind, MapObject, WorldMap, Zone } from "../shared/types.js";
import { ITEM_KINDS, emptyInventory } from "../shared/types.js";
import { InterpolationBuffer, renderTimeFor } from "./interpolation.js";
import { applyObjectDepleted, GameClient, type BeaconProgress, type SnapshotEnemy } from "./net.js";
import { render, type RenderEnemy, type RenderPlayer } from "./render.js";
import { loadSprites } from "./sprites.js";

const canvas = document.getElementById("canvas") as HTMLCanvasElement;
const ctx = canvas.getContext("2d")!;
// Pixel-art sprites must not be bilinear-smoothed — the canvas default would
// blur every sprite at any non-integer scale. (Set in resize(), below,
// since resizing the canvas's backing store resets all 2D context state
// including this flag — a one-time set here would be lost on first resize.)
void loadSprites(); // starts loading immediately; frame() tolerates not-yet-loaded sheets (see sprites.ts/render.ts's fallback colors)
const statusEl = document.getElementById("status")!;
const promptEl = document.getElementById("prompt")!;
const zonePromptEl = document.getElementById("zone-prompt")!;
const farmPromptEl = document.getElementById("farm-prompt")!;
const combatFeedbackEl = document.getElementById("combat-feedback")!;
const actionFeedbackEl = document.getElementById("action-feedback")!;
const recipeListEl = document.getElementById("recipe-list")!;
const craftFeedbackEl = document.getElementById("craft-feedback")!;
const buildingListEl = document.getElementById("building-list")!;
const chestPanelEl = document.getElementById("chest-panel")!;
const chestRowsEl = document.getElementById("chest-rows")!;
const chestCloseEl = document.getElementById("chest-close")!;
const joinScreenEl = document.getElementById("join-screen")!;
const joinNameEl = document.getElementById("join-name") as HTMLInputElement;
const joinRoomCodeEl = document.getElementById("join-room-code") as HTMLInputElement;
const joinButtonEl = document.getElementById("join-button") as HTMLButtonElement;
const joinErrorEl = document.getElementById("join-error")!;
const rosterPanelEl = document.getElementById("roster-panel")!;
const healthBarEl = document.getElementById("health-bar")!;
const healthValueEl = document.getElementById("health-value")!;
const healthFillEl = document.getElementById("health-fill")!;
const damageFlashEl = document.getElementById("damage-flash")!;
const deathScreenEl = document.getElementById("death-screen")!;
const respawnButtonEl = document.getElementById("respawn-button") as HTMLButtonElement;
const nightIndicatorEl = document.getElementById("night-indicator")!;
const beaconPanelEl = document.getElementById("beacon-panel")!;
const beaconRequirementsEl = document.getElementById("beacon-requirements")!;
const beaconDepositRowsEl = document.getElementById("beacon-deposit-rows")!;
const beaconActivateEl = document.getElementById("beacon-activate") as HTMLButtonElement;
const beaconCloseEl = document.getElementById("beacon-close")!;
const victoryScreenEl = document.getElementById("victory-screen")!;
const victoryDetailEl = document.getElementById("victory-detail")!;
const touchJoystickEl = document.getElementById("touch-joystick")!;
const touchJoystickKnobEl = document.getElementById("touch-joystick-knob")!;
const touchInteractEl = document.getElementById("touch-interact") as HTMLButtonElement;
const touchAttackEl = document.getElementById("touch-attack") as HTMLButtonElement;
const touchChestEl = document.getElementById("touch-chest") as HTMLButtonElement;
const touchBeaconEl = document.getElementById("touch-beacon") as HTMLButtonElement;
const resourceEls: Partial<Record<ItemKind, HTMLElement>> = {
  wood: document.getElementById("wood") ?? undefined,
  stone: document.getElementById("stone") ?? undefined,
  berries: document.getElementById("berries") ?? undefined,
  seed_berry: document.getElementById("seed_berry") ?? undefined,
  axe: document.getElementById("axe") ?? undefined,
  pickaxe: document.getElementById("pickaxe") ?? undefined,
  sword: document.getElementById("sword") ?? undefined,
  bandage: document.getElementById("bandage") ?? undefined,
  ancient_core: document.getElementById("ancient_core") ?? undefined,
};

let world: (WorldMap & { dungeon: DungeonMap }) | null = null;
let localPlayerId: string | null = null;
let localZone: Zone = "overworld";
let localAlive = true;
let localHealth = 100;
const remotePlayers = new Map<string, { x: number; y: number; zone: Zone; alive: boolean }>();
const buildings = new Map<string, Building>();
const farmPlots = new Map<string, FarmPlotState>();
let enemies: SnapshotEnemy[] = [];

// Render-only position smoothing (see interpolation.ts): the server remains
// authoritative, these buffers only decide where a remote entity is *drawn*
// between the ~10Hz position broadcasts in onSnapshot/onPlayerState.
const remotePlayerBuffers = new Map<string, InterpolationBuffer>();
const enemyBuffers = new Map<string, InterpolationBuffer>();
/** Sampled slightly behind the client's own clock so sample() is interpolating between two already-received points rather than guessing ahead of the newest one. */
const RENDER_DELAY_MS = SNAPSHOT_MS * 1.5;

function recordRemotePlayerPosition(id: string, x: number, y: number): void {
  let buf = remotePlayerBuffers.get(id);
  if (!buf) {
    buf = new InterpolationBuffer();
    remotePlayerBuffers.set(id, buf);
  }
  buf.push(x, y, performance.now());
}

function recordEnemyPosition(id: string, x: number, y: number): void {
  let buf = enemyBuffers.get(id);
  if (!buf) {
    buf = new InterpolationBuffer();
    enemyBuffers.set(id, buf);
  }
  buf.push(x, y, performance.now());
}
let beaconProgress: BeaconProgress | null = null;
let isNight = false;
let serverTimeOffsetMs = 0; // serverNow - Date.now(), sampled once at join
let localPos = { x: 0, y: 0 };
let facing: { dx: number; dy: number } = { dx: 0, dy: 1 };
let myInventory: Record<ItemKind, number> = emptyInventory();
let openChestId: string | null = null;
let lastChestItems: Record<ItemKind, number> = emptyInventory();
let beaconOpen = false;
let victoryShown = false;

function serverNow(): number {
  return Date.now() + serverTimeOffsetMs;
}

const keys = new Set<string>();
window.addEventListener("keydown", (e) => keys.add(e.key.toLowerCase()));
window.addEventListener("keyup", (e) => keys.delete(e.key.toLowerCase()));
// A keyup while the window isn't focused (alt-tab, DevTools, another app)
// never reaches this page, so a held movement key can get stuck "down"
// until the same key is pressed again. Losing focus clears every held key,
// the same way releasing them all would.
window.addEventListener("blur", () => keys.clear());

function resize(): void {
  canvas.width = window.innerWidth;
  canvas.height = window.innerHeight;
  // Resizing the canvas's backing store resets all 2D context state,
  // including imageSmoothingEnabled — reapply it every time, not just once.
  ctx.imageSmoothingEnabled = false;
}
window.addEventListener("resize", resize);
resize();

const ERROR_MESSAGES: Record<string, string> = {
  invalid_room_code: "That room code isn't recognised.",
  room_full: "This room already has 4 players.",
  superseded: "You joined from another tab or window.",
  not_joined: "You need to join the room first.",
};

/**
 * Every `reason` the server can send back on a rejected action
 * (`src/server/room.ts` / `net.ts`), mapped to one short, player-facing
 * sentence. Kept exhaustive on purpose — a server reason with no entry here
 * falls back to a raw, less friendly string in `showActionFeedback`, which
 * is a visible signal to add it rather than a silent drop.
 */
const ACTION_REASON_MESSAGES: Record<string, string> = {
  too_far: "Too far away.",
  wrong_zone: "Can't do that here.",
  dead: "You're dead — respawn first.",
  not_dead: "You're not dead.",
  already_dead: "Already defeated.",
  already_activated: "The beacon is already lit.",
  already_in_zone: "You're already there.",
  already_mature: "Already fully grown.",
  boss_not_defeated: "Defeat the boss first.",
  on_cooldown: "Not ready yet.",
  insufficient_materials: "Not enough materials.",
  inventory_full: "Your inventory is full.",
  chest_full: "The chest is full.",
  cell_occupied: "Something's already there.",
  out_of_bounds: "Can't place it there.",
  depleted: "Nothing left to gather here.",
  not_gatherable: "Nothing to gather there.",
  invalid_quantity: "Invalid amount.",
  invalid_seed: "Can't plant that there.",
  plot_empty: "Nothing planted here yet.",
  plot_occupied: "Something's already planted here.",
  not_mature: "Not ready to harvest yet.",
  not_a_building_recipe: "That recipe isn't a building.",
  not_an_item_recipe: "That recipe isn't an item.",
  not_a_zone_transition: "That's not an entrance.",
  unknown_recipe: "Unknown recipe.",
  unknown_object: "That's gone.",
  unknown_target: "That target's gone.",
  unknown_chest: "That chest is gone.",
  unknown_plot: "That plot is gone.",
  unknown_player: "You're not recognised — try rejoining.",
  unknown_item_kind: "Unknown item.",
  rate_limited: "Slow down a little.",
};

let actionFeedbackTimer: ReturnType<typeof setTimeout> | undefined;
/** The one place every action rejection (and confirmation, when useful) surfaces to the player — see onActionResult. */
function showActionFeedback(message: string, isError: boolean): void {
  actionFeedbackEl.textContent = message;
  actionFeedbackEl.classList.toggle("err", isError);
  actionFeedbackEl.classList.add("show");
  clearTimeout(actionFeedbackTimer);
  actionFeedbackTimer = setTimeout(() => actionFeedbackEl.classList.remove("show"), 2200);
}

let hasJoinedOnce = false;

const client = new GameClient({
  onJoined(playerId) {
    localPlayerId = playerId;
    hasJoinedOnce = true;
    joinScreenEl.style.display = "none";
    statusEl.textContent = "connected";
    joinButtonEl.disabled = false;
    joinErrorEl.textContent = "";
  },
  onSnapshot(snapshot, players, snapshotBuildings, snapshotFarmPlots, snapshotEnemies, progress, serverTime) {
    world = snapshot;
    serverTimeOffsetMs = serverTime - Date.now();
    remotePlayers.clear();
    for (const p of players) {
      remotePlayers.set(p.id, { x: p.x, y: p.y, zone: p.zone, alive: p.alive });
      if (p.id === localPlayerId) {
        localPos = { x: p.x, y: p.y };
        localZone = p.zone;
        localAlive = p.alive;
        localHealth = p.health;
        updateInventory(p.inventory);
        updateHealthUi();
        updateDeathUi();
      } else {
        recordRemotePlayerPosition(p.id, p.x, p.y);
      }
    }
    // A full snapshot is the authoritative player list — drop buffers for
    // anyone no longer present instead of letting them grow unbounded.
    const presentIds = new Set(players.map((p) => p.id));
    for (const id of [...remotePlayerBuffers.keys()]) {
      if (!presentIds.has(id)) remotePlayerBuffers.delete(id);
    }
    buildings.clear();
    for (const b of snapshotBuildings) buildings.set(b.id, b);
    farmPlots.clear();
    for (const plot of snapshotFarmPlots) farmPlots.set(plot.buildingId, plot);
    enemies = snapshotEnemies;
    enemyBuffers.clear();
    for (const e of snapshotEnemies) recordEnemyPosition(e.id, e.x, e.y);
    beaconProgress = progress;
    renderRecipes();
    renderBuildingOptions();
    renderBeaconPanel();
  },
  onRoster(players) {
    rosterPanelEl.innerHTML = "";
    for (const p of players) {
      const span = document.createElement("span");
      span.className = "roster-entry" + (p.connected ? "" : " disconnected");
      span.textContent = `${p.name}${p.id === localPlayerId ? " (you)" : ""}${p.connected ? "" : " (away)"}`;
      rosterPanelEl.append(span);
    }
  },
  onPlayerState(players, snapshotEnemies, night) {
    for (const p of players) {
      const existing = remotePlayers.get(p.id);
      remotePlayers.set(p.id, { x: p.x, y: p.y, zone: existing?.zone ?? "overworld", alive: p.alive });
      if (p.id === localPlayerId) {
        const wasAlive = localAlive;
        localPos = { x: p.x, y: p.y };
        localAlive = p.alive;
        localHealth = p.health;
        updateHealthUi();
        if (wasAlive && !p.alive) flashDamage();
        updateDeathUi();
      } else {
        recordRemotePlayerPosition(p.id, p.x, p.y);
      }
    }
    enemies = snapshotEnemies.map((e) => {
      const prev = enemies.find((existing) => existing.id === e.id);
      return prev ? { ...prev, ...e } : { kind: "wanderer", zone: localZone, maxHealth: e.health, ...e };
    });
    for (const e of snapshotEnemies) recordEnemyPosition(e.id, e.x, e.y);
    // player.state only ever lists currently-alive enemies (room.ts's
    // getEnemies filters on e.alive), so a dead enemy's buffer is dropped
    // here rather than retained until the next full world.snapshot.
    const aliveEnemyIds = new Set(snapshotEnemies.map((e) => e.id));
    for (const id of [...enemyBuffers.keys()]) {
      if (!aliveEnemyIds.has(id)) enemyBuffers.delete(id);
    }
    isNight = night;
    nightIndicatorEl.style.display = isNight ? "block" : "none";
  },
  onActionResult(result) {
    if (result.ok && result.inventory) {
      updateInventory(result.inventory);
    }
    if (result.recipeId) {
      const recipe = RECIPES[result.recipeId as keyof typeof RECIPES];
      const isBuilding = recipe?.output.type === "building";
      craftFeedbackEl.textContent = result.ok
        ? `${isBuilding ? "Placed" : "Crafted"} ${recipe?.name ?? result.recipeId}.`
        : `Can't ${isBuilding ? "build" : "craft"}: ${ACTION_REASON_MESSAGES[result.reason ?? ""] ?? result.reason}`;
    }
    if (result.chestItems) {
      lastChestItems = result.chestItems;
      renderChestPanel();
    }
    if (result.ok && result.farmPlot) {
      // The server echoes the plot's new timestamps directly, so the client
      // keeps deriving stage locally from computeCropStage rather than
      // trusting a one-off `cropStage` string that could drift out of sync.
      farmPlots.set(result.farmPlot.buildingId, result.farmPlot);
    }
    if (result.health !== undefined) {
      localHealth = result.health;
      localAlive = result.health > 0;
      updateHealthUi();
      updateDeathUi();
    }
    if (result.damageDealt !== undefined) {
      combatFeedbackEl.textContent = result.ok
        ? `Hit for ${result.damageDealt}${result.enemyDied ? " — defeated!" : ""}`
        : `Can't attack: ${ACTION_REASON_MESSAGES[result.reason ?? ""] ?? result.reason}`;
    }
    // Every rejected action, whatever its shape, gets one visible message —
    // the specific panels above (craft/combat feedback) add flavour text for
    // their own cases, but this is the single catch-all so no `reason` the
    // server can send is ever silently dropped (see ACTION_REASON_MESSAGES).
    if (!result.ok && result.reason) {
      showActionFeedback(ACTION_REASON_MESSAGES[result.reason] ?? `Can't: ${result.reason}`, true);
    }
  },
  onEntitySpawned(building) {
    buildings.set(building.id, building);
  },
  onCombatEvent(event) {
    if (event.attackerId !== localPlayerId) {
      combatFeedbackEl.textContent = `${event.attackerId === localPlayerId ? "You" : "Someone"} hit for ${event.damage}${event.enemyDied ? " — defeated!" : ""}`;
    }
    const enemy = enemies.find((e) => e.id === event.targetId);
    if (enemy) enemy.health = event.enemyHealth;
  },
  onObjectDepleted(event) {
    applyObjectDepleted(world, event);
  },
  onBeaconProgress(progress) {
    beaconProgress = progress;
    renderBeaconPanel();
  },
  onBeaconVictory(activatedBy) {
    if (victoryShown) return;
    victoryShown = true;
    victoryDetailEl.textContent =
      activatedBy === localPlayerId ? "You lit the beacon." : "A fellow survivor lit the beacon.";
    victoryScreenEl.style.display = "flex";
  },
  onError(message) {
    const friendly = ERROR_MESSAGES[message] ?? `Error: ${message}`;
    if (!hasJoinedOnce) {
      joinErrorEl.textContent = friendly;
      joinButtonEl.disabled = false;
    } else {
      statusEl.textContent = friendly;
    }
  },
  onClose() {
    statusEl.textContent = hasJoinedOnce ? "reconnecting…" : "disconnected";
  },
});

function attemptJoin(): void {
  const name = joinNameEl.value.trim();
  const roomCode = joinRoomCodeEl.value.trim();
  if (!name) {
    joinErrorEl.textContent = "Enter a name first.";
    return;
  }
  if (!roomCode) {
    joinErrorEl.textContent = "Enter a room code first.";
    return;
  }
  joinErrorEl.textContent = "";
  joinButtonEl.disabled = true;
  statusEl.textContent = "connecting…";
  client.connect(name, roomCode);
}

joinButtonEl.addEventListener("click", attemptJoin);
joinNameEl.addEventListener("keydown", (e) => {
  if (e.key === "Enter") attemptJoin();
});
joinRoomCodeEl.addEventListener("keydown", (e) => {
  if (e.key === "Enter") attemptJoin();
});

function updateInventory(inventory: Record<ItemKind, number>): void {
  myInventory = inventory;
  for (const [kind, value] of Object.entries(inventory)) {
    const el = resourceEls[kind as ItemKind];
    if (el) el.textContent = String(value);
  }
  renderRecipes();
  if (openChestId) renderChestPanel();
  if (beaconOpen) renderBeaconPanel();
}

function updateHealthUi(): void {
  healthValueEl.textContent = String(localHealth);
  healthFillEl.style.width = `${Math.max(0, localHealth)}%`;
  healthBarEl.classList.toggle("low", localHealth <= 30);
}

function updateDeathUi(): void {
  deathScreenEl.style.display = localAlive ? "none" : "flex";
}

let flashTimer: ReturnType<typeof setTimeout> | undefined;
function flashDamage(): void {
  damageFlashEl.classList.add("show");
  clearTimeout(flashTimer);
  flashTimer = setTimeout(() => damageFlashEl.classList.remove("show"), 200);
}

respawnButtonEl.addEventListener("click", () => {
  client.respawn(crypto.randomUUID());
});

function canAfford(inputs: Partial<Record<ItemKind, number>>): boolean {
  return Object.entries(inputs).every(([kind, qty]) => myInventory[kind as ItemKind] >= (qty ?? 0));
}

function renderRecipes(): void {
  recipeListEl.innerHTML = "";
  for (const recipe of Object.values(RECIPES)) {
    if (recipe.output.type !== "item") continue; // buildings are placed, not crafted into inventory — see building UI
    const row = document.createElement("div");
    row.className = "recipe";

    const info = document.createElement("div");
    info.className = "recipe-info";
    const costText = Object.entries(recipe.inputs)
      .map(([kind, qty]) => `${qty} ${kind}`)
      .join(", ");
    info.innerHTML = `<div class="recipe-name">${recipe.name}</div><div class="recipe-cost">${costText}</div>`;

    const button = document.createElement("button");
    button.textContent = "Craft";
    button.disabled = !canAfford(recipe.inputs);
    button.addEventListener("click", () => {
      client.craft(recipe.id, crypto.randomUUID());
    });

    row.append(info, button);
    recipeListEl.append(row);
  }
}

function renderBuildingOptions(): void {
  buildingListEl.innerHTML = "";
  for (const recipe of Object.values(RECIPES)) {
    if (recipe.output.type !== "building") continue;
    const row = document.createElement("div");
    row.className = "recipe";

    const info = document.createElement("div");
    info.className = "recipe-info";
    const costText = Object.entries(recipe.inputs)
      .map(([kind, qty]) => `${qty} ${kind}`)
      .join(", ");
    info.innerHTML = `<div class="recipe-name">${recipe.name}</div><div class="recipe-cost">${costText}</div>`;

    const button = document.createElement("button");
    button.textContent = "Place";
    button.disabled = !canAfford(recipe.inputs) || localZone !== "overworld";
    button.addEventListener("click", () => {
      const targetX = Math.floor(localPos.x + facing.dx);
      const targetY = Math.floor(localPos.y + facing.dy);
      client.build(recipe.id, targetX, targetY, crypto.randomUUID());
    });

    row.append(info, button);
    buildingListEl.append(row);
  }
}

function nearestChest(): Building | null {
  let best: Building | null = null;
  let bestDist = Infinity;
  for (const building of buildings.values()) {
    if (building.kind !== "chest") continue;
    const dist = Math.hypot(localPos.x - (building.x + 0.5), localPos.y - (building.y + 0.5));
    if (dist <= BUILD_RANGE_TILES && dist < bestDist) {
      bestDist = dist;
      best = building;
    }
  }
  return best;
}

function nearestFarmPlot(): Building | null {
  let best: Building | null = null;
  let bestDist = Infinity;
  for (const building of buildings.values()) {
    if (building.kind !== "farm_plot") continue;
    const dist = Math.hypot(localPos.x - (building.x + 0.5), localPos.y - (building.y + 0.5));
    if (dist <= FARM_RANGE_TILES && dist < bestDist) {
      bestDist = dist;
      best = building;
    }
  }
  return best;
}

function cropStageFor(buildingId: string): CropStage {
  const plot = farmPlots.get(buildingId);
  if (!plot) return "empty";
  return computeCropStage(plot, serverNow());
}

function renderFarmPrompt(): void {
  if (localZone !== "overworld") {
    farmPromptEl.style.display = "none";
    return;
  }
  const plotBuilding = nearestFarmPlot();
  if (!plotBuilding) {
    farmPromptEl.style.display = "none";
    return;
  }

  const stage = cropStageFor(plotBuilding.id);
  farmPromptEl.innerHTML = "";
  farmPromptEl.style.display = "flex";

  const label = document.createElement("span");
  label.textContent = `Farm plot: ${stage}`;
  farmPromptEl.append(label);

  if (stage === "empty") {
    for (const [seedKind, cropKind] of Object.entries(SEED_TO_CROP)) {
      const haveSeeds = myInventory[seedKind as ItemKind] > 0;
      const btn = document.createElement("button");
      btn.textContent = `Plant ${cropKind} (needs ${seedKind})`;
      btn.disabled = !haveSeeds;
      btn.addEventListener("click", () => {
        client.farmAction(plotBuilding.id, "plant", seedKind, crypto.randomUUID());
      });
      farmPromptEl.append(btn);
    }
  } else if (stage === "planted" || stage === "growing") {
    const btn = document.createElement("button");
    btn.textContent = "Water";
    btn.addEventListener("click", () => {
      client.farmAction(plotBuilding.id, "water", undefined, crypto.randomUUID());
    });
    farmPromptEl.append(btn);
  } else if (stage === "mature") {
    const btn = document.createElement("button");
    btn.textContent = "Harvest";
    btn.addEventListener("click", () => {
      client.farmAction(plotBuilding.id, "harvest", undefined, crypto.randomUUID());
    });
    farmPromptEl.append(btn);
  }
}

function openChest(chestId: string): void {
  openChestId = chestId;
  lastChestItems = emptyInventory();
  chestPanelEl.style.display = "block";
  renderChestPanel();
}

function closeChest(): void {
  openChestId = null;
  chestPanelEl.style.display = "none";
}

function renderChestPanel(): void {
  if (!openChestId) return;
  chestRowsEl.innerHTML = "";
  for (const kind of ITEM_KINDS) {
    const row = document.createElement("div");
    row.className = "chest-row";

    const label = document.createElement("span");
    label.textContent = `${kind}: ${lastChestItems[kind]} (you: ${myInventory[kind]})`;

    const depositBtn = document.createElement("button");
    depositBtn.textContent = "Deposit 1";
    depositBtn.disabled = myInventory[kind] <= 0;
    depositBtn.addEventListener("click", () => {
      client.chestTransfer(openChestId!, kind, 1, "deposit", crypto.randomUUID());
    });

    const withdrawBtn = document.createElement("button");
    withdrawBtn.textContent = "Withdraw 1";
    withdrawBtn.disabled = lastChestItems[kind] <= 0;
    withdrawBtn.addEventListener("click", () => {
      client.chestTransfer(openChestId!, kind, 1, "withdraw", crypto.randomUUID());
    });

    row.append(label, depositBtn, withdrawBtn);
    chestRowsEl.append(row);
  }
}

chestCloseEl.addEventListener("click", closeChest);

/** Materials the beacon accepts — same set as server/room.ts's BeaconMaterial. */
const BEACON_MATERIALS: Array<{ kind: "wood" | "stone" | "ancient_core"; label: string }> = [
  { kind: "wood", label: "Wood" },
  { kind: "stone", label: "Stone" },
  { kind: "ancient_core", label: "Ancient Core" },
];

function nearestBeacon(): MapObject | null {
  if (!world || localZone !== "dungeon") return null;
  const beacon = world.dungeon.objects.find((o) => o.kind === "ancient_beacon");
  if (!beacon) return null;
  const dist = Math.hypot(localPos.x - (beacon.x + 0.5), localPos.y - (beacon.y + 0.5));
  return dist <= BUILD_RANGE_TILES ? beacon : null;
}

function openBeacon(): void {
  beaconOpen = true;
  beaconPanelEl.style.display = "block";
  renderBeaconPanel();
}

function closeBeacon(): void {
  beaconOpen = false;
  beaconPanelEl.style.display = "none";
}

beaconCloseEl.addEventListener("click", closeBeacon);
beaconActivateEl.addEventListener("click", () => {
  client.activateBeacon(crypto.randomUUID());
});

function renderBeaconPanel(): void {
  if (!beaconOpen || !beaconProgress) return;
  const p = beaconProgress;

  beaconRequirementsEl.innerHTML = "";
  const rows: Array<[string, number, number]> = [
    ["Wood", p.wood, p.requiredWood],
    ["Stone", p.stone, p.requiredStone],
    ["Ancient Core", p.ancientCore, p.requiredAncientCore],
  ];
  for (const [label, have, need] of rows) {
    const row = document.createElement("div");
    row.className = "req-row" + (have >= need ? " met" : "");
    row.textContent = `${label}: ${have} / ${need}`;
    beaconRequirementsEl.append(row);
  }
  const bossRow = document.createElement("div");
  bossRow.className = "req-row" + (p.bossDefeated ? " met" : "");
  bossRow.textContent = p.bossDefeated ? "Guardian boss: defeated" : "Guardian boss: not yet defeated";
  beaconRequirementsEl.append(bossRow);

  beaconDepositRowsEl.innerHTML = "";
  for (const { kind, label } of BEACON_MATERIALS) {
    const row = document.createElement("div");
    row.className = "deposit-row";
    const span = document.createElement("span");
    span.textContent = `${label} (you have ${myInventory[kind as ItemKind] ?? 0})`;
    const btn = document.createElement("button");
    btn.textContent = "Deposit 1";
    btn.disabled = (myInventory[kind as ItemKind] ?? 0) <= 0;
    btn.addEventListener("click", () => {
      client.depositBeacon(kind, 1, crypto.randomUUID());
    });
    row.append(span, btn);
    beaconDepositRowsEl.append(row);
  }

  const met = p.wood >= p.requiredWood && p.stone >= p.requiredStone && p.ancientCore >= p.requiredAncientCore;
  beaconActivateEl.disabled = p.activated || !p.bossDefeated || !met;
  beaconActivateEl.textContent = p.activated ? "Beacon already lit" : "Activate Beacon";
}

joinNameEl.focus();

function nearestInteractable(): MapObject | null {
  if (!world) return null;
  const zoneObjects = localZone === "overworld" ? world.objects : world.dungeon.objects;
  let best: MapObject | null = null;
  let bestDist = Infinity;
  for (const obj of zoneObjects) {
    if (!obj.resource || obj.resource.remaining <= 0) continue;
    const dist = Math.hypot(localPos.x - (obj.x + 0.5), localPos.y - (obj.y + 0.5));
    if (dist <= GATHER_RANGE_TILES && dist < bestDist) {
      bestDist = dist;
      best = obj;
    }
  }
  return best;
}

/** The nearest dungeon_entrance (overworld) or dungeon_exit (dungeon) object the player can use right now. */
function nearestZoneTransition(): MapObject | null {
  if (!world) return null;
  const zoneObjects = localZone === "overworld" ? world.objects : world.dungeon.objects;
  for (const obj of zoneObjects) {
    if (obj.kind !== "dungeon_entrance" && obj.kind !== "dungeon_exit") continue;
    const dist = Math.hypot(localPos.x - (obj.x + 0.5), localPos.y - (obj.y + 0.5));
    if (dist <= ZONE_TRANSITION_RANGE_TILES) return obj;
  }
  return null;
}

function nearestAttackableEnemy(): SnapshotEnemy | null {
  let best: SnapshotEnemy | null = null;
  let bestDist = Infinity;
  for (const enemy of enemies) {
    if (enemy.zone !== localZone) continue;
    const dist = Math.hypot(localPos.x - enemy.x, localPos.y - enemy.y);
    if (dist <= ATTACK_RANGE_TILES && dist < bestDist) {
      bestDist = dist;
      best = enemy;
    }
  }
  return best;
}

/** The E action: gather/interact if something's in range, otherwise use a zone transition in range. Shared by the keyboard handler and the touch interact button. */
function performInteract(): void {
  const gatherTarget = nearestInteractable();
  if (gatherTarget) {
    client.interact(gatherTarget.id, crypto.randomUUID());
    return;
  }
  const zoneObj = nearestZoneTransition();
  if (zoneObj) {
    const target: Zone = localZone === "overworld" ? "dungeon" : "overworld";
    client.enterZone(zoneObj.id, target, crypto.randomUUID());
  }
}

/** The Space action: attack the nearest enemy in range. Shared by the keyboard handler and the touch attack button. */
function performAttack(): void {
  if (!localAlive) return;
  const target = nearestAttackableEnemy();
  if (target) client.attack(target.id, crypto.randomUUID());
}

/** The C action: toggle the nearest chest. Shared by the keyboard handler and the touch chest button. */
function performToggleChest(): void {
  if (openChestId) {
    closeChest();
  } else {
    const chest = nearestChest();
    if (chest) openChest(chest.id);
  }
}

/** The B action: toggle the beacon panel. Shared by the keyboard handler and the touch beacon button. */
function performToggleBeacon(): void {
  if (beaconOpen) {
    closeBeacon();
  } else if (nearestBeacon()) {
    openBeacon();
  }
}

window.addEventListener("keydown", (e) => {
  const key = e.key.toLowerCase();
  if (key === "e") performInteract();
  if (key === " ") {
    e.preventDefault();
    performAttack();
  }
  if (key === "c") performToggleChest();
  if (key === "b") performToggleBeacon();
});

/** Set by the touch joystick's pointer handlers below; {0,0} when no touch drag is active. Kept separate from `keys` so a touch drag and a held keyboard key never fight — sendInputFromKeys sums them and clamps to [-1,1], the same range the server already clamps `setInput` to. */
let touchMove = { dx: 0, dy: 0 };

// Touch joystick: one pointer at a time drags the knob within a fixed
// radius of the base's centre; dx/dy is that offset normalised to [-1,1].
// Pointer Events (not touchstart/touchmove) so the same code also works
// with a mouse for manual testing without a real touch device.
(function setUpTouchJoystick(): void {
  const JOYSTICK_RADIUS_PX = 50;
  let activePointerId: number | null = null;

  function setKnob(dx: number, dy: number): void {
    touchJoystickKnobEl.style.transform = `translate(${dx * JOYSTICK_RADIUS_PX}px, ${dy * JOYSTICK_RADIUS_PX}px)`;
  }

  function updateFromEvent(e: PointerEvent): void {
    const rect = touchJoystickEl.getBoundingClientRect();
    const cx = rect.left + rect.width / 2;
    const cy = rect.top + rect.height / 2;
    const rawDx = (e.clientX - cx) / JOYSTICK_RADIUS_PX;
    const rawDy = (e.clientY - cy) / JOYSTICK_RADIUS_PX;
    const mag = Math.hypot(rawDx, rawDy);
    const clamped = mag > 1 ? { x: rawDx / mag, y: rawDy / mag } : { x: rawDx, y: rawDy };
    touchMove = { dx: clamped.x, dy: clamped.y };
    setKnob(clamped.x, clamped.y);
  }

  function release(): void {
    activePointerId = null;
    touchMove = { dx: 0, dy: 0 };
    setKnob(0, 0);
  }

  touchJoystickEl.addEventListener("pointerdown", (e) => {
    activePointerId = e.pointerId;
    touchJoystickEl.setPointerCapture(e.pointerId);
    updateFromEvent(e);
  });
  touchJoystickEl.addEventListener("pointermove", (e) => {
    if (e.pointerId !== activePointerId) return;
    updateFromEvent(e);
  });
  touchJoystickEl.addEventListener("pointerup", (e) => {
    if (e.pointerId !== activePointerId) return;
    release();
  });
  touchJoystickEl.addEventListener("pointercancel", (e) => {
    if (e.pointerId !== activePointerId) return;
    release();
  });
})();

// Touch action buttons call the exact same handlers the keyboard does
// (performInteract/performAttack/performToggleChest/performToggleBeacon),
// so touch and keyboard can never diverge in what a given action does.
touchInteractEl.addEventListener("click", () => performInteract());
touchAttackEl.addEventListener("click", () => performAttack());
touchChestEl.addEventListener("click", () => performToggleChest());
touchBeaconEl.addEventListener("click", () => performToggleBeacon());

function sendInputFromKeys(): void {
  if (!localAlive) {
    client.sendInput(0, 0);
    return;
  }
  let dx = touchMove.dx;
  let dy = touchMove.dy;
  if (keys.has("w") || keys.has("arrowup")) dy -= 1;
  if (keys.has("s") || keys.has("arrowdown")) dy += 1;
  if (keys.has("a") || keys.has("arrowleft")) dx -= 1;
  if (keys.has("d") || keys.has("arrowright")) dx += 1;
  dx = Math.max(-1, Math.min(1, dx));
  dy = Math.max(-1, Math.min(1, dy));
  if (dx !== 0 || dy !== 0) facing = { dx, dy };
  client.sendInput(dx, dy);
}

function renderZonePrompt(): void {
  const zoneObj = nearestZoneTransition();
  if (zoneObj && !nearestInteractable()) {
    zonePromptEl.textContent =
      localZone === "overworld" ? "press E to enter the dungeon" : "press E to return to the overworld";
    zonePromptEl.style.display = "block";
  } else {
    zonePromptEl.style.display = "none";
  }
}

function frame(): void {
  sendInputFromKeys();

  if (world) {
    const renderT = renderTimeFor(performance.now(), RENDER_DELAY_MS);
    const zone = localZone === "overworld" ? world : world.dungeon;
    // Remote players/enemies are drawn at an interpolated position (see
    // interpolation.ts) — this only affects what's drawn; nearestInteractable/
    // nearestAttackableEnemy/etc. below still use the raw, server-authoritative
    // positions in `remotePlayers`/`enemies`, so range checks never drift from
    // what the server will actually validate.
    const players: RenderPlayer[] = [...remotePlayers.entries()]
      .filter(([, p]) => p.zone === localZone)
      .map(([id, p]) => {
        const isLocal = id === localPlayerId;
        const drawn = isLocal ? { x: p.x, y: p.y } : (remotePlayerBuffers.get(id)?.sample(renderT) ?? { x: p.x, y: p.y });
        return { id, x: drawn.x, y: drawn.y, isLocal, alive: p.alive };
      });
    const zoneBuildings = localZone === "overworld" ? [...buildings.values()] : [];
    const zoneEnemies: RenderEnemy[] = enemies
      .filter((e) => e.zone === localZone)
      .map((e) => {
        const drawn = enemyBuffers.get(e.id)?.sample(renderT) ?? { x: e.x, y: e.y };
        return { ...e, x: drawn.x, y: drawn.y };
      });

    // Same targeting logic the E/Space/C handlers use (nearestInteractable,
    // nearestZoneTransition, nearestAttackableEnemy, nearestChest) — drawn as
    // rings so a player sees what a key press will affect before pressing it.
    const highlights: Array<{ x: number; y: number; color: string }> = [];
    const gatherTarget = nearestInteractable();
    if (gatherTarget) highlights.push({ x: gatherTarget.x + 0.5, y: gatherTarget.y + 0.5, color: "#ffd84a" });
    const zoneTarget = !gatherTarget ? nearestZoneTransition() : null;
    if (zoneTarget) highlights.push({ x: zoneTarget.x + 0.5, y: zoneTarget.y + 0.5, color: "#c9a7ff" });
    const attackTarget = nearestAttackableEnemy();
    if (attackTarget) highlights.push({ x: attackTarget.x, y: attackTarget.y, color: "#ff5a5a" });
    const chestTarget = nearestChest();
    if (chestTarget) highlights.push({ x: chestTarget.x + 0.5, y: chestTarget.y + 0.5, color: "#4ac6ff" });
    const farmTarget = nearestFarmPlot();
    if (farmTarget) highlights.push({ x: farmTarget.x + 0.5, y: farmTarget.y + 0.5, color: "#8a6a3a" });

    render(
      ctx,
      zone,
      players,
      zoneBuildings,
      zoneEnemies,
      localPos,
      { width: canvas.width, height: canvas.height },
      isNight,
      highlights,
    );

    promptEl.textContent = "press E to gather";
    promptEl.style.display = gatherTarget ? "block" : "none";
    renderZonePrompt();
    renderFarmPrompt();
  }

  requestAnimationFrame(frame);
}

requestAnimationFrame(frame);
