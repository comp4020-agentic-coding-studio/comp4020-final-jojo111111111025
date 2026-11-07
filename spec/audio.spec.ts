import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * audio.ts's Audio/HTMLAudioElement calls have no real implementation in
 * this project's "node" test environment (no jsdom, and jsdom itself has no
 * media decoder anyway — see sprites.spec.ts's note on the equivalent
 * Image-loading gap). A fake Audio class stubbed in as the global
 * constructor is enough to exercise loadSounds()/playSound()'s own logic
 * (which clip maps to which path, cloning for overlap, swallowing a
 * rejected play()) without needing real audio decoding.
 */
class FakeAudio {
  src: string;
  preload = "";
  volume = 1;
  played = 0;
  shouldReject = false;
  constructor(src: string) {
    this.src = src;
  }
  play(): Promise<void> {
    this.played++;
    return this.shouldReject ? Promise.reject(new Error("no user gesture yet")) : Promise.resolve();
  }
  cloneNode(): FakeAudio {
    // audio.ts's playSound clones via the global Audio constructor
    // (`base.cloneNode(true) as HTMLAudioElement`), so the clone must go
    // through whatever subclass is currently stubbed in as `Audio` — the
    // one that records into `instances` — not this base class directly,
    // or a cloned-and-played instance would silently vanish from the count.
    const Ctor = (globalThis as unknown as { Audio: new (src: string) => FakeAudio }).Audio;
    const clone = new Ctor(this.src);
    clone.volume = this.volume;
    clone.shouldReject = this.shouldReject;
    return clone;
  }
}

let instances: FakeAudio[] = [];

beforeEach(() => {
  instances = [];
  vi.stubGlobal(
    "Audio",
    class extends FakeAudio {
      constructor(src: string) {
        super(src);
        instances.push(this);
      }
    },
  );
  vi.resetModules();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("loadSounds", () => {
  it("creates one Audio instance per known sound name", async () => {
    const { loadSounds } = await import("../src/client/audio.js");
    loadSounds();
    expect(instances.length).toBe(7);
  });

  it("is safe to call more than once — doesn't create duplicate Audio instances", async () => {
    const { loadSounds } = await import("../src/client/audio.js");
    loadSounds();
    loadSounds();
    expect(instances.length).toBe(7);
  });

  it("points each sound at a distinct /assets/audio/ path", async () => {
    const { loadSounds } = await import("../src/client/audio.js");
    loadSounds();
    const srcs = instances.map((i) => i.src);
    expect(new Set(srcs).size).toBe(srcs.length);
    for (const src of srcs) expect(src).toMatch(/^\/assets\/audio\//);
  });
});

describe("playSound", () => {
  it("does nothing (no throw) when called before loadSounds", async () => {
    const { playSound } = await import("../src/client/audio.js");
    expect(() => playSound("gather")).not.toThrow();
    expect(instances.length).toBe(0);
  });

  it("plays a cloned instance, not the original loaded node (so overlapping plays don't cut each other off)", async () => {
    const { loadSounds, playSound } = await import("../src/client/audio.js");
    loadSounds();
    const original = instances.find((i) => i.src.includes("gather"))!;
    playSound("gather");
    expect(original.played).toBe(0); // the original node's own play() was never called
    expect(instances.length).toBe(8); // the original 7, plus one clone
  });

  it("swallows a rejected play() (e.g. no user gesture yet) without throwing", async () => {
    const { loadSounds, playSound } = await import("../src/client/audio.js");
    loadSounds();
    const original = instances.find((i) => i.src.includes("sword-attack"))!;
    original.shouldReject = true;
    expect(() => playSound("swordAttack")).not.toThrow();
    // Let the rejected promise's .catch() microtask settle before the test ends.
    await new Promise((resolve) => setTimeout(resolve, 0));
  });

  it("playing the same sound twice produces two overlapping clone instances", async () => {
    const { loadSounds, playSound } = await import("../src/client/audio.js");
    loadSounds();
    playSound("craftSuccess");
    playSound("craftSuccess");
    const clones = instances.filter((i) => i.src.includes("craft-success"));
    expect(clones.length).toBe(3); // the original loaded node, plus two played clones
  });
});
