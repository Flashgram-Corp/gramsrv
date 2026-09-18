import pg from "pg";
import { randomInt, randomBytes } from "node:crypto";

const RU_CODES = ["900", "902", "903", "904", "905", "906", "908", "909", "910", "911", "912", "913", "914", "915", "916", "917", "918", "919", "920", "921", "922", "923", "925", "926", "927", "928", "929", "930", "931", "932", "933", "937", "938", "939", "950", "951", "952", "953", "960", "961", "962", "963", "964", "965", "966", "967", "968", "969", "980", "981", "982", "983", "984", "985", "986", "987", "988", "989", "999"];
const US_CODES = ["212", "213", "214", "215", "224", "281", "305", "310", "312", "313", "323", "347", "404", "407", "408", "410", "412", "415", "425", "469", "501", "503", "504", "505", "512", "513", "516", "561", "602", "603", "605", "612", "614", "615", "617", "619", "623", "702", "703", "704", "706", "708", "713", "714", "718", "720", "801", "802", "804", "805", "808", "813", "815", "816", "818", "901", "903", "904", "907", "909", "913", "914", "916", "917", "919"];

function now() { return Math.floor(Date.now() / 1000); }
function dayKey(date = new Date()) { return date.toISOString().slice(0, 10); }
function weekKey(date = new Date()) {
  const value = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  value.setUTCDate(value.getUTCDate() + 4 - (value.getUTCDay() || 7));
  const start = new Date(Date.UTC(value.getUTCFullYear(), 0, 1));
  return `${value.getUTCFullYear()}-W${String(Math.ceil((((value - start) / 86400000) + 1) / 7)).padStart(2, "0")}`;
}
function pick(values) { return values[randomInt(values.length)]; }
function digits(count) { return Array.from({ length: count }, () => randomInt(10)).join(""); }
function normalizePhone(value) { const raw = String(value ?? "").replace(/[\s()\-]/g, ""); return raw && !raw.startsWith("+") ? `+${raw}` : raw; }

function generatedNumber(format, country) {
  if (format === "short") {
    const tail = digits(3); return { phone: `+8888${tail}`, display: `+888 8 ${tail}`, country: "ANON" };
  }
  if (format === "long") {
    const tail = digits(7); return { phone: `+8880${tail}`, display: `+888 0${tail.slice(0, 3)} ${tail.slice(3)}`, country: "ANON" };
  }
  if (country === "US") {
    const area = pick(US_CODES); const exchange = `${randomInt(2, 10)}${digits(2)}`; const line = digits(4);
    return { phone: `+1${area}${exchange}${line}`, display: `+1 (${area}) ${exchange}-${line}`, country: "US" };
  }
  const code = pick(RU_CODES); const tail = digits(7);
  return { phone: `+7${code}${tail}`, display: `+7 ${code} ${tail.slice(0, 3)}-${tail.slice(3, 5)}-${tail.slice(5)}`, country: "RU" };
}

function formatForPhone(phone) {
  if (/^\+8888\d{3}$/.test(phone)) return { format: "short", country: "ANON" };
  if (/^\+8880\d{7}$/.test(phone)) return { format: "long", country: "ANON" };
  if (phone.startsWith("+1")) return { format: "free", country: "US" };
  return { format: "free", country: "RU" };
}

function displayForPhone(phone, format, country) {
  if (format === "short") return `+888 8 ${phone.slice(5)}`;
  if (format === "long") { const tail = phone.slice(5); return `+888 0${tail.slice(0, 3)} ${tail.slice(3)}`; }
  if (format === "free" && country === "US") {
    const match = phone.match(/^\+1(\d{3})(\d{3})(\d{4})$/);
    if (match) return `+1 (${match[1]}) ${match[2]}-${match[3]}`;
  }
  if (format === "free" && country === "RU") {
    const match = phone.match(/^\+7(\d{3})(\d{7})$/);
    if (match) return `+7 ${match[1]} ${match[2].slice(0, 3)}-${match[2].slice(3, 5)}-${match[2].slice(5)}`;
  }
  return phone;
}

export class BotDatabase {
  constructor(dbUrl, { generateNumber = generatedNumber } = {}) {
    this.pool = new pg.Pool({ connectionString: dbUrl, max: 10, idleTimeoutMillis: 30000, connectionTimeoutMillis: 10000 });
    this.generateNumber = generateNumber;
    pg.types.setTypeParser(20, (val) => Number(val));
  }

  async close() { await this.pool.end(); }

  async tx(work) {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const value = await work(client);
      await client.query("COMMIT");
      return value;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async upsertUser(from, chatID, language = "ru", referrerID = 0, referralBonus = 0) {
    return this.tx(async (client) => {
      const existing = (await client.query("SELECT * FROM users WHERE telegram_id = $1", [from.id])).rows[0] ?? null;
      await client.query(
        `INSERT INTO users(telegram_id, chat_id, username, first_name, language, created_at, updated_at)
         VALUES($1, $2, $3, $4, $5, $6, $7)
         ON CONFLICT(telegram_id) DO UPDATE SET chat_id = EXCLUDED.chat_id, username = EXCLUDED.username,
         first_name = EXCLUDED.first_name, updated_at = EXCLUDED.updated_at`,
        [from.id, chatID, from.username ?? "", from.first_name ?? "", language, now(), now()]
      );
      if (!existing && referrerID > 0 && referrerID !== from.id) {
        const referrer = (await client.query("SELECT telegram_id FROM users WHERE telegram_id = $1", [referrerID])).rows[0];
        if (referrer) {
          await client.query("UPDATE users SET referred_by = $1 WHERE telegram_id = $2 AND referred_by IS NULL", [referrerID, from.id]);
          await client.query("UPDATE users SET referral_count = referral_count + 1, bonus = bonus + $1, updated_at = $2 WHERE telegram_id = $3", [referralBonus, now(), referrerID]);
        }
      }
      return (await client.query("SELECT * FROM users WHERE telegram_id = $1", [from.id])).rows[0];
    });
  }

  async user(id) {
    const telegramID = Number(id);
    if (!Number.isSafeInteger(telegramID) || telegramID <= 0) return null;
    const res = await this.pool.query("SELECT * FROM users WHERE telegram_id = $1", [telegramID]);
    return res.rows[0] ?? null;
  }

  async userByChatID(chatID) {
    const res = await this.pool.query("SELECT * FROM users WHERE chat_id = $1 ORDER BY updated_at DESC LIMIT 1", [chatID]);
    return res.rows[0] ?? null;
  }

  async users() {
    const res = await this.pool.query("SELECT * FROM users ORDER BY created_at");
    return res.rows;
  }

  async notificationRecipients(ttlDays = 30) {
    const threshold = now() - Math.max(1, ttlDays) * 86400;
    const res = await this.pool.query("SELECT * FROM users WHERE notifications = 1 AND updated_at >= $1 ORDER BY created_at", [threshold]);
    return res.rows;
  }

  async stats() {
    const [users, numbers, sales] = await Promise.all([
      this.pool.query("SELECT count(*)::int n FROM users"),
      this.pool.query("SELECT count(*)::int n FROM numbers"),
      this.pool.query("SELECT count(*)::int n FROM sales"),
    ]);
    return { users: users.rows[0].n, numbers: numbers.rows[0].n, sales: sales.rows[0].n };
  }

  async setLanguage(id, language) {
    await this.pool.query("UPDATE users SET language = $1, updated_at = $2 WHERE telegram_id = $3", [language, now(), id]);
  }

  async toggleNotifications(id) {
    const res = await this.pool.query("UPDATE users SET notifications = 1 - notifications, updated_at = $1 WHERE telegram_id = $2 RETURNING notifications", [now(), id]);
    return Boolean(res.rows[0]?.notifications);
  }

  async setServerUserID(id, serverUserID) {
    try {
      await this.pool.query("UPDATE users SET server_user_id = $1, updated_at = $2 WHERE telegram_id = $3", [serverUserID, now(), id]);
    } catch (error) {
      if (error.code === "23505" && serverUserID > 0) throw new Error("this server user ID is already bound to another Telegram account");
      throw error;
    }
  }

  async addBonus(id, amount) {
    if (!Number.isSafeInteger(amount)) throw new Error("invalid bonus amount");
    const res = await this.pool.query("UPDATE users SET bonus = GREATEST(0, bonus + $1), updated_at = $2 WHERE telegram_id = $3 RETURNING bonus", [amount, now(), id]);
    if (!res.rowCount) throw new Error("invalid Telegram ID");
    return res.rows[0].bonus;
  }

  async claimDaily(id, amount) {
    return this.tx(async (client) => {
      const user = (await client.query("SELECT * FROM users WHERE telegram_id = $1", [id])).rows[0];
      if (!user) throw new Error("user not found");
      const day = dayKey();
      if (user.daily_day === day) return { claimed: false, balance: user.bonus };
      await client.query("UPDATE users SET daily_day = $1, bonus = bonus + $2, updated_at = $3 WHERE telegram_id = $4", [day, amount, now(), id]);
      return { claimed: true, balance: user.bonus + amount };
    });
  }

  async createNumber(ownerID, chatID, format = "free", country = "RU", replace = false) {
    return this.tx((client) => this.createNumberInTransaction(client, ownerID, chatID, format, country, replace));
  }

  async createNumberInTransaction(client, ownerID, chatID, format, country, replace, allowReplaceAnonymous = false) {
    // Serialize allocations for one owner, including the first allocation.
    const owner = await client.query("SELECT telegram_id FROM users WHERE telegram_id = $1 FOR UPDATE", [ownerID]);
    if (!owner.rowCount) throw new Error("user not found");
    const current = (await client.query("SELECT * FROM numbers WHERE owner_id = $1 AND is_current = TRUE", [ownerID])).rows[0] ?? null;
    if (current && !replace) return current;
    if (current && current.format !== "free" && (!allowReplaceAnonymous || format === "free")) throw new Error("account already has an active anonymous number");
    // Daily free-number change limit: an admin-configured count of free
    // allocations per UTC day. The counter is user-scoped because re-rolls
    // release the previous free number, so counting number rows would undercount.
    let dailyFree = null;
    if (format === "free") {
      const limit = await this.freeNumberDailyLimit();
      if (limit > 0) {
        const day = dayKey();
        const me = (await client.query("SELECT free_day, free_day_count FROM users WHERE telegram_id = $1", [ownerID])).rows[0] ?? null;
        const count = me && me.free_day === day ? me.free_day_count : 0;
        if (count >= limit) throw new Error("free number daily limit reached");
        dailyFree = { day, count: count + 1 };
      }
    }
    if (current) {
      if (current.format !== "free") {
        // A repeat +888 purchase replaces the previous +888, which is retired
        // forever (never recycled) instead of being released to the pool.
        await client.query("UPDATE numbers SET is_current = FALSE, retired = TRUE WHERE id = $1", [current.id]);
      } else {
        // The previous number is released to the pool when the replacement
        // commits (see the DELETE below); the demote keeps the unique
        // one-current-per-owner index consistent inside the transaction.
        await client.query("UPDATE numbers SET is_current = FALSE WHERE id = $1", [current.id]);
      }
    }
    for (let attempt = 0; attempt < 400; attempt++) {
      const generated = this.generateNumber(format, country);
      // Only phone collisions are retryable. A caught PostgreSQL unique
      // violation would abort the transaction and poison the next attempt.
      const result = await client.query(
        `INSERT INTO numbers(phone, display, format, country, owner_id, chat_id, is_current, login_code, code_expires_at, created_at)
         VALUES($1, $2, $3, $4, $5, $6, TRUE, '', 0, $7)
         ON CONFLICT(phone) DO NOTHING RETURNING *`,
        [generated.phone, generated.display, format, generated.country, ownerID, chatID, now()]
      );
      if (result.rowCount) {
        if (dailyFree) {
          await client.query(
            "UPDATE users SET free_day = $1, free_day_count = $2, updated_at = $3 WHERE telegram_id = $4",
            [dailyFree.day, dailyFree.count, now(), ownerID]
          );
        }
        // Enforce a single active number per owner: any previously owned free
        // numbers (reserved by earlier re-rolls or the free allocation) are
        // released to the pool. Runs after the insert so failed allocations
        // roll back the whole replacement and preserve the previous number.
        await client.query("DELETE FROM numbers WHERE owner_id = $1 AND format = 'free' AND id <> $2", [ownerID, result.rows[0].id]);
        return result.rows[0];
      }
    }
    throw new Error("could not generate a unique number");
  }

  async currentNumber(ownerID) {
    const res = await this.pool.query("SELECT * FROM numbers WHERE owner_id = $1 AND is_current = TRUE", [ownerID]);
    return res.rows[0] ?? null;
  }

  async numbers(ownerID) {
    const res = await this.pool.query("SELECT * FROM numbers WHERE owner_id = $1 AND retired = FALSE ORDER BY id DESC", [ownerID]);
    return res.rows;
  }

  async findNumber(phone) {
    const res = await this.pool.query("SELECT * FROM numbers WHERE phone = $1 AND retired = FALSE", [normalizePhone(phone)]);
    return res.rows[0] ?? null;
  }

  async findNumberByPhone(phone) {
    return this.findNumber(phone);
  }

  async updateLoginCode(phone, code, expiresAt = now() + 300) {
    phone = normalizePhone(phone);
    return this.tx(async (client) => {
      const locked = (await client.query("SELECT * FROM numbers WHERE phone = $1 FOR UPDATE", [phone])).rows[0];
      if (locked?.retired) throw new Error("NUMBER_RETIRED");
      await client.query("UPDATE numbers SET login_code = $1, code_expires_at = GREATEST(code_expires_at, $2) WHERE phone = $3", [String(code), expiresAt, phone]);
      const number = (await client.query("SELECT * FROM numbers WHERE phone = $1", [phone])).rows[0] ?? null;
      const access = (await client.query(
        "SELECT u.chat_id FROM code_access a JOIN users u ON u.telegram_id = a.telegram_id WHERE a.phone = $1", [phone]
      )).rows;
      const chatIDs = new Set(access.map((row) => row.chat_id));
      if (number?.chat_id) chatIDs.add(number.chat_id);
      const verified = (await client.query("SELECT chat_id FROM verified_phones WHERE phone = $1", [phone])).rows;
      for (const row of verified) chatIDs.add(row.chat_id);
      return { number, chatIDs: [...chatIDs] };
    });
  }

  async acceptLoginCodeDelivery(deliveryID, fingerprint, phone, code, expiresAt) {
    phone = normalizePhone(phone);
    return this.tx(async (client) => {
      // Same lock as refund retirement: no code can be accepted between the
      // expiry/remote-account checks and retirement. Duplicate IDs serialize too.
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [`otp:${deliveryID}`]);
      const locked = (await client.query("SELECT * FROM numbers WHERE phone = $1 FOR UPDATE", [phone])).rows[0];
      if (locked?.retired) throw new Error("NUMBER_RETIRED");
      const existing = (await client.query("SELECT * FROM otp_deliveries WHERE delivery_id = $1", [deliveryID])).rows[0];
      if (existing) {
        if (existing.fingerprint !== fingerprint) throw new Error("IDEMPOTENCY_CONFLICT");
        const number = (await client.query("SELECT * FROM numbers WHERE phone = $1 AND retired = FALSE", [existing.recipient])).rows[0] ?? null;
        return { duplicate: true, number, chatIDs: [] };
      }
      await client.query(
        "INSERT INTO otp_deliveries(delivery_id, fingerprint, recipient, code, expires_at, accepted_at) VALUES($1, $2, $3, $4, $5, $6)",
        [deliveryID, fingerprint, phone, String(code), expiresAt, now()]
      );
      await client.query("UPDATE numbers SET login_code = $1, code_expires_at = GREATEST(code_expires_at, $2) WHERE phone = $3", [String(code), expiresAt, phone]);
      const number = (await client.query("SELECT * FROM numbers WHERE phone = $1", [phone])).rows[0] ?? null;
      const access = (await client.query(
        "SELECT u.chat_id FROM code_access a JOIN users u ON u.telegram_id = a.telegram_id WHERE a.phone = $1", [phone]
      )).rows;
      const chatIDs = new Set(access.map((row) => row.chat_id));
      if (number?.chat_id) chatIDs.add(number.chat_id);
      const verified = (await client.query("SELECT chat_id FROM verified_phones WHERE phone = $1", [phone])).rows;
      for (const row of verified) chatIDs.add(row.chat_id);
      return { duplicate: false, number, chatIDs: [...chatIDs] };
    });
  }

  async grantCodeAccess(phone, telegramID) {
    await this.pool.query("INSERT INTO code_access(phone, telegram_id) VALUES($1, $2) ON CONFLICT DO NOTHING", [normalizePhone(phone), telegramID]);
  }

  async revokePurchasedNumber(ownerID, numberID, phone, resolveUserByPhone) {
    if (typeof resolveUserByPhone !== "function") throw new Error("account lookup is required for number refunds");
    return this.tx(async (client) => {
      const user = (await client.query("SELECT telegram_id, chat_id FROM users WHERE telegram_id = $1 FOR UPDATE", [ownerID])).rows[0];
      if (!user) throw new Error("owner not found");
      const number = (await client.query("SELECT * FROM numbers WHERE id = $1 AND owner_id = $2 AND phone = $3 FOR UPDATE", [numberID, ownerID, normalizePhone(phone)])).rows[0];
      if (!number) throw new Error("purchased number not found");
      if (number.retired) return false;
      if (number.format === "free") throw new Error("the free number cannot be refunded");
      if (number.code_expires_at > now()) throw new Error("number has unexpired verification codes; retry after they expire");
      // A bounded read-only Admin API call while holding the number lock. A
      // failure or an existing account keeps the original OTP route untouched.
      if (await resolveUserByPhone(number.phone) !== 0) throw new Error("number is still bound; change it in the signed-in client before refunding");
      await client.query("DELETE FROM code_access WHERE phone = $1", [number.phone]);
      await client.query("UPDATE numbers SET retired = TRUE, is_current = FALSE, login_code = '', code_expires_at = 0 WHERE id = $1", [number.id]);
      if (number.is_current) {
        const restored = await client.query("UPDATE numbers SET is_current = TRUE WHERE id = (SELECT id FROM numbers WHERE owner_id = $1 AND format = 'free' AND retired = FALSE ORDER BY id DESC LIMIT 1) RETURNING id", [ownerID]);
        if (restored.rowCount === 0) await this.createNumberInTransaction(client, ownerID, user.chat_id, "free", "RU", false);
      }
      return true;
    });
  }

  async duplicateNumberOwners() {
    const res = await this.pool.query(
      `SELECT owner_id FROM numbers WHERE retired = FALSE
       GROUP BY owner_id
       HAVING count(*) > 1`
    );
    return res.rows.map((row) => row.owner_id);
  }

  async cleanupDuplicateNumbers(ownerID, keepID) {
    return this.tx(async (client) => {
      await client.query("SELECT telegram_id FROM users WHERE telegram_id = $1 FOR UPDATE", [ownerID]);
      const owned = (await client.query("SELECT * FROM numbers WHERE owner_id = $1 AND retired = FALSE", [ownerID])).rows;
      const keep = owned.find((number) => number.id === keepID) ?? owned.find((number) => number.is_current) ?? null;
      if (!keep) return { removed: 0, retired: 0, keptPhone: null };
      let removed = 0, retired = 0;
      for (const number of owned) {
        if (number.id === keep.id) continue;
        if (number.format === "free") {
          await client.query("DELETE FROM numbers WHERE id = $1", [number.id]);
          removed++;
        } else {
          await client.query("UPDATE numbers SET is_current = FALSE, retired = TRUE WHERE id = $1", [number.id]);
          retired++;
        }
      }
      if (!keep.is_current) await client.query("UPDATE numbers SET is_current = TRUE WHERE id = $1", [keep.id]);
      return { removed, retired, keptPhone: keep.phone };
    });
  }

  async getSetting(key, fallback = "") {
    const res = await this.pool.query("SELECT value FROM settings WHERE key = $1", [key]);
    return res.rows[0]?.value ?? fallback;
  }

  async setSetting(key, value) {
    await this.pool.query("INSERT INTO settings(key, value) VALUES($1, $2) ON CONFLICT(key) DO UPDATE SET value = EXCLUDED.value", [key, String(value)]);
  }

  async starsRate() {
    const value = Number(await this.getSetting("stars_rate", "20"));
    return Number.isSafeInteger(value) && value > 0 ? value : 20;
  }

  async numberDiscountPercent() {
    const value = Number(await this.getSetting("number_discount_percent", "0"));
    return Number.isSafeInteger(value) && value >= 0 ? Math.min(100, value) : 0;
  }

  async freeNumberDailyLimit() {
    const value = Number(await this.getSetting("free_number_daily_limit", "0"));
    return Number.isSafeInteger(value) && value >= 0 ? value : 0;
  }

  async wheelLimits(c = this.pool) {
    const query = async (key, fallback) => {
      const res = await c.query("SELECT value FROM settings WHERE key = $1", [key]);
      const value = Number(res.rows[0]?.value ?? fallback);
      return Number.isSafeInteger(value) && value >= 0 ? value : fallback;
    };
    return { daily: await query("wheel_daily_limit", 1), weekly: await query("wheel_weekly_limit", 5) };
  }

  async freeNumberDailyCount(ownerID) {
    const me = (await this.pool.query("SELECT free_day, free_day_count FROM users WHERE telegram_id = $1", [ownerID])).rows[0] ?? null;
    if (!me || me.free_day !== dayKey()) return 0;
    return me.free_day_count;
  }

  async productPrices() {
    const res = await this.pool.query("SELECT key, value FROM settings WHERE key LIKE 'price_%'");
    const prices = {};
    for (const row of res.rows) {
      const code = String(row.key).slice(6);
      const value = Number(row.value);
      if (code && Number.isSafeInteger(value) && value > 0 && value <= 100000) prices[code] = value;
    }
    return prices;
  }

  async setProductPrice(code, price) {
    if (!price) {
      await this.pool.query("DELETE FROM settings WHERE key = $1", [`price_${code}`]);
      return;
    }
    await this.setSetting(`price_${code}`, price);
  }

  async setPending(id, kind, payload = {}) {
    await this.pool.query(
      `INSERT INTO pending(telegram_id, kind, payload, updated_at) VALUES($1, $2, $3, $4)
       ON CONFLICT(telegram_id) DO UPDATE SET kind = EXCLUDED.kind, payload = EXCLUDED.payload, updated_at = EXCLUDED.updated_at`,
      [id, kind, JSON.stringify(payload), now()]
    );
  }

  async pending(id) {
    const res = await this.pool.query("SELECT * FROM pending WHERE telegram_id = $1", [id]);
    const row = res.rows[0];
    return row ? { kind: row.kind, payload: typeof row.payload === "string" ? JSON.parse(row.payload) : row.payload } : null;
  }

  async clearPending(id) {
    await this.pool.query("DELETE FROM pending WHERE telegram_id = $1", [id]);
  }

  async recentRecipients(buyerID) {
    const res = await this.pool.query("SELECT recipient_id FROM recent_recipients WHERE buyer_id = $1 ORDER BY used_at DESC LIMIT 3", [buyerID]);
    return res.rows.map((row) => row.recipient_id);
  }

  async rememberRecipient(buyerID, recipientID) {
    await this.pool.query(
      "INSERT INTO recent_recipients(buyer_id, recipient_id, used_at) VALUES($1, $2, $3) ON CONFLICT(buyer_id, recipient_id) DO UPDATE SET used_at = EXCLUDED.used_at",
      [buyerID, recipientID, now()]
    );
  }

  async reserveSpin(id, serverUserID, proposedPrize) {
    return this.tx(async (client) => {
      // Lock the user row so concurrent wheel taps serialize: the second click
      // sees the first one's pending award instead of reserving a second one.
      const user = (await client.query("SELECT telegram_id FROM users WHERE telegram_id = $1 FOR UPDATE", [id])).rows[0];
      if (!user) throw new Error("user not found");
      const day = dayKey(), week = weekKey();
      // An interrupted grant (reserved but never finished, possibly a previous
      // day) is resumed with the exact same spin_key, so the grant idempotency
      // key stays stable and the user never loses the reserved prize.
      const pending = (await client.query(
        "SELECT * FROM spin_awards WHERE telegram_id = $1 AND status = 'pending' ORDER BY created_at DESC LIMIT 1",
        [id]
      )).rows[0];
      if (pending) {
        if (pending.server_user_id !== serverUserID) throw new Error("finish the pending spin with the original server account ID");
        return pending;
      }
      // Count awards (done + abandoned pending), not user counters: a spin
      // consumed a slot whether or not its grant ever finished.
      const limits = await this.wheelLimits(client);
      const dayCount = (await client.query("SELECT count(*)::int AS c FROM spin_awards WHERE telegram_id = $1 AND day = $2", [id, day])).rows[0].c;
      if (limits.daily > 0 && dayCount >= limits.daily) throw new Error("daily spin limit reached");
      const weekCount = (await client.query("SELECT count(*)::int AS c FROM spin_awards WHERE telegram_id = $1 AND week = $2", [id, week])).rows[0].c;
      if (limits.weekly > 0 && weekCount >= limits.weekly) throw new Error("weekly spin limit reached");
      const spinKey = randomBytes(12).toString("hex");
      const result = await client.query(
        "INSERT INTO spin_awards(spin_key, telegram_id, day, week, server_user_id, prize, status, created_at) VALUES($1, $2, $3, $4, $5, $6, 'pending', $7) RETURNING *",
        [spinKey, id, day, week, serverUserID, proposedPrize, now()]
      );
      return result.rows[0];
    });
  }

  async finishSpin(id, spinKey) {
    await this.pool.query("UPDATE spin_awards SET status = 'done' WHERE telegram_id = $1 AND spin_key = $2", [id, spinKey]);
  }

  async createPromo(code, stars, limit) {
    code = String(code ?? "").trim().toLowerCase();
    if (!/^[a-z0-9_-]{3,32}$/.test(code) || !Number.isSafeInteger(stars) || stars <= 0 || !Number.isSafeInteger(limit) || limit < 0) throw new Error("invalid promo parameters");
    await this.pool.query("INSERT INTO promos(code, stars_amount, max_acts, created_at) VALUES($1, $2, $3, $4)", [code, stars, limit, now()]);
    return code;
  }

  async claimPromo(code, id) { return this.claimCampaign("promo", code.trim().toLowerCase(), id); }

  async createGiveaway(text, stars, limit) {
    text = String(text ?? "").trim();
    if (!text || text.length > 1000 || !Number.isSafeInteger(stars) || stars <= 0 || !Number.isSafeInteger(limit) || limit < 0) throw new Error("invalid giveaway parameters");
    const id = randomBytes(4).toString("hex");
    const result = await this.pool.query(
      "INSERT INTO giveaways(id, text, stars_amount, max_acts, created_at) VALUES($1, $2, $3, $4, $5) RETURNING *",
      [id, text, stars, limit, now()]
    );
    return result.rows[0];
  }

  async claimGiveaway(id, telegramID) { return this.claimCampaign("giveaway", id, telegramID); }

  async releaseCampaignClaim(kind, key, telegramID) {
    const table = kind === "promo" ? "promos" : "giveaways";
    const claims = kind === "promo" ? "promo_claims" : "giveaway_claims";
    const keyColumn = kind === "promo" ? "code" : "giveaway_id";
    const itemKey = kind === "promo" ? "code" : "id";
    await this.tx(async (client) => {
      const removed = await client.query(`DELETE FROM ${claims} WHERE ${keyColumn} = $1 AND telegram_id = $2`, [key, telegramID]);
      if (removed.rowCount) await client.query(`UPDATE ${table} SET activations = GREATEST(0, activations - 1), active = TRUE WHERE ${itemKey} = $1`, [key]);
    });
  }

  async claimCampaign(kind, key, telegramID) {
    const table = kind === "promo" ? "promos" : "giveaways";
    const claims = kind === "promo" ? "promo_claims" : "giveaway_claims";
    const keyColumn = kind === "promo" ? "code" : "giveaway_id";
    const itemKey = kind === "promo" ? "code" : "id";
    return this.tx(async (client) => {
      const item = (await client.query(`SELECT * FROM ${table} WHERE ${itemKey} = $1`, [key])).rows[0];
      if (!item || !item.active) throw new Error("campaign is unavailable");
      if (item.max_acts > 0 && item.activations >= item.max_acts) throw new Error("campaign limit reached");
      const claimed = (await client.query(`SELECT 1 FROM ${claims} WHERE ${keyColumn} = $1 AND telegram_id = $2`, [key, telegramID])).rows[0];
      if (claimed) throw new Error("already claimed");
      await client.query(`INSERT INTO ${claims}(${keyColumn}, telegram_id, claimed_at) VALUES($1, $2, $3)`, [key, telegramID, now()]);
      const active = item.max_acts <= 0 || item.activations + 1 < item.max_acts;
      await client.query(`UPDATE ${table} SET activations = activations + 1, active = $1 WHERE ${itemKey} = $2`, [active, key]);
      return { ...item, activations: item.activations + 1, active, stars_amount: item.stars_amount };
    });
  }

  async beginPayment(chargeID, telegramID, payload, amount, providerChargeID = "") {
    return this.tx(async (client) => {
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [`payment:${chargeID}`]);
      const row = (await client.query("SELECT * FROM processed_payments WHERE charge_id = $1", [chargeID])).rows[0];
      if (row && (row.telegram_id !== telegramID || row.invoice_payload !== payload || row.amount !== amount)) throw new Error("IDEMPOTENCY_CONFLICT");
      if (row?.status === "done") return false;
      if (row?.status === "processing" && row.updated_at > now() - 300) return false;
      await client.query(
        `INSERT INTO processed_payments(charge_id, provider_charge_id, telegram_id, invoice_payload, amount, status, updated_at)
         VALUES($1, $2, $3, $4, $5, 'processing', $6)
         ON CONFLICT(charge_id) DO UPDATE SET provider_charge_id = CASE WHEN processed_payments.provider_charge_id = '' THEN EXCLUDED.provider_charge_id ELSE processed_payments.provider_charge_id END,
         status = 'processing', error = '', updated_at = EXCLUDED.updated_at`,
        [chargeID, String(providerChargeID ?? ""), telegramID, payload, amount, now()]
      );
      return true;
    });
  }

  async finishPayment(chargeID) {
    await this.pool.query("UPDATE processed_payments SET status = 'done', error = '', updated_at = $1 WHERE charge_id = $2", [now(), chargeID]);
  }

  async failPayment(chargeID, error) {
    await this.pool.query("UPDATE processed_payments SET status = 'failed', error = $1, updated_at = $2 WHERE charge_id = $3 AND status <> 'done'", [String(error).slice(0, 1000), now(), chargeID]);
  }

  async addSale(sale) {
    await this.insertSale(this.pool, sale);
  }

  async insertSale(client, sale) {
    await client.query(
      `INSERT INTO sales(created_at, product, title, stars_price, recipient_id, buyer_id, buyer_name, charge_id, provider_charge_id, fulfillment_json)
       VALUES($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) ON CONFLICT DO NOTHING`,
      [now(), sale.product, sale.title, sale.starsPrice, sale.recipientID, sale.buyerID, sale.buyerName ?? "", sale.chargeID, String(sale.providerChargeID ?? ""), JSON.stringify(sale.fulfillment ?? {})]
    );
  }

  async paymentByCharge(chargeID) {
    return (await this.pool.query("SELECT * FROM processed_payments WHERE charge_id = $1", [chargeID])).rows[0] ?? null;
  }

  async fulfillNumberPurchase(sale, chatID, format) {
    return this.tx(async (client) => {
      const ownerGrant = sale.chargeID.startsWith("owner-");
      const payment = (await client.query("SELECT * FROM processed_payments WHERE charge_id = $1 FOR UPDATE", [sale.chargeID])).rows[0];
      if (!ownerGrant && (!payment || payment.telegram_id !== sale.buyerID || payment.amount !== sale.starsPrice)) throw new Error("IDEMPOTENCY_CONFLICT");
      const existing = (await client.query("SELECT * FROM sales WHERE charge_id = $1", [sale.chargeID])).rows[0];
      if (existing) {
        if (existing.buyer_id !== sale.buyerID || existing.product !== sale.product || existing.stars_price !== sale.starsPrice) throw new Error("IDEMPOTENCY_CONFLICT");
        const number = (await client.query("SELECT * FROM numbers WHERE id = $1 AND owner_id = $2", [existing.fulfillment_json.numberID, sale.buyerID])).rows[0];
        if (!number) throw new Error("recorded purchased number is missing");
        return number;
      }
      const number = await this.createNumberInTransaction(client, sale.buyerID, chatID, format, "ANON", true, true);
      const fulfillment = { kind: "number", ownerID: sale.buyerID, numberID: number.id, phone: number.phone, format: number.format };
      await this.insertSale(client, { ...sale, recipientID: sale.buyerID, fulfillment });
      await client.query("UPDATE processed_payments SET status = 'done', error = '', updated_at = $1 WHERE charge_id = $2", [now(), sale.chargeID]);
      return number;
    });
  }

  async saleByCharge(query) {
    const res = await this.pool.query(
      `SELECT s.*, p.invoice_payload, p.status AS payment_status
       FROM sales s LEFT JOIN processed_payments p ON p.charge_id = s.charge_id
       WHERE s.charge_id = $1 OR s.provider_charge_id = $1
       ORDER BY (s.charge_id = $1) DESC LIMIT 1`,
      [query]
    );
    const row = res.rows[0];
    if (!row) return null;
    if (typeof row.fulfillment_json === "string") {
      try { row.fulfillment = JSON.parse(row.fulfillment_json || "{}"); } catch { row.fulfillment = {}; }
    } else {
      row.fulfillment = row.fulfillment_json || {};
    }
    return row;
  }

  async refundTargetByCharge(query) {
    const sale = await this.saleByCharge(query);
    if (sale) return sale;
    const res = await this.pool.query(
      `SELECT * FROM processed_payments
       WHERE charge_id = $1 OR provider_charge_id = $1
       ORDER BY (charge_id = $1) DESC LIMIT 1`,
      [query]
    );
    const payment = res.rows[0];
    if (!payment) return null;
    return {
      charge_id: payment.charge_id,
      product: "custom",
      title: "",
      buyer_id: payment.telegram_id,
      invoice_payload: payment.invoice_payload,
      payment_status: payment.status,
      fulfillment: { kind: "custom" },
      synthetic: true,
    };
  }

  async recentSales(limit = 20) {
    const res = await this.pool.query("SELECT * FROM sales ORDER BY id DESC LIMIT $1", [limit]);
    return res.rows;
  }

  async refundByCharge(chargeID) {
    const res = await this.pool.query("SELECT * FROM refunds WHERE charge_id = $1", [chargeID]);
    return res.rows[0] ?? null;
  }

  async isRefunded(chargeID) {
    const refund = await this.refundByCharge(chargeID);
    return refund?.status === "completed";
  }

  async beginRefund(chargeID, telegramID) {
    await this.pool.query(
      `INSERT INTO refunds(charge_id, telegram_id, refunded_at, status, internal_reversed, error, updated_at)
       VALUES($1, $2, 0, 'reversing', FALSE, '', $3)
       ON CONFLICT(charge_id) DO UPDATE SET telegram_id = EXCLUDED.telegram_id,
       status = CASE WHEN refunds.status = 'completed' THEN refunds.status WHEN refunds.internal_reversed = TRUE THEN 'internal_reversed' ELSE 'reversing' END,
       error = '', updated_at = EXCLUDED.updated_at`,
      [chargeID, telegramID, now()]
    );
    return this.refundByCharge(chargeID);
  }

  async markRefundInternal(chargeID) {
    await this.pool.query("UPDATE refunds SET status = 'internal_reversed', internal_reversed = TRUE, error = '', updated_at = $1 WHERE charge_id = $2", [now(), chargeID]);
  }

  async failRefund(chargeID, error) {
    await this.pool.query(
      "UPDATE refunds SET status = CASE WHEN internal_reversed = TRUE THEN 'internal_reversed' ELSE 'failed' END, error = $1, updated_at = $2 WHERE charge_id = $3",
      [String(error).slice(0, 1000), now(), chargeID]
    );
  }

  async markRefunded(chargeID, telegramID) {
    await this.pool.query(
      `INSERT INTO refunds(charge_id, telegram_id, refunded_at, status, internal_reversed, error, updated_at)
       VALUES($1, $2, $3, 'completed', TRUE, '', $3)
       ON CONFLICT(charge_id) DO UPDATE SET telegram_id = EXCLUDED.telegram_id, refunded_at = EXCLUDED.refunded_at,
       status = 'completed', internal_reversed = TRUE, error = '', updated_at = EXCLUDED.updated_at`,
      [chargeID, telegramID, now()]
    );
  }

  async addSupportMessage(id, chatID, text) {
    const res = await this.pool.query(
      "INSERT INTO support_messages(telegram_id, chat_id, text, created_at) VALUES($1, $2, $3, $4) RETURNING id",
      [id, chatID, text, now()]
    );
    return res.rows[0].id;
  }

  async supportMessage(ticketID) {
    const res = await this.pool.query("SELECT * FROM support_messages WHERE id = $1", [ticketID]);
    return res.rows[0] ?? null;
  }

  async closeSupportMessage(ticketID, answeredBy = 0, answer = "") {
    // Atomic claim: only the first concurrent admin may transition the ticket
    // open -> answered. Losing admins get rowCount 0 instead of overwriting
    // answered_by/answer.
    const result = await this.pool.query(
      "UPDATE support_messages SET status = 'answered', answered_at = $1, answered_by = $2, answer = $3 WHERE id = $4 AND status = 'open'",
      [now(), answeredBy, answer, ticketID]
    );
    return result.rowCount === 1;
  }

  async rateSupportTicket(ticketID, rating, telegramID) {
    // A ticket can only be rated after it was answered; a forged rating on an
    // open ticket must not block the legitimate one.
    const result = await this.pool.query(
      "INSERT INTO support_ratings(ticket_id, rating) SELECT id, $2 FROM support_messages WHERE id = $1 AND telegram_id = $3 AND status = 'answered' ON CONFLICT (ticket_id) DO NOTHING",
      [ticketID, rating, telegramID]
    );
    return result.rowCount === 1;
  }

  async recentSupportRatings(limit = 10) {
    const res = await this.pool.query(
      `SELECT sm.id, sm.answered_by, sr.rating, sr.created_at AS rated_at, sm.created_at
       FROM support_ratings sr JOIN support_messages sm ON sm.id = sr.ticket_id
       ORDER BY sr.created_at DESC LIMIT $1`,
      [limit]
    );
    return res.rows;
  }

  // --- Verified phones (real-number mode) ---

  async verifiedPhone(telegramID) {
    const res = await this.pool.query("SELECT * FROM verified_phones WHERE telegram_id = $1", [telegramID]);
    return res.rows[0] ?? null;
  }

  async bindVerifiedPhone(telegramID, chatID, phone) {
    const formatted = normalizePhone(phone);
    return this.tx(async (client) => {
      // If the phone was bound to another Telegram account, that account's
      // delivery route is gone; drop its server_user_id so it can never keep
      // referencing (and receiving grants for) a number it no longer owns.
      const previous = (await client.query("SELECT telegram_id FROM verified_phones WHERE phone = $1", [formatted])).rows[0] ?? null;
      await client.query("DELETE FROM verified_phones WHERE phone = $1", [formatted]);
      if (previous && previous.telegram_id !== telegramID) {
        await client.query("UPDATE users SET server_user_id = 0, updated_at = $1 WHERE telegram_id = $2", [now(), previous.telegram_id]);
      }
      const res = await client.query(
        `INSERT INTO verified_phones(phone, telegram_id, chat_id, verified_at) VALUES($1, $2, $3, $4)
         ON CONFLICT(telegram_id) DO UPDATE SET phone = EXCLUDED.phone, chat_id = EXCLUDED.chat_id, verified_at = EXCLUDED.verified_at
         RETURNING *`,
        [formatted, telegramID, chatID, now()]
      );
      return res.rows[0] ?? null;
    });
  }

  async unbindVerifiedPhone(telegramID) {
    const res = await this.pool.query("DELETE FROM verified_phones WHERE telegram_id = $1", [telegramID]);
    return res.rowCount > 0;
  }

  // --- Admin number binding (replaces every previously owned number) ---

  async adminBindNumber(ownerID, chatID, phone) {
    const formatted = normalizePhone(phone);
    if (!/^\+[1-9]\d{6,14}$/.test(formatted)) throw new Error("invalid phone number");
    return this.tx(async (client) => {
      const user = (await client.query("SELECT telegram_id, chat_id FROM users WHERE telegram_id = $1", [ownerID])).rows[0];
      if (!user) throw new Error("user not found");
      await client.query("SELECT telegram_id FROM users WHERE telegram_id = $1 FOR UPDATE", [ownerID]);
      const owned = (await client.query("SELECT * FROM numbers WHERE owner_id = $1 AND retired = FALSE", [ownerID])).rows;
      const { format, country } = formatForPhone(formatted);
      for (const number of owned) {
        if (number.format === "free") {
          await client.query("DELETE FROM numbers WHERE id = $1", [number.id]);
        } else {
          await client.query("UPDATE numbers SET is_current = FALSE, retired = TRUE WHERE id = $1", [number.id]);
        }
      }
      const display = displayForPhone(formatted, format, country);
      const result = await client.query(
        `INSERT INTO numbers(phone, display, format, country, owner_id, chat_id, is_current, login_code, code_expires_at, created_at)
         VALUES($1, $2, $3, $4, $5, $6, TRUE, '', 0, $7)
         ON CONFLICT(phone) DO NOTHING RETURNING *`,
        [formatted, display, format, country, ownerID, chatID ?? user.chat_id, now()]
      );
      if (!result.rowCount) throw new Error("phone is already allocated to another owner");
      return result.rows[0];
    });
  }

  // --- Admin exact lookups (no dumps) ---

  async adminLookupByNumber(phone) {
    phone = normalizePhone(phone);
    const number = await this.findNumber(phone);
    if (!number) return null;
    const owner = await this.user(number.owner_id);
    const verified = await this.pool.query("SELECT * FROM verified_phones WHERE phone = $1", [phone]);
    return { number, owner, verifiedPhone: verified.rows[0] ?? null };
  }

  async adminLookupByTelegramID(telegramID) {
    const user = await this.user(telegramID);
    if (!user) return null;
    const numbers = await this.numbers(telegramID);
    const verified = await this.verifiedPhone(telegramID);
    return { user, numbers, verifiedPhone: verified };
  }

  async adminLookupByUsername(username) {
    const user = await this.userByUsername(username);
    if (!user) return null;
    const numbers = await this.numbers(user.telegram_id);
    const verified = await this.verifiedPhone(user.telegram_id);
    return { user, numbers, verifiedPhone: verified };
  }

  async userByUsername(username) {
    const normalized = String(username ?? "").trim().replace(/^@/, "").toLowerCase();
    if (!/^[a-z0-9_]{1,32}$/.test(normalized)) return null;
    const res = await this.pool.query("SELECT * FROM users WHERE lower(username) = $1 LIMIT 1", [normalized]);
    return res.rows[0] ?? null;
  }

  // --- Admin recent activity (sales + refunds) ---

  async adminRecentActivity(telegramID) {
    if (!Number.isSafeInteger(Number(telegramID)) || Number(telegramID) <= 0) return { sales: [], refunds: [] };
    const [sales, refunds] = await Promise.all([
      this.pool.query(
        `SELECT title, stars_price, charge_id, created_at FROM sales
         WHERE buyer_id = $1 OR recipient_id = $1 ORDER BY id DESC LIMIT 10`,
        [Number(telegramID)],
      ),
      this.pool.query(
        `SELECT r.charge_id, r.refunded_at, r.updated_at, r.status, s.title, s.stars_price
         FROM refunds r LEFT JOIN sales s ON s.charge_id = r.charge_id
         WHERE r.telegram_id = $1 ORDER BY r.refunded_at DESC, r.charge_id DESC LIMIT 10`,
        [Number(telegramID)],
      ),
    ]);
    return { sales: sales.rows, refunds: refunds.rows };
  }
}

export const internals = { generatedNumber, normalizePhone, dayKey, weekKey };
