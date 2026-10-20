import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openDatabase } from "../src/server/db.js";
import {
  IDENTITY_MAX_AGE_MS,
  IDENTITY_ROTATE_AFTER_MS,
  buildSetCookieHeader,
  createAnonymousId,
  getPlayerRecord,
  loadOrCreateSessionSecret,
  mintCookieValue,
  parseCookie,
  resolveIdentity,
  revokePlayerRecord,
  touchPlayerRecord,
  verifyCookieValue,
} from "../src/server/identity.js";

describe("cookie sign/verify (pure, no DB)", () => {
  const secret = randomBytes(32);

  it("round-trips a freshly minted cookie", () => {
    const id = createAnonymousId();
    const issuedAt = Date.now();
    const value = mintCookieValue(secret, id, issuedAt);
    const verified = verifyCookieValue(secret, value);
    expect(verified).not.toBeNull();
    expect(verified!.id).toBe(id);
    expect(verified!.issuedAt).toBe(issuedAt);
  });

  it("rejects a tampered signature", () => {
    const id = createAnonymousId();
    const value = mintCookieValue(secret, id, Date.now());
    const tampered = value.slice(0, -2) + "00";
    expect(verifyCookieValue(secret, tampered)).toBeNull();
  });

  it("rejects a cookie signed with a different secret", () => {
    const id = createAnonymousId();
    const value = mintCookieValue(secret, id, Date.now());
    const otherSecret = randomBytes(32);
    expect(verifyCookieValue(otherSecret, value)).toBeNull();
  });

  it("rejects a malformed value (wrong number of parts)", () => {
    expect(verifyCookieValue(secret, "not-a-valid-cookie")).toBeNull();
    expect(verifyCookieValue(secret, "a.b")).toBeNull();
    expect(verifyCookieValue(secret, "")).toBeNull();
  });

  it("rejects an id that isn't a UUID shape", () => {
    const value = mintCookieValue(secret, "../../etc/passwd", Date.now());
    expect(verifyCookieValue(secret, value)).toBeNull();
  });

  it("rejects an expired cookie (older than IDENTITY_MAX_AGE_MS)", () => {
    const id = createAnonymousId();
    const longAgo = Date.now() - IDENTITY_MAX_AGE_MS - 1000;
    const value = mintCookieValue(secret, id, longAgo);
    expect(verifyCookieValue(secret, value)).toBeNull();
  });

  it("rejects a cookie issued in the future", () => {
    const id = createAnonymousId();
    const future = Date.now() + 60_000;
    const value = mintCookieValue(secret, id, future);
    expect(verifyCookieValue(secret, value)).toBeNull();
  });

  it("flags needsRotation once the cookie is older than IDENTITY_ROTATE_AFTER_MS, but still valid", () => {
    const id = createAnonymousId();
    const old = Date.now() - IDENTITY_ROTATE_AFTER_MS - 1000;
    const value = mintCookieValue(secret, id, old);
    const verified = verifyCookieValue(secret, value);
    expect(verified).not.toBeNull();
    expect(verified!.needsRotation).toBe(true);
  });

  it("does not flag needsRotation for a fresh cookie", () => {
    const id = createAnonymousId();
    const value = mintCookieValue(secret, id);
    const verified = verifyCookieValue(secret, value);
    expect(verified!.needsRotation).toBe(false);
  });
});

describe("parseCookie", () => {
  it("extracts the named cookie from a multi-cookie header", () => {
    expect(parseCookie("a=1; ls_id=abc123; b=2", "ls_id")).toBe("abc123");
  });

  it("returns undefined when the cookie is absent", () => {
    expect(parseCookie("a=1; b=2", "ls_id")).toBeUndefined();
    expect(parseCookie(undefined, "ls_id")).toBeUndefined();
  });

  it("URL-decodes the value", () => {
    expect(parseCookie("ls_id=a%2Eb%2Ec", "ls_id")).toBe("a.b.c");
  });
});

describe("buildSetCookieHeader", () => {
  it("marks the cookie HttpOnly and never exposes it to client JS by name alone", () => {
    const header = buildSetCookieHeader("some-value");
    expect(header).toContain("HttpOnly");
    expect(header).toContain("SameSite=Lax");
    expect(header).toContain("Path=/");
  });
});

describe("identity + players table (DB-backed)", () => {
  let dir: string;
  let dbPath: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "last-shelter-identity-test-"));
    dbPath = join(dir, "world.sqlite");
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("generates a session secret once and reuses it across loads", () => {
    const db = openDatabase(dbPath);
    const secretA = loadOrCreateSessionSecret(db);
    const secretB = loadOrCreateSessionSecret(db);
    expect(secretA.equals(secretB)).toBe(true);
    db.close();
  });

  it("the secret survives a close and reopen", () => {
    const db1 = openDatabase(dbPath);
    const secret1 = loadOrCreateSessionSecret(db1);
    db1.close();

    const db2 = openDatabase(dbPath);
    const secret2 = loadOrCreateSessionSecret(db2);
    db2.close();

    expect(secret1.equals(secret2)).toBe(true);
  });

  it("resolveIdentity returns null for a missing cookie (treated as a fresh visitor)", () => {
    const db = openDatabase(dbPath);
    const secret = loadOrCreateSessionSecret(db);
    expect(resolveIdentity(db, secret, undefined)).toBeNull();
    db.close();
  });

  it("resolveIdentity returns the id for a valid, untampered cookie", () => {
    const db = openDatabase(dbPath);
    const secret = loadOrCreateSessionSecret(db);
    const id = createAnonymousId();
    touchPlayerRecord(db, id, "Alice");
    const cookieValue = mintCookieValue(secret, id);

    const resolved = resolveIdentity(db, secret, `ls_id=${encodeURIComponent(cookieValue)}`);
    expect(resolved).not.toBeNull();
    expect(resolved!.id).toBe(id);
    db.close();
  });

  it("resolveIdentity returns null for a cookie signed with a stale/different secret (e.g. after a fresh DB)", () => {
    const db = openDatabase(dbPath);
    const secret = loadOrCreateSessionSecret(db);
    const id = createAnonymousId();
    const cookieValue = mintCookieValue(randomBytes(32), id); // wrong secret

    expect(resolveIdentity(db, secret, `ls_id=${cookieValue}`)).toBeNull();
    db.close();
  });

  it("resolveIdentity rejects a revoked player even with a valid signature", () => {
    const db = openDatabase(dbPath);
    const secret = loadOrCreateSessionSecret(db);
    const id = createAnonymousId();
    touchPlayerRecord(db, id, "Alice");
    revokePlayerRecord(db, id);
    const cookieValue = mintCookieValue(secret, id);

    expect(resolveIdentity(db, secret, `ls_id=${cookieValue}`)).toBeNull();
    db.close();
  });

  it("touchPlayerRecord upserts name and preserves revoked_at across updates", () => {
    const db = openDatabase(dbPath);
    const id = createAnonymousId();
    touchPlayerRecord(db, id, "Alice");
    touchPlayerRecord(db, id, "Alice Renamed");
    const record = getPlayerRecord(db, id);
    expect(record?.name).toBe("Alice Renamed");
    expect(record?.revokedAt).toBeNull();
    db.close();
  });
});
