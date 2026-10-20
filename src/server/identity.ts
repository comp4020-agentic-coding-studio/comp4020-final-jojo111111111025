import { createHmac, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import type Database from "better-sqlite3";

export const IDENTITY_COOKIE_NAME = "ls_id";
export const IDENTITY_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
export const IDENTITY_ROTATE_AFTER_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

export interface VerifiedIdentity {
  id: string;
  issuedAt: number;
  /** True if this identity's cookie is old enough that the caller should reissue it with a fresh timestamp. */
  needsRotation: boolean;
}

function sign(secret: Buffer, id: string, issuedAt: number): string {
  return createHmac("sha256", secret).update(`${id}.${issuedAt}`).digest("hex");
}

/** Builds a fresh, signed cookie value for a (possibly pre-existing) id. */
export function mintCookieValue(secret: Buffer, id: string, issuedAt: number = Date.now()): string {
  const tag = sign(secret, id, issuedAt);
  return `${id}.${issuedAt}.${tag}`;
}

/**
 * Verifies a cookie value's structure and signature, independent of any
 * database lookup. Returns null for anything malformed, mistagged, or
 * expired — an invalid cookie is never partially trusted.
 */
export function verifyCookieValue(secret: Buffer, value: string): VerifiedIdentity | null {
  const parts = value.split(".");
  if (parts.length !== 3) return null;
  const [id, issuedAtStr, tag] = parts as [string, string, string];

  if (!/^[0-9a-f-]{36}$/.test(id)) return null;
  const issuedAt = Number(issuedAtStr);
  if (!Number.isFinite(issuedAt) || issuedAt <= 0) return null;

  const expectedTag = sign(secret, id, issuedAt);
  const expectedBuf = Buffer.from(expectedTag, "hex");
  const actualBuf = Buffer.from(tag, "hex");
  if (expectedBuf.length !== actualBuf.length) return null;
  if (!timingSafeEqual(expectedBuf, actualBuf)) return null;

  const age = Date.now() - issuedAt;
  if (age < 0 || age > IDENTITY_MAX_AGE_MS) return null;

  return { id, issuedAt, needsRotation: age > IDENTITY_ROTATE_AFTER_MS };
}

/** Parses a raw `Cookie:` header value and returns the named cookie's value, if present. */
export function parseCookie(header: string | undefined, name: string): string | undefined {
  if (!header) return undefined;
  for (const part of header.split(";")) {
    const idx = part.indexOf("=");
    if (idx === -1) continue;
    const key = part.slice(0, idx).trim();
    if (key === name) return decodeURIComponent(part.slice(idx + 1).trim());
  }
  return undefined;
}

export function buildSetCookieHeader(value: string, maxAgeMs: number = IDENTITY_MAX_AGE_MS): string {
  const maxAgeSeconds = Math.floor(maxAgeMs / 1000);
  return `${IDENTITY_COOKIE_NAME}=${encodeURIComponent(value)}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${maxAgeSeconds}`;
}

// --- Secret persistence ---------------------------------------------------

export function loadOrCreateSessionSecret(db: Database.Database): Buffer {
  const row = db.prepare("SELECT secret FROM session_secret WHERE id = 1").get() as
    | { secret: Buffer }
    | undefined;
  if (row) return Buffer.from(row.secret);

  const secret = randomBytes(32);
  db.prepare("INSERT INTO session_secret (id, secret) VALUES (1, ?)").run(secret);
  return secret;
}

// --- Players table ---------------------------------------------------------

export interface PlayerRecord {
  id: string;
  name: string;
  revokedAt: string | null;
}

export function getPlayerRecord(db: Database.Database, id: string): PlayerRecord | undefined {
  const row = db.prepare("SELECT id, name, revoked_at FROM players WHERE id = ?").get(id) as
    | { id: string; name: string; revoked_at: string | null }
    | undefined;
  if (!row) return undefined;
  return { id: row.id, name: row.name, revokedAt: row.revoked_at };
}

/** Upserts a player's name/last_seen_at on every successful join (new or reconnect). */
export function touchPlayerRecord(db: Database.Database, id: string, name: string): void {
  db.prepare(
    `INSERT INTO players (id, name) VALUES (?, ?)
     ON CONFLICT(id) DO UPDATE SET name = excluded.name, last_seen_at = datetime('now')`,
  ).run(id, name);
}

export function revokePlayerRecord(db: Database.Database, id: string): void {
  db.prepare("UPDATE players SET revoked_at = datetime('now') WHERE id = ?").run(id);
}

/**
 * Resolves the stable identity behind an incoming request's cookie header.
 * Returns null if there's no usable cookie (missing, malformed, tampered,
 * expired, or belonging to a revoked player) — the caller then mints a
 * fresh identity exactly as if no cookie had been sent at all, the same
 * "unsigned cookie treated like no cookie" rule The Wall project documents.
 */
export function resolveIdentity(
  db: Database.Database,
  secret: Buffer,
  cookieHeader: string | undefined,
): { id: string; needsRotation: boolean } | null {
  const raw = parseCookie(cookieHeader, IDENTITY_COOKIE_NAME);
  if (!raw) return null;

  const verified = verifyCookieValue(secret, raw);
  if (!verified) return null;

  const record = getPlayerRecord(db, verified.id);
  if (record?.revokedAt) return null;

  return { id: verified.id, needsRotation: verified.needsRotation };
}

export function createAnonymousId(): string {
  return randomUUID();
}
