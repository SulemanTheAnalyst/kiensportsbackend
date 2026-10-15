# KIEN Sports — Resend Email Integration

Transactional email (order, contact, password-reset) and inbound email via
[resend.com](https://resend.com). All code is in `src/modules/email/`.

## What is configured where

| Variable | Required in production | Purpose |
|---|---|---|
| `RESEND_API_KEY` | YES (for any email to be sent) | Resend API key (`re_...`). Server-side only. Never in VITE_*. |
| `RESEND_WEBHOOK_SECRET` | YES (for inbound email) | Svix signing secret (`whsec_...`) shown once when the webhook is created. Not the API key. |
| `EMAIL_FROM` | YES | Authorized sender, e.g. `KIEN Sports <no-reply@kiensports.com>`. |
| `EMAIL_REPLY_TO` | optional | Default Reply-To for transactional email. |
| `SUPPORT_EMAIL` | YES | Receives contact-form notifications and inbound-email alerts. |
| `BUSINESS_NOTIFICATION_EMAIL` | optional | Receives new-order notifications. |
| `FRONTEND_URL` | YES | Used to build password-reset links (`https://kiensports.com`). |

Locally the app boots fine with none of these set — email sending is simply
disabled (logged, and `GET /api/v1/health` reports `email.sendingConfigured:
false`). In production a missing `RESEND_API_KEY` produces a startup warning
and the health flag stays false.

## Emails sent

| Event | Recipient | Trigger point |
|---|---|---|
| Contact notification | `SUPPORT_EMAIL` (Reply-To = customer) | `POST /api/v1/contact` after the message is saved |
| Contact confirmation | customer | same, best-effort |
| Order confirmation | customer (+ `BUSINESS_NOTIFICATION_EMAIL`) | `confirmOrderPayment` **after** the verified Razorpay webhook transaction commits; COD via admin transition to CONFIRMED |
| Shipped | customer | admin `PATCH /admin/shipments/:id` (carrier+tracking included) or transition to SHIPPED |
| Cancelled | customer | admin transition to CANCELLED |
| Refund initiated | customer | admin marks return request COMPLETED |
| Password reset | customer | `POST /auth/password/forgot` (tokens are hashed, single-use, 1h TTL) |

All sends are best-effort and idempotent (markers in OrderStatusEvent).
Resend accepting an email means *accepted for delivery*, not delivered.

## Inbound email (receiving)

Resend delivers a signed `email.received` webhook (Svix signature:
`svix-id`, `svix-timestamp`, `svix-signature`; 5-minute replay window).

Endpoint to register in the Resend dashboard
(**Dashboard → Webhooks → Add Webhook**, events: `email.received`):

- Production: `https://api.kiensports.com/api/v1/webhooks/resend/inbound`
- Local dev: `https://<ngrok-tunnel>/api/v1/webhooks/resend/inbound`

The `signing_secret` (`whsec_...`) is shown **once** on creation — put it in
`RESEND_WEBHOOK_SECRET`. Do NOT create the production webhook via an API key
from code; register it in the dashboard and store the secret.

The webhook payload is metadata-only (sender, recipient, subject, attachment
names). The backend stores metadata in the `InboundEmail` table (unique on
Resend's `email_id`, so duplicate deliveries are no-ops), then fetches the
body via the Receiving API in the background (truncated to 20k chars,
attachment payloads never stored) and optionally notifies `SUPPORT_EMAIL`.

### Inbound domain / MX (IMPORTANT)

Google Workspace appears to handle mail for `kiensports.com` (support@…).
Do NOT change root-domain MX records. Configure Resend inbound on a dedicated
subdomain, e.g. `inbound.kiensports.com`:

- Add MX record for the subdomain with the value the Resend dashboard shows
  (Resend → Emails → Receiving → custom domain), priority 10.
- Root-domain mail keeps flowing to Google Workspace untouched.

## Sending domain verification (DNS)

1. Resend dashboard → Domains → Add Domain → `kiensports.com`.
2. Copy the records the dashboard shows (typically DKIM TXT/CNAME, SPF TXT,
   and a verification TXT) into your DNS provider exactly as displayed —
   do not use values from any documentation, only from your dashboard.
3. SPF: if a TXT record starting `v=spf1` already exists for
   `kiensports.com` (e.g. Google Workspace `include:_spf.google.com`),
   MERGE includes into that single record instead of adding a second
   `v=spf1` record (two SPF records = SPF failure).
4. Practical meaning: SPF = which servers may send as the domain;
   DKIM = cryptographic proof the content is unmodified;
   DMARC = policy for spoofed mail (start at `p=none` with reporting, then
   tighten). Resend shows the exact records; verify status in the dashboard.
5. Once verified, sender addresses like `no-reply@kiensports.com` and
   `support@kiensports.com` can be used in `EMAIL_FROM`.

## Render deployment

Add the variables above in the Render backend service → Environment.
Never place `RESEND_API_KEY` or `RESEND_WEBHOOK_SECRET` in the frontend.
Apply the database migration (`npm run db:deploy`) once after merging.

## Database migration

`prisma/migrations/20261015120000_add_inbound_email/migration.sql`
adds the `InboundEmail` table (additive; no existing data is touched).

## Testing

- Unit: `npm test -- tests/unit/svixVerify.test.ts tests/unit/emailService.test.ts tests/unit/emailTemplates.test.ts`
- API: `npm test -- tests/api/resendInbound.test.ts` (needs Postgres)
- No automated test sends real email (the Resend SDK is mocked / unconfigured).

To test sending end-to-end after DNS verification, set `RESEND_API_KEY` and
send yourself a contact form submission from https://kiensports.com/contact.
To test inbound, email the configured inbound address and watch the logs for
`Inbound email received`; verify the row in `InboundEmail`.
