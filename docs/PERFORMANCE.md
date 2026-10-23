# Performance: findings, fixes and how to measure

This document records the investigation behind the "10-15 second delays on
nearly every customer action" report, what was changed, and how to verify
the results with real numbers.

## 1. What was measured / could not be measured

The investigation was performed by reading the full request lifecycle in
both repositories (frontend hooks/context, backend middleware, services,
Prisma queries, transaction boundaries) plus the deployment topology
(Render web services + Neon Postgres).

Direct production timings could not be captured from the development
environment used for this work (no browser DevTools, no network shell).
What IS known:

- Warm-path code review found no per-request operation that explains
  10-15s: queries are single-round-trip with includes, settings are cached
  (5s), emails/notifications are fire-and-forget via a durable outbox,
  order creation runs one transaction with row locks.
- The uniform ~10-15s delay across ALL actions (homepage, product pages,
  cart, coupon, checkout, payment) is the signature of **service cold
  starts**, not of any single slow query. Render's free tier spins a web
  service down after ~15 minutes without traffic; waking it takes
  roughly 10-15 seconds (boot + Prisma client + first Neon connection).
  A low-traffic store hits a cold start on nearly every visitor arrival.
- The backend request-timing middleware added in this branch
  (`src/middleware/requestTiming.ts`) logs method/path/status/duration for
  every request (warn at >= 500 ms). After deploy, the Render log stream
  provides the real before/after evidence: warm requests should show
  tens-to-hundreds of ms, and the first request after an idle period shows
  the boot cost.
- The keep-warm workflow (`.github/workflows/keep-warm.yml`) prints
  `time_total` for each ping, giving a continuous, timestamped latency
  history in its Actions logs.

## 2. Root causes identified

| # | Cause | Impact | Fix |
|---|---|---|---|
| 1 | Render free-tier spin-down (backend web service sleeps after ~15 min idle; wake-up ~10-15s). Compounded by Neon compute suspend for the first DB connection. | Nearly every action "takes 10-15s" when the store has low traffic, because each new visitor arrives at a sleeping service. | `keep-warm.yml` pings `/health` + the site every 10 min (below the idle threshold). Free; no code or hosting change. |
| 2 | Single large JS bundle: admin studio, checkout, account and every page were imported eagerly, so first paint downloaded the entire app. | Slow first load, especially on mobile networks in India. | Route-level `React.lazy` code splitting (App.tsx): first visit now downloads only the storefront; admin/checkout/account load on demand. |
| 3 | Razorpay `checkout.js` downloaded only when the customer clicks Pay. | Multi-second pause between clicking Pay and the payment window opening on slow connections. | The script is warmed as soon as the customer reaches the payment step (CheckoutPage). |
| 4 | First add-to-cart of a variant awaited the cart-activity notification bookkeeping (settings read + variant lookup + outbox insert). | 2-3 extra DB round trips inside the customer-facing response. | Notification is now recorded out-of-band (`void notifyCartAdd(...)`); the outbox still guarantees delivery and retries. |
| 5 | No per-request duration logging. | Impossible to distinguish cold starts from slow queries after deploy. | `requestTiming` middleware (logs every request; warns at >= 500 ms). |

Deliberately NOT changed (checked and found not to be problems, or unsafe
to "optimize"):

- `optionalAuth` does one user lookup per authenticated request - correct
  behaviour (it verifies the account is still active) and negligible next to
  a cold start.
- Order creation's row locks (`SELECT ... FOR UPDATE`) and the coupon
  re-validation inside the transaction are inventory/coupon integrity
  guarantees - they are not a latency problem at this scale and must stay.
- No indexes were added: the hot queries already hit primary keys/unique
  constraints; there is no measured slow query to justify new ones.
- No caching layer was added: settings are already cached in-process (5s)
  and traffic does not justify more complexity.

## 3. Remaining factors outside the code

- **Neon free-tier compute suspend**: the first DB connection after a long
  idle period can add a few seconds. The keep-warm pings largely avoid this
  too. If it persists, use the Neon *pooled* connection string
  (`-pooler` host) for `DATABASE_URL` on Render (recommended by Neon for
  serverless-style workloads) - a dashboard/env change, not a code change.
- **Image weight**: the header logo PNG (`kien-full-white.png`) is ~105 KB
  and product media come from external URLs (Cloudinary or similar).
  Consider generating smaller variants (WebP, 2x/1x) for the logo and hero
  imagery. No image was altered in this change (binary assets cannot be
  regenerated reliably in this environment without risking brand
  distortion).
- **Render plan**: if the store outgrows free tier, the paid "instance
  always on" tier removes cold starts entirely - but the keep-warm approach
  addresses the symptom at zero cost first.

## 4. How to verify (acceptance test)

1. After deploy, open Render -> backend service -> Logs. Requests now show
   `{"method":"GET","path":"/api/v1/products","status":200,"ms":87}` style
   entries. Anything >= 500 ms is a `warn` with `Slow request`.
2. Compare a request right after an idle period vs a warm one - the delta
   is the cold-start cost, now avoided by the keep-warm cron.
3. In the GitHub Actions run history of "Keep services warm", each run shows
   `status=200 time_total=0.4s`-style lines; if a run ever shows a large
   `time_total`, the service had gone to sleep (e.g. workflow paused).
4. In browser DevTools (Network): the initial JS transfer for the homepage
   should now be visibly smaller (admin/checkout/account chunks no longer
   load up front); product/checkout pages fetch a small extra chunk on
   first navigation only.
