import type { ItemKind } from "./types.js";

export type RecipeId =
  | "axe"
  | "pickaxe"
  | "sword"
  | "bandage"
  | "seed_berry"
  | "workbench"
  | "chest"
  | "wall"
  | "floor"
  | "farm_plot"
  | "campfire";

/** What a recipe produces when crafted: either an inventory item, or a placeable building. */
export type RecipeOutput =
  | { type: "item"; kind: ItemKind; qty: number }
  | { type: "building"; kind: "wall" | "floor" | "campfire" | "workbench" | "chest" | "farm_plot" };

export interface Recipe {
  id: RecipeId;
  name: string;
  inputs: Partial<Record<ItemKind, number>>;
  output: RecipeOutput;
}

/**
 * The single data-driven source of truth for every craftable thing. Both
 * crafting (`Room.craft`) and building (`Room.build`) validate against this
 * registry rather than trusting anything the client sends beyond a recipe id.
 */
export const RECIPES: Record<RecipeId, Recipe> = {
  axe: {
    id: "axe",
    name: "Axe",
    inputs: { wood: 3, stone: 2 },
    output: { type: "item", kind: "axe", qty: 1 },
  },
  pickaxe: {
    id: "pickaxe",
    name: "Pickaxe",
    inputs: { wood: 3, stone: 3 },
    output: { type: "item", kind: "pickaxe", qty: 1 },
  },
  sword: {
    id: "sword",
    name: "Sword",
    inputs: { wood: 2, stone: 4 },
    output: { type: "item", kind: "sword", qty: 1 },
  },
  bandage: {
    id: "bandage",
    name: "Bandage",
    inputs: { berries: 3 },
    output: { type: "item", kind: "bandage", qty: 1 },
  },
  seed_berry: {
    id: "seed_berry",
    name: "Berry Seeds",
    inputs: { berries: 1 },
    output: { type: "item", kind: "seed_berry", qty: 2 },
  },
  workbench: {
    id: "workbench",
    name: "Workbench",
    inputs: { wood: 6 },
    output: { type: "building", kind: "workbench" },
  },
  chest: {
    id: "chest",
    name: "Storage Chest",
    inputs: { wood: 5 },
    output: { type: "building", kind: "chest" },
  },
  wall: {
    id: "wall",
    name: "Wall",
    inputs: { wood: 2, stone: 1 },
    output: { type: "building", kind: "wall" },
  },
  floor: {
    id: "floor",
    name: "Floor",
    inputs: { wood: 1 },
    output: { type: "building", kind: "floor" },
  },
  farm_plot: {
    id: "farm_plot",
    name: "Farm Plot",
    inputs: { wood: 2 },
    output: { type: "building", kind: "farm_plot" },
  },
  campfire: {
    id: "campfire",
    name: "Campfire",
    inputs: { wood: 4, stone: 2 },
    output: { type: "building", kind: "campfire" },
  },
};

export function getRecipe(id: string): Recipe | undefined {
  return (RECIPES as Record<string, Recipe>)[id];
}
