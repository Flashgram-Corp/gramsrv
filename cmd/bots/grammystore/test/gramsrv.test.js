import test from "node:test";
import assert from "node:assert/strict";
import { GramsrvClient } from "../src/gramsrv.js";

test("Admin API retries reuse a deterministic command id", () => {
  const client = new GramsrvClient({ gramsrvActor: "test" });
  const first = client.command("purchase", { user_id: 1 }, "payment:charge-1");
  const retry = client.command("purchase", { user_id: 1 }, "payment:charge-1");
  const other = client.command("purchase", { user_id: 1 }, "payment:charge-2");
  assert.equal(first.command_id, retry.command_id);
  assert.notEqual(first.command_id, other.command_id);
});

test("resolveUserByPhone forwards the phone and returns the numeric user id", async () => {
  const client = new GramsrvClient({ gramsrvActor: "test" });
  client.post = async (route, payload) => {
    assert.equal(route, "/v1/accounts/resolve-by-phone");
    assert.deepEqual(payload, { phone: "+79991234567" });
    return { found: true, user_id: 1780243207 };
  };
  assert.equal(await client.resolveUserByPhone("+79991234567"), 1780243207);
});

test("resolveUserByPhone returns 0 when the account is missing", async () => {
  const client = new GramsrvClient({ gramsrvActor: "test" });
  client.post = async () => ({ found: false, user_id: 0 });
  assert.equal(await client.resolveUserByPhone("+79990000000"), 0);
});

test("admin grant mints a zero-price username with a dry-run flag and a deterministic key", async () => {
  const client = new GramsrvClient({ gramsrvActor: "test", publicBaseURL: "https://example.com" });
  const calls = [];
  client.post = async (route, payload) => { calls.push({ route, payload }); return {}; };
  await client.mintUsername(10, "@durov", 0, "admin:grant:10:durov", true);
  await client.mintUsername(10, "durov", 0, "admin:grant:10:durov");
  assert.equal(calls.length, 2);
  assert.equal(calls[0].route, "/v1/collectible-usernames/mint");
  const dry = calls[0].payload;
  assert.equal(dry.dry_run, true);
  assert.equal(dry.owner_user_id, "10");
  assert.equal(dry.amount, "0");
  assert.equal(dry.crypto_currency, "");
  assert.equal(dry.crypto_amount, "0");
  assert.equal(dry.command_id, calls[1].payload.command_id, "dry-run and real mint share the idempotency key");
  assert.equal(calls[1].payload.dry_run, false);
});

test("a paid purchase still bills the crypto amount like a sale", async () => {
  const client = new GramsrvClient({ gramsrvActor: "test", publicBaseURL: "https://example.com" });
  let payload;
  client.post = async (route, body) => { payload = body; return {}; };
  await client.mintUsername(42, "durov", 10, "payment:charge-1");
  assert.equal(payload.amount, (10n * 1_000_000_000n).toString());
  assert.equal(payload.crypto_currency, "TON");
  assert.equal(payload.crypto_amount, payload.amount);
  assert.equal(payload.dry_run, false);
});

test("mintPhone mints a standard-tier collectible phone with a nominal positive price", async () => {
  const client = new GramsrvClient({ gramsrvActor: "test", publicBaseURL: "https://example.com" });
  const calls = [];
  client.post = async (route, payload) => { calls.push({ route, payload }); return {}; };
  await client.mintPhone(10, "+88881234567", "admin:grant:10:phone", true);
  await client.mintPhone(10, "+88881234567", "admin:grant:10:phone");
  assert.equal(calls.length, 2);
  assert.equal(calls[0].route, "/v1/collectible-phones/mint");
  const dry = calls[0].payload;
  assert.equal(dry.dry_run, true);
  assert.equal(dry.phone, "+88881234567");
  assert.equal(dry.owner_user_id, "10");
  assert.equal(dry.tier, "standard");
  assert.equal(dry.currency, "USD");
  assert.equal(dry.amount, "100");
  assert.equal(dry.crypto_currency, "TON");
  assert.equal(dry.crypto_amount, "1000000000");
  assert.equal(dry.url, "https://example.com/nft/phone/+88881234567");
  assert.equal(dry.command_id, calls[1].payload.command_id, "dry-run and real mint share the idempotency key");
  assert.equal(calls[1].payload.dry_run, false);
});

test("setVerified posts the flags and command metadata and forwards the actor", async () => {
  const client = new GramsrvClient({ gramsrvActor: "test" });
  const calls = [];
  client.post = async (route, body) => { calls.push({ route, body }); return {}; };
  await client.setVerified(10, true, "Admin moderation", "", true, "777");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].route, "/v1/accounts/set-verified");
  assert.deepEqual(calls[0].body, {
    user_id: 10, verified: true,
    command_id: calls[0].body.command_id, reason: "Admin moderation", dry_run: true, actor: "777",
  });
});

test("setFrozen posts frozen state and dry-run metadata", async () => {
  const client = new GramsrvClient({ gramsrvActor: "test" });
  const calls = [];
  client.post = async (route, body) => { calls.push({ route, body }); return {}; };
  await client.setFrozen(10, false, "Admin moderation", "admin:freeze:10:1", false, "777");
  assert.equal(calls[0].route, "/v1/accounts/set-frozen");
  const second = client.command("Admin moderation", { user_id: 10, frozen: false }, "admin:freeze:10:1");
  assert.deepEqual(calls[0].body, {
    user_id: 10, frozen: false,
    command_id: second.command_id, reason: "Admin moderation", dry_run: false, actor: "777",
  });
});

test("setFlags posts scam and fake flags", async () => {
  const client = new GramsrvClient({ gramsrvActor: "test" });
  let body;
  client.post = async (route, payload) => { body = payload; return {}; };
  await client.setFlags(10, true, false, "Admin moderation", "", true, "777");
  assert.deepEqual(body, {
    user_id: 10, scam: true, fake: false,
    command_id: body.command_id, reason: "Admin moderation", dry_run: true, actor: "777",
  });
});

test("actor defaults to the configured gramsrv actor when omitted", async () => {
  const client = new GramsrvClient({ gramsrvActor: "bot-service" });
  let body;
  client.post = async (route, payload) => { body = payload; return {}; };
  await client.setVerified(10, true, "Admin moderation", "", true);
  assert.equal(body.actor, "bot-service");
});

test("post() surfaces the error text without truncating details", async () => {
  const client = new GramsrvClient({ gramsrvAPI: "https://api.example.com", gramsrvToken: "t" });
  const body = {
    command_id: "bot-123", status: "failed", dry_run: true,
    details: { note: "x".repeat(600) },
    error: "USERNAME_OCCUPIED: username occupied",
  };
  const saved = globalThis.fetch;
  try {
    globalThis.fetch = async () => ({ ok: false, status: 400, text: async () => JSON.stringify(body) });
    const err = await client.post("/v1/collectible-usernames/mint", {}).then(() => null, (e) => e);
    assert.ok(err instanceof Error, "post rejects on 400");
    assert.match(err.message, /username occupied/, "the error text is preserved in the message");
    assert.equal(err.code, "USERNAME_OCCUPIED", "the stable code is parsed");
  } finally {
    globalThis.fetch = saved;
  }
});

test("post() falls back to body.code when the error text lacks a prefix", async () => {
  const client = new GramsrvClient({ gramsrvAPI: "https://api.example.com", gramsrvToken: "t" });
  const body = { error: "not found", code: "COLLECTIBLE_NOT_FOUND" };
  const saved = globalThis.fetch;
  try {
    globalThis.fetch = async () => ({ ok: false, status: 404, text: async () => JSON.stringify(body) });
    const err = await client.post("/v1/x", {}).then(() => null, (e) => e);
    assert.equal(err.code, "COLLECTIBLE_NOT_FOUND");
  } finally {
    globalThis.fetch = saved;
  }
});
