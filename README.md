# KIEN Sports Backend

Production foundation for the KIEN Sports Private Limited e-commerce website.
Serves the catalog, cart, checkout, accounts, orders, payments (provider-agnostic),
shipping, returns, reviews, newsletter, contact and admin APIs behind the
existing React frontend (`SulemanTheAnalyst/Kien-sports`).

**Stack:** Node.js 20 · Express 5 · TypeScript · PostgreSQL · Prisma · Zod · JWT (access + rotating refresh) · Pino · Vitest/Supertest

## Quick start

```bash
# 1. Dependencies
npm install

# 2. Environment
cp .env.example .env          # fill in real values; never commit .env

# 3. Database (local Postgres via Docker)
docker compose up -d db

# 4. Migrations (first run creates the initial migration)
npx prisma migrate dev --name init

# 5. Seed the real KIEN catalog (3 products, 12 categories, collections, admin user)
npm run db:seed              # set ADMIN_EMAIL / ADMIN_PASSWORD in .env first

# 6. Run
npm run dev                 # http://localhost:3000/api/v1
```

## Verify

```bash
curl http://localhost:3000/api/v1/health
curl http://localhost:3000/api/v1/products | jq '.data.total'   # -> 3
npm run typecheck && npm run build
npm test                      # unit tests run standalone; API tests need the seeded DB
```

With everything running, the full mock checkout flow works end-to-end:

```bash
# cart
curl -c jar -X POST localhost:3000/api/v1/cart/items \
  -H 'Content-Type: application/json' \
  -d '{"variantId":"<id from /products response>","quantity":1}'
# order (guest checkout with mock provider)
curl -b jar -c jar -X POST localhost:3000/api/v1/orders \
  -H 'Content-Type: application/json' \
  -d '{"email":"buyer@example.com","address":{"firstName":"A","lastName":"B","line1":"123 Street","city":"Patna","state":"Bihar","pincode":"800006","phone":"9876543210"},"paymentMethod":"UPI"}'
# simulate payment (development only, PAYMENT_PROVIDER=mock)
curl -X POST localhost:3000/api/v1/payments/mock/pay -H 'Content-Type: application/json' \
  -d '{"providerOrderId":"...","paymentId":"...","payToken":"..."}'   # values from the order response
```

## Docs

- [docs/API.md](docs/API.md) — full API contract (method, auth, request, response, errors)
- [docs/FRONTEND_INTEGRATION.md](docs/FRONTEND_INTEGRATION.md) — every frontend change needed to go live
- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) — architecture decisions and security model

## Key design decisions

| Decision | Choice | Why |
|---|---|---|
| Money | Stored as integer paise; API returns integer rupees | Exact math internally; drop-in match to the frontend's `price: 4999` |
| Cart | Server-side, bound to an httpOnly `kien_cart` cookie, merges into the account on login | Frontend cart is lost on refresh; this fixes it without redesign |
| Prices | Always re-resolved from the DB on cart read and order creation | Never trusts client prices |
| Orders | Immutable with per-item price/name/SKU snapshots | Historical accuracy |
| Inventory | `available/reserved/sold` + append-only movements, row-level locks at checkout | Prevents overselling |
| Payments | `PaymentGateway` interface; Razorpay driver + sandbox Mock driver; only HMAC-verified webhooks mark orders paid | Provider not finally chosen; secrets stay server-side |
| Admin | Role-based (CUSTOMER/ADMIN) + audit log on every mutation | Safe to attach a dashboard later |
| Auth | Short-lived access JWT + rotating refresh token (hashed, reuse-detection) | Stateless API for the SPA; revocable sessions |

## Security

- Argon/bcrypt password hashing (bcryptjs, cost 12), lockout after 5 failed logins
- Zod validation on every body/query/param; Prisma parameterization (no SQL injection)
- Strict CORS allow-list, Helmet headers, rate limits on auth/checkout/contact/search
- Webhooks verified with HMAC-SHA256; amount cross-checked against the payment record
- Generic public errors; details only in server-side structured logs (redacted)
- `.env` git-ignored; `.env.example` documents every variable

## Deployment

Single Node service + managed Postgres (Neon / RDS / Railway / Render):

```bash
docker build -t kien-api .
docker run -e DATABASE_URL=... -e JWT_ACCESS_SECRET=... ... kien-api
# or on a PaaS: set env vars, run `npx prisma migrate deploy` as release step, then start
```

Requirements for production: `NODE_ENV=production`, a real `PAYMENT_PROVIDER` (the mock
refuses to boot in production), `CORS_ORIGIN` set to the live KIEN domain, HTTPS
termination in front, and secrets from the platform's secret store.
