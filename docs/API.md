# KIEN Sports API Contract

Base URL: `/api/v1`. Content type: JSON.

**Response envelope** — success: `{ "data": ... }`, failure: `{ "error": { "code": string, "message": string, "details": unknown|null } }`.

**Authentication** — `Authorization: Bearer <accessToken>` header. Access tokens last 15 min; refresh via the `kien_refresh` httpOnly cookie at `POST /auth/refresh`. Carts use an httpOnly `kien_cart` cookie (guest-friendly).

**Money** — All API amounts are **integer rupees** (e.g. `4999`). Internally the DB stores paise.

**Error codes** — `VALIDATION_ERROR` (400), `UNAUTHENTICATED` (401), `FORBIDDEN` (403), `NOT_FOUND` (404), `EMAIL_TAKEN` / `OUT_OF_STOCK` / `CART_INVALID` / `RETURN_NOT_ALLOWED` / `RETURN_EXISTS` (409), `RATE_LIMITED` (429), `INTERNAL` (500).

---

## Health

### GET /health
- Auth: none
- Response: `{ "data": { "status": "ok" } }`

## Catalog

### GET /products
- Auth: none
- Query: `category` (`sport`|`lifestyle`), `subcategory`, `collection`, `featured`, `newArrival`, `bestSeller`, `search`, `sort` (`newest`|`price-asc`|`price-desc`|`name`), `page` (default 1), `limit` (default 24, max 60)
- Response: `{ "data": { "data": Product[], "page": number, "limit": number, "total": number } }`
- Errors: `VALIDATION_ERROR`
- `Product` mirrors the frontend `src/types/index.ts` interface field-for-field, plus `variants[]` (id, sku, colorName, colorHex, size, price, availableQty).

### GET /products/:slug
- Auth: none
- Response: `{ "data": Product }`
- Errors: `NOT_FOUND`

### GET /categories?world=sport|lifestyle
- Auth: none
- Response: `{ "data": [{ name, slug, world, hasProducts, description }] }` — matches the frontend `Category` type.

### GET /collections
- Auth: none
- Response: `{ "data": [{ id, slug, name, description, productCount }] }`

### GET /search?q=backpack&limit=8
- Auth: none · rate limit 60/min
- Query: `q` (min 2 chars, mirrors the frontend SearchOverlay), `limit`
- Response: `{ "data": Product[] }`

## Auth

### POST /auth/register
- Auth: none · rate limit 10/h
- Body: `{ email, password (min 8), firstName, lastName, phone? }`
- Response 201: `{ "data": { accessToken, user } }` + sets refresh cookie
- Errors: `VALIDATION_ERROR`, `EMAIL_TAKEN` (409)

### POST /auth/login
- Auth: none · rate limit 10/10min (account locks for 15 min after 5 failures)
- Body: `{ email, password }`
- Response: `{ "data": { accessToken, user } }` + refresh cookie
- Errors: `UNAUTHENTICATED` (never reveals which field was wrong)

### POST /auth/refresh
- Auth: refresh cookie · rotates the token; reuse of an old token revokes the whole family
- Response: `{ "data": { accessToken } }` + new refresh cookie
- Errors: `UNAUTHENTICATED`

### POST /auth/logout
- Auth: refresh cookie
- Response: `{ "data": { ok: true } }`, clears cookie

### POST /auth/password/forgot
- Body: `{ email }` · always responds 200 (no account enumeration). Email delivery is a future phase; in non-production the response includes `devResetToken` for testing.

### POST /auth/password/reset
- Body: `{ token, password }` · revokes all sessions on success
- Errors: `NOT_FOUND` for invalid/expired token

## Account

All routes need Bearer auth. Ownership is enforced (404 rather than 403 to avoid leaking resource existence).

| Method | Route | Notes |
|---|---|---|
| GET | /account | `{ id, email, firstName, lastName, phone, emailVerified, roles }` |
| PATCH | /account | Body: any of `firstName, lastName, phone` |
| GET | /account/addresses | List |
| POST | /account/addresses | Body: `{ label, firstName, lastName, line1, line2?, city, state, pincode (6-digit Indian), phone (Indian mobile), isDefault }` |
| PATCH | /account/addresses/:id | Partial body |
| DELETE | /account/addresses/:id | |
| GET | /account/orders | Order history (drives AccountPage) |
| GET | /account/wishlist | `{ id, productId, name, slug, price, color, image, inStock }[]` |
| POST | /account/wishlist/:productId | Add |
| DELETE | /account/wishlist/:productId | Remove |

## Cart

Bound to the `kien_cart` cookie; authenticated users' carts merge on login.

| Method | Route | Body | Notes |
|---|---|---|---|
| GET | /cart | — | `{ items, totalItems, subtotal, shipping, total }` — prices resolved server-side |
| GET | /cart/quote | — | `{ subtotal, shipping, total, freeShippingThreshold: 2000 }` |
| POST | /cart/items | `{ variantId, quantity? }` | 201; `OUT_OF_STOCK` with `{ sku, requested, available }` if short |
| PATCH | /cart/items/:itemId | `{ quantity }` (0 removes) | |
| DELETE | /cart/items/:itemId | — | |

## Orders & checkout

### POST /orders
- Auth: optional (guest checkout)
- Body: `{ email, address: { firstName, lastName, line1, line2?, city, state, pincode, phone }, paymentMethod: "CARD"|"UPI"|"COD" }`
- Behaviour: transactionally locks inventory, re-prices server-side, reserves stock, creates an immutable order + items + payment record, then creates the provider session.
- Response 201: `{ "data": { order, payment: { method, provider, checkoutPayload } } }` — `checkoutPayload` contains no secrets (for Razorpay: public key id + provider order id).
- Errors: `CART_EMPTY` (400), `CART_INVALID` (409, with per-item problems), `OUT_OF_STOCK` (409)

### GET /orders/:orderNumber/status
- Auth: none — public poll right after checkout. Returns only `{ orderNumber, status, paymentStatus }`, no PII.

### GET /orders/:orderNumber
- Auth: owner (or guest with the cart cookie that created it) — full order + status events.
- Errors: `NOT_FOUND` for other users' orders.

## Payments

### POST /payments/webhook/:provider
- Auth: none — verified by HMAC signature (`X-Razorpay-Signature`, HMAC-SHA256 of raw body with `PAYMENT_WEBHOOK_SECRET`). **The only path that marks an order PAID.** Idempotent; amount cross-checked against the payment record; mismatches are logged and rejected.
- Errors: `VALIDATION_ERROR` (invalid signature/payload), `NOT_FOUND` (unknown payment)

### POST /payments/mock/pay  *(development only, PAYMENT_PROVIDER=mock)*
- Sandbox simulator: `{ providerOrderId, paymentId, payToken }` where `payToken` is the HMAC issued in the checkout payload. Refuses to run outside the mock provider. In production the mock provider refuses to boot at all.

## Shipping

### GET /shipping/track/:orderNumber
- Auth: owner — returns shipment records `{ carrier, trackingNumber, status, shippedAt, deliveredAt }[]`

## Returns

### POST /returns  (auth)
- Body: `{ orderNumber, orderItemId, reason }` — allowed only for DELIVERED orders; one request per item.
- Errors: `RETURN_NOT_ALLOWED` (400), `RETURN_EXISTS` (409)

### GET /returns  (auth) — customer's return requests

## Reviews

### GET /products/:productId/reviews
- Auth: none — only APPROVED reviews; includes `averageRating` and `count`.

### POST /products/:productId/reviews  (auth, 10/h)
- Body: `{ rating 1-5, title?, body }` — one review per user per product; `isVerifiedPurchase` computed from PAID orders; enters moderation as PENDING (never displayed immediately).

## Newsletter

- POST /newsletter/subscribe — `{ email }` → PENDING + confirm link (token rotated after use)
- POST /newsletter/confirm — `{ token }`
- POST /newsletter/unsubscribe — `{ email }`

## Contact

### POST /contact  (5/h)
- Body: `{ name, email, subject ("order"|"product"|"return"|"partnership"|"press"|"other"), message }` — matches the ContactPage form exactly.

## Admin (`/admin/*`)

All routes require Bearer auth with the ADMIN role (403 otherwise) and mutations are audit-logged.

| Method | Route | Notes |
|---|---|---|
| GET | /admin/products | Paginated, with stock totals |
| POST | /admin/products | Full product create (images, features, variants with initial inventory) |
| PATCH | /admin/products/:id | Partial update |
| POST | /admin/inventory/adjust | `{ sku, deltaQty, type: RESTOCK|ADJUST, reason? }` — negative stock rejected; movement recorded |
| GET | /admin/inventory/low-stock | Variants at/below threshold |
| GET | /admin/orders?status=&page= | |
| POST | /admin/orders/:orderNumber/transition | `{ toStatus, note? }` — fulfillment states; cancellation releases/restores stock |
| PATCH | /admin/shipments/:id | carrier/tracking/status |
| GET /admin/returns · PATCH /admin/returns/:id | status lifecycle; COMPLETED creates the Refund record |
| GET /admin/reviews · PATCH /admin/reviews/:id/moderate | moderation |
| GET /admin/contact · PATCH /admin/contact/:id | inbox |
| GET /admin/newsletter/subscribers | confirmed subscribers |
| GET /admin/audit-logs | mutation trail |
