import test from "node:test";
import assert from "node:assert/strict";
import { buildPayload, catalog, findProduct, localizeProduct, normalizeUsername, parsePayload, productsOfKind } from "../src/catalog.js";

test("invoice payload round-trips unicode extras and a Stars snapshot", () => {
  assert.deepEqual(parsePayload(buildPayload("uname_10", 123, "юзер_name")), { code: "uname_10", targetUserID: 123, extra: "юзер_name", starsAmount: 0 });
  assert.deepEqual(parsePayload(buildPayload("stars_1", 456, "", 20)), { code: "stars_1", targetUserID: 456, extra: "", starsAmount: 20 });
  assert.deepEqual(parsePayload("store|stars_1|456|"), { code: "stars_1", targetUserID: 456, extra: "", starsAmount: 0 });
});

test("dynamic Stars products use configured rate", () => {
  assert.equal(findProduct("stars_25", 30).starsAmount, 750);
});

test("arbitrary Stars invoices are bounded and use the configured rate", () => {
  assert.equal(findProduct("stars_37", 25).starsAmount, 925);
  assert.equal(findProduct("stars_100000", 25).starsAmount, 2_500_000);
  assert.equal(findProduct("stars_100001", 25), null);
  assert.equal(findProduct("stars_0", 25), null);
});

test("collectible username validation is canonical", () => {
  assert.equal(normalizeUsername(" @Valid_Name "), "valid_name");
  assert.equal(normalizeUsername("1bad"), "");
  assert.equal(normalizeUsername("abcd"), "", "shop usernames still require 5+ characters");
  assert.equal(normalizeUsername("abcd", 4), "abcd", "admin grants may use 4-character usernames");
  assert.equal(normalizeUsername("abc", 4), "");
  assert.equal(normalizeUsername("4abc", 4), "");
  assert.equal(normalizeUsername("@A1b2_C3d4", 4), "a1b2_c3d4");
});

test("fixed and dynamic products expose both supported locales", () => {
  assert.equal(localizeProduct(findProduct("premium_3m"), "ru").title, "Premium — 3 месяца");
  assert.equal(localizeProduct(findProduct("stars_37", 25), "ru").description, "925 серверных Stars за 37 Telegram Stars");
  assert.equal(localizeProduct(findProduct("stars_37", 25), "en").description, "925 server Stars for 37 Telegram Stars");
});

test("price overrides replace fixed product prices and never touch dynamic Stars packages", () => {
  const prices = { premium_1m: 30, premium_3m: 55, num_short: 15 };
  assert.equal(findProduct("premium_1m", 20, prices).starsPrice, 30);
  assert.equal(findProduct("premium_3m", 20, prices).starsPrice, 55);
  assert.equal(findProduct("num_short", 20, prices).starsPrice, 15);
  assert.equal(findProduct("uname_10", 20, prices).starsPrice, 10);
  assert.equal(findProduct("stars_25", 20, prices).starsPrice, 25);
  assert.equal(findProduct("premium_1m", 20).starsPrice, 20);
  assert.ok(productsOfKind("premium", 20, prices).every((p) => p.kind === "premium"));
  assert.equal(catalog(20, prices).length, catalog(20).length);
});
