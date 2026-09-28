# Architecture

## Layout

```
src/
  config/env.ts         Zod-validated environment (fails fast at boot)
  lib/                  prisma client, pino logger (redacted), errors, money,
                        ids, audit helper
  middleware/           auth (JWT + roles), validate (zod), error handler,
                        rate limiting
  modules/
    catalog/            products/categories/collections/search (public)
    auth/               register/login/refresh/logout/password reset
    account/            profile, addresses, order history, wishlist
    cart/               server-side cart (cookie session, guest merge)
    order/              transactional order creation, immutable history
    payment/            PaymentGateway interface, Razorpay + Mock drivers,
                        verified webhook processing
    shipping/           shipment records + tracking
    returns/            return requests + refunds (customer + admin)
    reviews/            verified-purchase reviews with moderation
    newsletter/ contact/
    admin/              catalog/inventory/order management, audit-logged
prisma/schema.prisma    full relational schema (see below)
```

## Request flow

1. `server.ts` boots: validates env, connects Prisma, ensures roles exist.
2. `app.ts`: Helmet → strict CORS (allow-list, credentials) → JSON parser with raw-body capture (webhook HMAC) → cookie parser → global rate limit → routers → 404 → error handler.
3. Errors: any thrown `ApiError` serializes as `{ error: { code, message, details } }`; anything else is logged server-side (redacted) and returned as generic `INTERNAL`.

## Database (PostgreSQL via Prisma)

- **Money**: integer paise everywhere; API converts to integer rupees.
- **Catalog**: Category (world: sport/lifestyle) ← Product → ProductImage, ProductFeature, ProductVariant → Inventory. Collections optional (SetNull on delete). Products are Restrict-delete while referenced by categories.
- **Inventory**: `available/reserved/sold` per variant + append-only `InventoryMovement` audit. Checkout locks rows `FOR UPDATE` inside a transaction: validates stock, reserves, writes movements. Webhook confirmation converts reserved→sold; failures/cancellations release back to available.
- **Carts**: cookie-tokened; guest carts merge into the user cart at login; converted (not deleted) at checkout for analytics.
- **Orders**: immutable snapshots — item name/slug/SKU/color/size/price/line total are frozen at purchase; `shippingAddress` stored as JSON snapshot; status transitions recorded in `OrderStatusEvent`.
- **Payments**: one row per attempt; `provider*Id` idempotency; only a signature-verified webhook flips an order to PAID (amount cross-checked).
- **Indexes** on: user email, product slug/status/featured/new-arrival, category, order status + user+createdAt, payment provider ids, inventory availability, audit created_at, review (product, moderation).

## Security model

- Passwords: bcrypt (cost 12, env-tunable); lockout after 5 failed logins (15 min).
- Tokens: 15-min access JWT; refresh tokens hashed (SHA-256) at rest, rotated on every use, theft detected by reuse → family revoked; refresh cookie `httpOnly; Secure; SameSite=Strict; path=/api/v1/auth`.
- Authorization: `requireAuth` / `requireRole('ADMIN')` middleware; account/order/cart ownership checked per request (404 over 403 for foreign resources).
- Payments: secrets only in env; browser never sees anything but a public key id; webhook HMAC-SHA256 verified against the raw body with the raw-body capture middleware; mock provider refuses to boot in production.
- Validation: Zod on all inputs; Prisma parameterized queries (no string SQL from user input; the only raw query uses `Prisma.join` binding).
- Abuse: rate limits on auth (10/10min), register (10/h), contact (5/h), reviews (10/h), search (60/min), plus a 300/min baseline.
- Logs: pino with `redact` on authorization headers, cookies, passwords, tokens; unknown errors logged with stack, returned to clients as a generic message.

## Known trade-offs (deliberate)

- bcryptjs instead of Argon2id: zero native-build friction for Docker/Windows; swap is a one-line change when needed.
- Password-reset tokens reuse the `RefreshToken` table with a `reset:` prefix — hashed, single-use, 1h TTL.
- Email sending (verification, reset links, order confirmations, newsletter confirmations) is intentionally deferred; the token/URL contracts are already in place.
- Search is Postgres `contains` matching (same semantics as the frontend's current client-side filter); upgrade to full-text/trigram when the catalog grows.
