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
