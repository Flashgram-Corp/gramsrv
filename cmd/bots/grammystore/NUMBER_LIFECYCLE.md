# Number allocation and client-confirmed phone changes

Status: current design for the PostgreSQL store bot.

## Authorization boundary

The bot reserves numbers and delivers server-issued verification codes. It does
not call the administrative set-phone API from ordinary user flows. The only
places a server phone is changed are explicit administrative actions and the
purchase/retention rebinds described below. Manual account IDs and phone-to-ID
lookups select purchase/gift recipients; they do not authorize an account
mutation. A Telegram contact establishes a code delivery route, not an
authenticated session on the server.

An existing account changes its phone in its signed-in client using
`account.sendChangePhoneCode` and `account.changePhone`. The server checks the
current user/auth key and verification code. This bot does not implement or change
MTProto, session, update/outbox, or PTS behavior.
Protocol reference: [account.changePhone](https://core.telegram.org/method/account.changePhone).

## Identity audit: server account ID versus phone

A Telegram account maps to one server account by the bot's stored
`users.server_user_id` ID, captured from phone-to-ID lookups during purchases,
from the account fetch flow, or entered manually in Settings. That ID selects the
purchase/gift recipient and enables refunds; it does not itself change the server
account's phone.

`settings:account:enter` ("set ID") only writes the bot row. The three places a
server phone actually changes are the purchase rebind (`gramsrv.setPhone` when a
stored server account disagrees with the newly bought number), retention
cleanup (rebinding a still-signed-up free number to the owned +888 before
releasing it), and the admin bind command (`admin:bindphone`, which replaces
the user's numbers with a store-provided number and rebinds the server account).
The purchase and retention rebinds run only when the server explicitly
authorizes the mutation; the admin bind runs on the owner's direct command.

- A single server ID may not be claimed by two bot users: `users.server_user_id`
  has a unique partial index (`users_server_user_id_uq`) over
  `server_user_id > 0`. The second claim fails with a user-facing error.
- Whenever a phone binds to a user (`bindVerifiedPhone`), any previous holder's
  server ID is cleared to keep one-ID-per-user consistent with phone ownership.
- Manual ID entry verifies the typed ID against the current number: if the phone
  resolves to a different account and the typed ID disagrees, the entry is
  rejected. If no number can be resolved, the typed ID is stored as before.
- A failed `setPhone` during a purchase notifies the owner instead of failing
  silently; the user still gets their number and any free number is released.
- When a purchase succeeds but the stored server account ID cannot be linked to
  the buyer's phone, the buyer is told to change the number in their signed-in
  client instead of the bot calling `setPhone`.
- 888 numbers stay unique per user: buying a new +888 replaces the previously
  owned +888 (and the server account phone), so the account's own number is never
  left pointing at a retired reservation.

## Repeat +888 purchases and admin binding

The store sells anonymous numbers; it does not buy numbers back and no sell-offer
flow exists. Every user owns exactly one number: one free +7/+1 (random mode) or
one purchased +888. "Buy a new number" from the numbers menu (after owning a
+888) or the shop always purchases a fresh +888.

1. A repeat +888 buyer (already owns a current +888) pays a discount, configured
   by the admin as `number_discount_percent` in the settings row. The effective
   price `max(1, round(base × (100 − discount) / 100))` is shown in the shop
   list, the product page, the invoice, the pre-checkout validation and the
   stored sale snapshot, so a later discount change cannot undervalidate a
   payment. First-time +888 buyers pay the catalog price.
2. Fulfilling a +888 purchase for a user who already owns one retires the old
   +888 (`is_current = false, retired = true`) inside the same transaction that
   allocates the new number, and rebinds the server account phone. A retired
   +888 is never returned to the pool.
3. Admins can set any number for any user with `admin:bindphone` →
   `ID PHONE`. The bind removes every currently owned number (free numbers are
   deleted, purchased ones retired), allocates the given phone as the user's
   only current number, and calls `gramsrv.setPhone` when the user has a stored
   server account. A phone already allocated to another owner is refused.
4. Free +7/+1 numbers can no longer be rebought by the store; an admin bind or
   a +888 purchase replaces them instead.

## Persisted invariants

- A phone is allocated to at most one bot owner, including historical and
  retired numbers. Retired numbers are never returned to the random pool.
- Every owner has at most one current, non-retired number. A free re-roll and a
  +888 purchase each replace the previous current number; a repeat +888 purchase
  replaces the previous +888.
- Buying a number does not remove a verified real-phone route.
- Free-number reservations are capped at 10 per owner; reaching the cap rejects
  allocation without releasing an old phone or changing its route.
- Number allocation, the sale snapshot, and payment completion commit in one
  PostgreSQL transaction. Charge identity (buyer, payload, amount) is immutable.
  A retry reuses the recorded sale and cannot allocate a second number.
- A database error rolls the entire number purchase back. A completed purchase
  is not marked failed if a later notification fails. An owner can retry a stored
  number payment using `/retry_payment <charge_id>`; no new payment is created.
- Allocation locks the owner, including on first allocation. Only collisions on
  the unique phone key are retried; other database errors propagate.
- Retention never deletes a signed-up free number: the account is rebound to the
  owned number first, and an unresolved or erroring lookup fails the sweep closed
  instead of removing the number.

## Refund boundary

The user first changes away from the purchased number in their signed-in client.
The bot refuses retirement while a previously delivered code is unexpired or the
server still reports any account using the number. The server lookup is mandatory,
read-only and timeout-bounded; errors/malformed replies fail closed. The number row
is locked across checks and retirement; OTP acceptance uses the same row lock.
No intervening webhook can accept a fresh code during retirement. The maximum
recorded code expiry never shrinks.

Once safe, the number becomes a permanent retired reservation, its code-access
grants are removed, and the previous free number becomes current if present.
Retirement is idempotent across a crash before recording refund progress. If
Telegram's refund fails, retrying cannot revoke another number or repeat a
completed internal reversal. Retired numbers reject future OTP deliveries even
if a later owner command creates a code-access grant.

Production requires the server's random-code webhook delivery path for these
numbers; fixed development codes or a second independent provider are not a
supported custody boundary. Do not purge historical numbers or code expiry state.

## Verification matrix

| Scenario | Required result |
|---|---|
| Another account ID followed by start/replace/buy | No server phone mutation |
| New number or +888 purchase | Old free/real-phone OTP routes remain |
| Collision followed by an available phone | Retry in a valid transaction |
| Generator exhaustion / SQL failure during sale | Atomic rollback |
| Charge replay / concurrent replay / restart | One number, sale and completed payment |
| Replay with changed buyer/payload/amount | Conflict without writes |
| Refund while bound, codes active, or API unavailable | No reversal or Telegram refund |
| OTP concurrent with refund | Serialized; active-code check cannot be bypassed |
| Refund / Telegram failure then retry | Exact number retired once, never reallocated |
| Delayed OTP for retired number | Explicit rejection, no recipient |
| Docker build beside .env / local dependencies | Only runtime source/manifests included |

Fresh installations use `db/init.sql`. Existing PostgreSQL installations must
apply `db/migrations/001-number-retirement.sql`,
`db/migrations/002-refund-provider-charge.sql`,
`db/migrations/003-users-server-user-id-unique.sql`,
`db/migrations/004-number-offers.sql` and
`db/migrations/005-drop-number-offers.sql` before starting this version.
The migrations add the retirement field and its constraint, the refund provider
charge key, the unique server-user-ID index, the number-offers table, and a final
migration that drops the removed offers table; they do not infer ownership or
repair state written by an unsafe pre-release bot.
