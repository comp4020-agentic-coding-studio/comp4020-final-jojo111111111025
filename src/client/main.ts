import { ATTACK_RANGE_TILES, BUILD_RANGE_TILES, GATHER_RANGE_TILES, MAX_HEALTH, SNAPSHOT_MS } from "../shared/constants.js";
import { RECIPES } from "../shared/recipes.js";
import type { Building, ItemKind, MapObject, WorldMap } from "../shared/types.js";
import { ITEM_KINDS, emptyInventory } from "../shared/types.js";
import { loadSounds, playSound, setBgmZone, startBgm } from "./audio.js";
import { InterpolationBuffer, renderTimeFor } from "./interpolation.js";
import { applyObjectDepleted, findGainedItem, GameClient, isBuildCellFree, type SnapshotEnemy } from "./net.js";
import { render, type RenderEnemy, type RenderPlayer } from "./render.js";
import { loadSprites } from "./sprites.js";

const canvas = document.getElementById("canvas") as HTMLCanvasElement;
const ctx = canvas.getContext("2d")!;
// Pixel-art sprites must not be bilinear-smoothed — the canvas default would
// blur every sprite at any non-integer scale. (Set in resize(), below,
// since resizing the canvas's backing store resets all 2D context state
// including this flag — a one-time set here would be lost on first resize.)
void loadSprites(); // starts loading immediately; frame() tolerates not-yet-loaded sheets (see sprites.ts/render.ts's fallback colors)
loadSounds(); // starts loading immediately; playSound() tolerates not-yet-loaded (or never-loaded) clips the same way
const statusEl = document.getElementById("status")!;
const promptEl = document.getElementById("prompt")!;
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
const victoryScreenEl = document.getElementById("victory-screen")!;
const victoryDetailEl = document.getElementById("victory-detail")!;
const playAgainButtonEl = document.getElementById("play-again-button") as HTMLButtonElement;
const touchJoystickEl = document.getElementById("touch-joystick")!;
const touchJoystickKnobEl = document.getElementById("touch-joystick-knob")!;
const touchInteractEl = document.getElementById("touch-interact") as HTMLButtonElement;
const touchAttackEl = document.getElementById("touch-attack") as HTMLButtonElement;
const touchChestEl = document.getElementById("touch-chest") as HTMLButtonElement;
const touchBandageEl = document.getElementById("touch-bandage") as HTMLButtonElement;
const resourceEls: Partial<Record<ItemKind, HTMLElement>> = {
  wood: document.getElementById("wood") ?? undefined,
  stone: document.getElementById("stone") ?? undefined,
  berries: document.getElementById("berries") ?? undefined,
  axe: document.getElementById("axe") ?? undefined,
  pickaxe: document.getElementById("pickaxe") ?? undefined,
  sword: document.getElementById("sword") ?? undefined,
  bandage: document.getElementById("bandage") ?? undefined,
};

let world: WorldMap | null = null;
let localPlayerId: string | null = null;
let localAlive = true;
let localHealth = 100;
const remotePlayers = new Map<string, { x: number; y: number; alive: boolean }>();
const buildings = new Map<string, Building>();
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
let isNight = false;
let serverTimeOffsetMs = 0; // serverNow - Date.now(), sampled once at join
let localPos = { x: 0, y: 0 };
let facing: { dx: number; dy: number } = { dx: 0, dy: 1 };
let myInventory: Record<ItemKind, number> = emptyInventory();
let openChestId: string | null = null;
let lastChestItems: Record<ItemKind, number> = emptyInventory();
let victoryShown = false;
/** requestIds of in-flight item.useBandage sends, so onActionResult can tell a bandage result apart from every other action's (it shares the same ok/inventory/health shape as nothing else does uniquely enough to tell them apart otherwise). Entries are removed the instant their result arrives. */
const pendingBandageRequests = new Set<string>();

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
 * Human-readable names for the gather-pickup toast (showActionFeedback's
 * "Gathered {item}." message). A gather only ever grants one of these
 * three raw ResourceKinds (see room.ts's doInteract: `object.resource.kind`
 * is typed `ResourceKind`, never a crafted ItemKind) — kept as a
 * `Partial<Record<ItemKind, string>>` rather than `Record<ResourceKind,
 * string>` so the lookup by a plain `ItemKind` string in onActionResult
 * doesn't need a separate narrowing step.
 */
const ITEM_LABELS: Partial<Record<ItemKind, string>> = {
  wood: "wood",
  stone: "stone",
  berries: "berries",
  axe: "axe",
  pickaxe: "pickaxe",
  sword: "sword",
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
  dead: "You're dead — respawn first.",
  not_dead: "You're not dead.",
  already_dead: "Already defeated.",
  on_cooldown: "Not ready yet.",
  insufficient_materials: "Not enough materials.",
  inventory_full: "Your inventory is full.",
  chest_full: "The chest is full.",
  cell_occupied: "Something's already there.",
  out_of_bounds: "Can't place it there.",
  depleted: "Nothing left to gather here.",
  not_gatherable: "Nothing to gather there.",
  invalid_quantity: "Invalid amount.",
  not_a_building_recipe: "That recipe isn't a building.",
  not_an_item_recipe: "That recipe isn't an item.",
  unknown_recipe: "Unknown recipe.",
  unknown_object: "That's gone.",
  unknown_target: "That target's gone.",
  unknown_chest: "That chest is gone.",
  unknown_player: "You're not recognised — try rejoining.",
  unknown_item_kind: "Unknown item.",
  rate_limited: "Slow down a little.",
};

let actionFeedbackTimer: ReturnType<typeof setTimeout> | undefined;
/** The one place every action rejection (and confirmation, when useful) surfaces to the player — see onActionResult. */
function showActionFeedback(message: string, isError: boolean): void {
  actionFeedbackEl.textContent = message;
  actionFeedbackEl.classList.toggle("err", isError);
  actionFeedbackEl.classList.toggle("ok", !isError);
  // Restarting the pop-in animation on a message that arrives while the
  // previous one is still showing (classList.remove then a fresh add,
  // rather than just re-adding "show" to an element that already has it)
  // makes each new message visibly "land" with its own scale/fade-in, not
  // silently swap text on an element that was already fully visible.
  actionFeedbackEl.classList.remove("show");
  void actionFeedbackEl.offsetWidth; // force a reflow so the class removal above actually takes effect before re-adding it
  actionFeedbackEl.classList.add("show");
  clearTimeout(actionFeedbackTimer);
  actionFeedbackTimer = setTimeout(() => actionFeedbackEl.classList.remove("show"), 3200);
  // Every rejected action funnels through here (see onActionResult), so this
  // is the one place that needs the error sound rather than each rejection
  // branch needing its own call.
  if (isError) playSound("actionError");
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
  onSnapshot(snapshot, players, snapshotBuildings, snapshotEnemies, serverTime) {
    world = snapshot;
    serverTimeOffsetMs = serverTime - Date.now();
    remotePlayers.clear();
    for (const p of players) {
      remotePlayers.set(p.id, { x: p.x, y: p.y, alive: p.alive });
      if (p.id === localPlayerId) {
        localPos = { x: p.x, y: p.y };
        localAlive = p.alive;
        localHealth = p.health;
        updateInventory(p.inventory);
        updateHealthUi();
        updateDeathUi();
        // The overworld's one ambience track — join/reconnect always lands
        // in the overworld, there being no other zone any more.
        setBgmZone("overworld");
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
    enemies = snapshotEnemies;
    enemyBuffers.clear();
    for (const e of snapshotEnemies) recordEnemyPosition(e.id, e.x, e.y);
    renderRecipes();
    renderBuildingOptions();
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
      remotePlayers.set(p.id, { x: p.x, y: p.y, alive: p.alive });
      if (p.id === localPlayerId) {
        const wasAlive = localAlive;
        const prevHealth = localHealth;
        localPos = { x: p.x, y: p.y };
        localAlive = p.alive;
        localHealth = p.health;
        updateHealthUi();
        // Any drop in health — a wanderer's contact damage, the boss's
        // telegraphed slam, not just the final hit that kills — gets the
        // same felt reaction; dying is one instance of taking damage, not
        // a separate category of feedback.
        if (p.health < prevHealth) {
          flashDamage();
          triggerShake(3);
        }
        if (wasAlive && !p.alive) playSound("death");
        updateDeathUi();
      } else {
        recordRemotePlayerPosition(p.id, p.x, p.y);
      }
    }
    enemies = snapshotEnemies.map((e) => {
      const prev = enemies.find((existing) => existing.id === e.id);
      return prev ? { ...prev, ...e } : { kind: "wanderer", maxHealth: e.health, ...e };
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
    const prevInventory = myInventory;
    const prevHealth = localHealth;
    if (result.ok && result.inventory) {
      updateInventory(result.inventory);
    }
    // item.useBandage shares its ok/inventory/health result shape with
    // nothing else uniquely enough to tell apart by shape alone — the
    // pending-request set (populated in performUseBandage) is what marks
    // this particular result as a bandage use rather than, say, a respawn.
    if (pendingBandageRequests.delete(result.requestId) && result.ok && result.health !== undefined) {
      playSound("craftSuccess");
      showActionFeedback(`Used a bandage (+${result.health - prevHealth} health).`, false);
      // A rejected bandage use still falls through to the catch-all
      // rejection message below via its `reason`.
    }
    // objectRemaining is only ever set by a player.interact (gather) result
    // — see net.ts's handling of that message type — so its presence is
    // the signal that this is a successful gather, not some other action
    // that also happens to carry an inventory. The server doesn't say
    // which resource kind was granted, so it's derived here from whichever
    // inventory slot increased relative to the pre-update snapshot above.
    if (result.ok && result.objectRemaining !== undefined) {
      playSound("gather");
      const gained = result.inventory ? findGainedItem(prevInventory, result.inventory) : undefined;
      showActionFeedback(gained ? `Gathered ${ITEM_LABELS[gained] ?? gained}.` : "Gathered a resource.", false);
    }
    // toolBroke is only ever set on the exact gather/attack result whose use
    // wore a tool out to 0 (see room.ts's useToolCharge) — takes over
    // whatever feedback that same result would otherwise show, since "your
    // tool just broke" matters more than "you gathered a resource."
    if (result.ok && result.toolBroke) {
      showActionFeedback(`Your ${ITEM_LABELS[result.toolBroke as ItemKind] ?? result.toolBroke} broke!`, true);
    }
    if (result.recipeId) {
      const recipe = RECIPES[result.recipeId as keyof typeof RECIPES];
      const isBuilding = recipe?.output.type === "building";
      const label = recipe?.name ?? result.recipeId;
      craftFeedbackEl.textContent = result.ok
        ? `${isBuilding ? "Placed" : "Crafted"} ${label}.`
        : `Can't ${isBuilding ? "build" : "craft"}: ${ACTION_REASON_MESSAGES[result.reason ?? ""] ?? result.reason}`;
      if (result.ok) {
        playSound("craftSuccess");
        showActionFeedback(`${isBuilding ? "Placed" : "Crafted"} ${label}.`, false);
      }
    }
    if (result.chestItems) {
      lastChestItems = result.chestItems;
      renderChestPanel();
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
  onPlayerDied(event) {
    for (const id of event.removedBuildingIds) buildings.delete(id);
    if (event.playerId === localPlayerId) {
      updateInventory(event.inventory);
      showActionFeedback("You died — your inventory and buildings are gone.", true);
    }
  },
  onCombatEvent(event) {
    if (event.attackerId !== localPlayerId) {
      combatFeedbackEl.textContent = `${event.attackerId === localPlayerId ? "You" : "Someone"} hit for ${event.damage}${event.enemyDied ? " — defeated!" : ""}`;
    }
    const enemy = enemies.find((e) => e.id === event.targetId);
    if (enemy) enemy.health = event.enemyHealth;
    flashEnemy(event.targetId);
    // Every hit on this enemy shakes the screen a little, win or lose — a
    // kill shakes harder, a visible exclamation point on top of the health
    // bar reaching zero.
    if (event.attackerId === localPlayerId) {
      triggerShake(event.enemyDied ? 5 : 2.5);
      playSound("swordAttack");
    }
  },
  onObjectDepleted(event) {
    applyObjectDepleted(world, event);
  },
  onGameVictory(lastKillBy) {
    if (victoryShown) return;
    victoryShown = true;
    victoryDetailEl.textContent =
      lastKillBy === localPlayerId ? "You landed the final blow." : "A fellow survivor landed the final blow.";
    victoryScreenEl.style.display = "flex";
    playSound("victory");
  },
  onGameReset() {
    victoryShown = false;
    victoryScreenEl.style.display = "none";
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
  // The click that triggers this handler is the page's first guaranteed
  // user gesture — starting background music here (rather than at module
  // load, like loadSounds/loadSprites) is what lets the browser's
  // autoplay-after-gesture restriction actually allow it to play.
  startBgm();
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

/**
 * A short, decaying screen shake: frame() samples `shakeMagnitudePx` each
 * tick (while `performance.now() < shakeEndAt`) and feeds a fresh random
 * jitter at that magnitude into render()'s shakeOffset, so the whole scene
 * visibly judders for a beat around a hit — stronger for the boss (bigger
 * stakes, bigger shake) than a sword tap. Re-triggering (e.g. taking a
 * second hit before the first shake ends) simply extends/raises it rather
 * than queuing — only the latest trigger matters.
 */
let shakeEndAt = 0;
let shakeMagnitudePx = 0;
function triggerShake(magnitudePx: number, durationMs = 180): void {
  shakeEndAt = performance.now() + durationMs;
  shakeMagnitudePx = Math.max(shakeMagnitudePx, magnitudePx);
}
function currentShakeOffset(): { x: number; y: number } {
  const now = performance.now();
  if (now >= shakeEndAt) {
    shakeMagnitudePx = 0;
    return { x: 0, y: 0 };
  }
  const remaining = (shakeEndAt - now) / 180; // 1 at trigger, 0 at the end
  const mag = shakeMagnitudePx * remaining;
  return { x: (Math.random() * 2 - 1) * mag, y: (Math.random() * 2 - 1) * mag };
}

/**
 * How long drawEnemy's white hit-flash stays on an enemy after it's named
 * as a combat.event target — short enough to read as a single impact, not
 * a lingering status effect.
 */
const ENEMY_FLASH_MS = 120;
const enemyFlashUntil = new Map<string, number>();
function flashEnemy(enemyId: string): void {
  enemyFlashUntil.set(enemyId, performance.now() + ENEMY_FLASH_MS);
}

respawnButtonEl.addEventListener("click", () => {
  client.respawn(crypto.randomUUID());
});

playAgainButtonEl.addEventListener("click", () => {
  client.playAgain(crypto.randomUUID());
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
    button.disabled = !canAfford(recipe.inputs);
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

function openChest(chestId: string): void {
  openChestId = chestId;
  lastChestItems = emptyInventory();
  chestPanelEl.style.display = "block";
  renderChestPanel();
  playSound("chestOpen");
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

joinNameEl.focus();

function nearestInteractable(): MapObject | null {
  if (!world) return null;
  let best: MapObject | null = null;
  let bestDist = Infinity;
  for (const obj of world.objects) {
    if (!obj.resource || obj.resource.remaining <= 0) continue;
    const dist = Math.hypot(localPos.x - (obj.x + 0.5), localPos.y - (obj.y + 0.5));
    if (dist <= GATHER_RANGE_TILES && dist < bestDist) {
      bestDist = dist;
      best = obj;
    }
  }
  return best;
}

function nearestAttackableEnemy(): SnapshotEnemy | null {
  let best: SnapshotEnemy | null = null;
  let bestDist = Infinity;
  for (const enemy of enemies) {
    const dist = Math.hypot(localPos.x - enemy.x, localPos.y - enemy.y);
    if (dist <= ATTACK_RANGE_TILES && dist < bestDist) {
      bestDist = dist;
      best = enemy;
    }
  }
  return best;
}

/** The E action: gather/interact if something's in range. Shared by the keyboard handler and the touch interact button. */
function performInteract(): void {
  const gatherTarget = nearestInteractable();
  if (gatherTarget) {
    client.interact(gatherTarget.id, crypto.randomUUID());
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

/** The H action: use a bandage if alive, holding at least one, and not already at full health (healing there would just waste the bandage). Shared by the keyboard handler and the touch bandage button. */
function performUseBandage(): void {
  if (!localAlive) return;
  if (myInventory.bandage <= 0) {
    showActionFeedback("No bandages — craft one from 3 berries.", true);
    return;
  }
  if (localHealth >= MAX_HEALTH) {
    showActionFeedback("Already at full health.", true);
    return;
  }
  const requestId = crypto.randomUUID();
  pendingBandageRequests.add(requestId);
  client.useBandage(requestId);
}

window.addEventListener("keydown", (e) => {
  const key = e.key.toLowerCase();
  if (key === "e") performInteract();
  if (key === " ") {
    e.preventDefault();
    performAttack();
  }
  if (key === "c") performToggleChest();
  if (key === "h") performUseBandage();
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
// (performInteract/performAttack/performToggleChest/performUseBandage), so
// touch and keyboard can never diverge in what a given action does.
touchInteractEl.addEventListener("click", () => performInteract());
touchAttackEl.addEventListener("click", () => performAttack());
touchChestEl.addEventListener("click", () => performToggleChest());
touchBandageEl.addEventListener("click", () => performUseBandage());

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

function frame(): void {
  sendInputFromKeys();

  if (world) {
    const renderT = renderTimeFor(performance.now(), RENDER_DELAY_MS);
    // Remote players/enemies are drawn at an interpolated position (see
    // interpolation.ts) — this only affects what's drawn; nearestInteractable/
    // nearestAttackableEnemy/etc. below still use the raw, server-authoritative
    // positions in `remotePlayers`/`enemies`, so range checks never drift from
    // what the server will actually validate.
    const players: RenderPlayer[] = [...remotePlayers.entries()].map(([id, p]) => {
      const isLocal = id === localPlayerId;
      const drawn = isLocal ? { x: p.x, y: p.y } : (remotePlayerBuffers.get(id)?.sample(renderT) ?? { x: p.x, y: p.y });
      return { id, x: drawn.x, y: drawn.y, isLocal, alive: p.alive };
    });
    const now = performance.now();
    const zoneEnemies: RenderEnemy[] = enemies.map((e) => {
      const drawn = enemyBuffers.get(e.id)?.sample(renderT) ?? { x: e.x, y: e.y };
      const flashUntil = enemyFlashUntil.get(e.id);
      return { ...e, x: drawn.x, y: drawn.y, flashing: flashUntil !== undefined && now < flashUntil };
    });

    // Same targeting logic the E/Space/C handlers use (nearestInteractable,
    // nearestAttackableEnemy, nearestChest) — drawn as rings so a player
    // sees what a key press will affect before pressing it.
    const highlights: Array<{ x: number; y: number; color: string }> = [];
    const gatherTarget = nearestInteractable();
    if (gatherTarget) highlights.push({ x: gatherTarget.x + 0.5, y: gatherTarget.y + 0.5, color: "#ffd84a" });
    const attackTarget = nearestAttackableEnemy();
    if (attackTarget) highlights.push({ x: attackTarget.x, y: attackTarget.y, color: "#ff5a5a" });
    const chestTarget = nearestChest();
    if (chestTarget) highlights.push({ x: chestTarget.x + 0.5, y: chestTarget.y + 0.5, color: "#4ac6ff" });
    // Shows exactly the cell a "Place" click would target — the same
    // Math.floor(localPos + facing) formula renderBuildingOptions' click
    // handler sends to the server — so a player sees where a building
    // will land, and whether that cell is free, before committing.
    const buildX = Math.floor(localPos.x + facing.dx);
    const buildY = Math.floor(localPos.y + facing.dy);
    highlights.push({
      x: buildX + 0.5,
      y: buildY + 0.5,
      color: isBuildCellFree(world, buildings, buildX, buildY) ? "#4ad87a" : "#ff8c3a",
    });

    render(
      ctx,
      world,
      players,
      [...buildings.values()],
      zoneEnemies,
      localPos,
      { width: canvas.width, height: canvas.height },
      isNight,
      highlights,
      currentShakeOffset(),
    );

    promptEl.textContent = "press E to gather";
    promptEl.style.display = gatherTarget ? "block" : "none";
  }

  requestAnimationFrame(frame);
}

requestAnimationFrame(frame);
