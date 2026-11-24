# Shiprocket integration

Shiprocket support is opt-in. Keep `SHIPROCKET_ENABLED=false` until credentials,
pickup configuration, parcel defaults, and the end-to-end workflow have been
verified in a Shiprocket test/low-risk environment.

## Current endpoints

Both endpoints require an authenticated ADMIN user.

- `GET /api/v1/admin/shipping/serviceability?deliveryPincode=800006&cod=false`
  checks courier serviceability and rates using the configured pickup PIN and
  provisional package dimensions. It makes a read-only Shiprocket API request.
- `POST /api/v1/admin/shipping/orders/:orderNumber/shiprocket/prepare`
  prepares a local Shipment record only. It does not create an order in
  Shiprocket, request an AWB, schedule pickup, or change order/payment status.

Preparation is allowed only for `CONFIRMED` or `PROCESSING` orders. Prepaid
orders must have `PAID` payment status and at least one non-COD Payment row
with `CAPTURED` status and a non-null `webhookVerifiedAt` timestamp. COD
orders require a COD Payment row in `COD_PENDING` and
`COD_ALLOW_DISPATCH_UNPAID=true`. Preparation is
idempotent, reuses an untouched local Shipment, and refuses to take over a
manual carrier/tracking assignment or another provider. It locks the Order row
to serialize concurrent preparation requests.

The preparation response includes the customer/order details needed for a
future provider-order request. Parcel dimensions are explicitly marked
provisional and must be checked against the final packed parcel.

## Environment

Set these on the backend only. Never expose Shiprocket credentials to the
frontend.

- `SHIPROCKET_ENABLED=false` by default. Must be `true` to use either endpoint.
- `SHIPROCKET_EMAIL` and `SHIPROCKET_PASSWORD`: dedicated Shiprocket API user.
- `SHIPROCKET_PICKUP_LOCATION`: exact pickup location name configured in the
  Shiprocket account. Preparation refuses to run if this is blank.
- `SHIPROCKET_PICKUP_PINCODE`: pickup PIN code.
- `SHIPROCKET_PACKAGE_WEIGHT`, `SHIPROCKET_PACKAGE_LENGTH`,
  `SHIPROCKET_PACKAGE_BREADTH`, `SHIPROCKET_PACKAGE_HEIGHT`: provisional
  package defaults.
- `SHIPROCKET_WEBHOOK_TOKEN`: reserved for webhook authentication; no webhook
  route is enabled by this change.

## Database

Run `npx prisma migrate deploy` only after reviewing and approving the new
migration in the target environment. Then regenerate the Prisma client as part
of the normal deployment/build process.

## Not implemented yet

This change does not perform Shiprocket order creation, AWB assignment,
label/manifest generation, pickup scheduling, tracking synchronization, or
webhook processing. Those are separate external side-effect actions and need
their own idempotency, state validation, audit logging, and retry rules.
