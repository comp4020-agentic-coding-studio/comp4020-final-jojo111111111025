import { afterEach, describe, expect, it } from "vitest";
import { mintCookieValue, loadOrCreateSessionSecret, revokePlayerRecord, touchPlayerRecord } from "../src/server/identity.js";
import { TestClient, startTestServer, type TestServer } from "./helpers/server-harness.js";

let server: TestServer;

afterEach(async () => {
  await server?.close();
});

describe("expired or revoked credentials", () => {
  it("an expired cookie is treated as no cookie at all — a fresh identity is minted, not an error", async () => {
    server = await startTestServer({ roomCode: "TEST" });
    const secret = loadOrCreateSessionSecret(server.db);
    const oldId = "99999999-9999-9999-9999-999999999999";
    const expiredCookie = `ls_id=${mintCookieValue(secret, oldId, Date.now() - 31 * 24 * 60 * 60 * 1000)}`;

    const client = new TestClient(server.wsUrl, expiredCookie);
    const result = await client.join("Alice", "TEST");

    expect(result.type).toBe("room.joined");
    expect(result.playerId).not.toBe(oldId); // the expired identity is not reused
    client.close();
  });

  it("a tampered cookie is rejected as an identity and a fresh one is minted instead of trusting it", async () => {
    server = await startTestServer({ roomCode: "TEST" });
    const secret = loadOrCreateSessionSecret(server.db);
    const realId = "88888888-8888-8888-8888-888888888888";
    const validCookie = mintCookieValue(secret, realId);
    const tampered = `ls_id=${validCookie.slice(0, -4)}0000`;

    const client = new TestClient(server.wsUrl, tampered);
    const result = await client.join("Mallory", "TEST");

    expect(result.type).toBe("room.joined");
    expect(result.playerId).not.toBe(realId);
    client.close();
  });

  it("a revoked player's otherwise-valid cookie is not trusted — a fresh identity is minted instead", async () => {
    server = await startTestServer({ roomCode: "TEST" });
    const secret = loadOrCreateSessionSecret(server.db);
    const revokedId = "77777777-7777-7777-7777-777777777777";
    touchPlayerRecord(server.db, revokedId, "Revoked");
    revokePlayerRecord(server.db, revokedId);
    const cookie = `ls_id=${mintCookieValue(secret, revokedId)}`;

    const client = new TestClient(server.wsUrl, cookie);
    const result = await client.join("StillRevoked", "TEST");

    expect(result.type).toBe("room.joined");
    expect(result.playerId).not.toBe(revokedId);
    client.close();
  });
});
