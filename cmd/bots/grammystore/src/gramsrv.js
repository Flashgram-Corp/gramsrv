import { createHash, randomUUID } from "node:crypto";

function buildGramsrvError(route, status, text) {
  let errorText = text;
  let code = "";
  try {
    const body = JSON.parse(text);
    if (body && typeof body === "object") {
      errorText = body.error || body.message || text;
      if (body.code) {
        code = String(body.code);
      } else {
        const match = /^([A-Z][A-Z0-9_]*): /.exec(String(errorText));
        if (match) code = match[1];
      }
    }
  } catch {
    // non-JSON body; keep the raw text
  }
  const error = new Error(`gramsrv ${route} ${status}: ${errorText}`);
  error.code = code;
  return error;
}

export class GramsrvClient {
  constructor(config) { this.config = config; }

  async post(route, payload) {
    const response = await fetch(`${this.config.gramsrvAPI}${route}`, {
      method: "POST",
      headers: { authorization: `Bearer ${this.config.gramsrvToken}`, "content-type": "application/json" },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(15_000),
    });
    const text = await response.text();
    if (!response.ok) throw buildGramsrvError(route, response.status, text);
    return text ? JSON.parse(text) : {};
  }

  // Read-only administrator audit. Returns the newest admin command journal
  // entries; actor filters to one administrator's own actions.
  async get(route, params = {}) {
    const url = new URL(`${this.config.gramsrvAPI}${route}`);
    for (const [key, value] of Object.entries(params)) {
      if (value !== undefined && value !== null && value !== "") url.searchParams.set(key, String(value));
    }
    const response = await fetch(url, {
      method: "GET",
      headers: { authorization: `Bearer ${this.config.gramsrvToken}` },
      signal: AbortSignal.timeout(15_000),
    });
    const text = await response.text();
    if (!response.ok) throw buildGramsrvError(route, response.status, text);
    return text ? JSON.parse(text) : {};
  }

  async adminCommands(limit = 30, actor = "") {
    const body = await this.get("/v1/admin-commands", { limit, actor });
    return Array.isArray(body) ? body : body?.commands ?? [];
  }

  command(reason, fields, idempotencyKey = "", actor = "") {
    const digest = idempotencyKey ? createHash("sha256").update(idempotencyKey).digest("hex").slice(0, 40) : randomUUID();
    return { command_id: `bot-${digest}`, actor: actor || this.config.gramsrvActor, reason, dry_run: false, ...fields };
  }

  grantStars(userID, amount, reason = "Telegram bot purchase", idempotencyKey = "", dryRun = false, actor = "") {
    const payload = this.command(reason, { user_id: userID, amount }, idempotencyKey, actor);
    if (dryRun) payload.dry_run = true;
    return this.post("/v1/accounts/grant-stars", payload);
  }

  debitStars(userID, amount, reason = "Telegram bot refund", idempotencyKey = "", dryRun = false, actor = "") {
    const payload = this.command(reason, { user_id: userID, amount }, idempotencyKey, actor);
    if (dryRun) payload.dry_run = true;
    return this.post("/v1/accounts/debit-stars", payload);
  }

  setPhone(userID, phone, reason = "Telegram bot number purchase", idempotencyKey = "", dryRun = false, actor = "") {
    const payload = this.command(reason, { user_id: userID, phone }, idempotencyKey, actor);
    if (dryRun) payload.dry_run = true;
    return this.post("/v1/accounts/set-phone", payload);
  }

  async resolveUserByPhone(phone) {
    const result = await this.post("/v1/accounts/resolve-by-phone", { phone });
    if (result?.found === false && result.user_id === 0) return 0;
    const id = Number(result?.user_id);
    if (result?.found === true && Number.isSafeInteger(id) && id > 0) return id;
    throw new Error("invalid account lookup response");
  }

  grantPremium(userID, months, reason = "Telegram bot purchase", idempotencyKey = "", dryRun = false, actor = "") {
    const payload = this.command(reason, { user_id: userID, months }, idempotencyKey, actor);
    if (dryRun) payload.dry_run = true;
    return this.post("/v1/accounts/grant-premium", payload);
  }

  revokePremium(userID, entitlementID, reason = "Telegram bot refund", idempotencyKey = "", actor = "") {
    return this.post("/v1/accounts/grant-premium", this.command(reason, { user_id: userID, months: 0, entitlement_id: entitlementID }, idempotencyKey, actor));
  }

  setVerified(userID, verified, reason = "Telegram bot moderation", idempotencyKey = "", dryRun = false, actor = "") {
    const payload = this.command(reason, { user_id: userID, verified }, idempotencyKey, actor);
    if (dryRun) payload.dry_run = true;
    return this.post("/v1/accounts/set-verified", payload);
  }

  setFrozen(userID, frozen, reason = "Telegram bot moderation", idempotencyKey = "", dryRun = false, actor = "") {
    const payload = this.command(reason, { user_id: userID, frozen }, idempotencyKey, actor);
    if (dryRun) payload.dry_run = true;
    return this.post("/v1/accounts/set-frozen", payload);
  }

  setFlags(userID, scam, fake, reason = "Telegram bot moderation", idempotencyKey = "", dryRun = false, actor = "") {
    const payload = this.command(reason, { user_id: userID, scam, fake }, idempotencyKey, actor);
    if (dryRun) payload.dry_run = true;
    return this.post("/v1/accounts/set-flags", payload);
  }

  mintUsername(userID, username, bidTON, idempotencyKey = "", dryRun = false, actor = "") {
    const amount = bidTON > 0 ? (BigInt(bidTON) * 1_000_000_000n).toString() : "0";
    const payload = this.command("Telegram bot purchase", {
      username,
      owner_user_id: String(userID),
      currency: "TON",
      amount,
      crypto_currency: bidTON > 0 ? "TON" : "",
      crypto_amount: bidTON > 0 ? amount : "0",
      url: `${this.config.publicBaseURL}/nft/username/${username}`,
      purchase_date: Math.floor(Date.now() / 1000),
    }, idempotencyKey, actor);
    if (dryRun) payload.dry_run = true;
    return this.post("/v1/collectible-usernames/mint", payload);
  }
  mintPhone(userID, phone, idempotencyKey = "", dryRun = false, actor = "") {
    const payload = this.command("Telegram bot purchase", {
      phone,
      tier: "standard",
      owner_user_id: String(userID),
      currency: "USD",
      amount: "100",
      crypto_currency: "TON",
      crypto_amount: "1000000000",
      url: `${this.config.publicBaseURL}/nft/phone/${phone}`,
      purchase_date: Math.floor(Date.now() / 1000),
    }, idempotencyKey, actor);
    if (dryRun) payload.dry_run = true;
    return this.post("/v1/collectible-phones/mint", payload);
  }
  revokeUsername(username, expectedOwnerUserID, idempotencyKey = "", dryRun = false, actor = "") {
    const payload = this.command("Telegram bot refund", {
      username,
      expected_owner_user_id: String(expectedOwnerUserID),
      burn: false,
    }, idempotencyKey, actor);
    if (dryRun) payload.dry_run = true;
    return this.post("/v1/collectible-usernames/revoke", payload);
  }
}