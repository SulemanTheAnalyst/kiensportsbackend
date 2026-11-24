import { Prisma } from "@prisma/client";
import { env } from "../../config/env";
import { badRequest, conflict, notFound } from "../../lib/errors";
import { prisma } from "../../lib/prisma";

type AddressSnapshot = {
  firstName: string;
  lastName: string;
  line1: string;
  line2?: string;
  city: string;
  state: string;
  pincode: string;
  phone: string;
};

const readAddress = (value: Prisma.JsonValue): AddressSnapshot => {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw badRequest("Order shipping address is incomplete.");
  }
  const a = value as Record<string, Prisma.JsonValue>;
  const required = [
    "firstName",
    "lastName",
    "line1",
    "city",
    "state",
    "pincode",
    "phone",
  ];
  for (const key of required) {
    if (typeof a[key] !== "string" || !(a[key] as string).trim()) {
      throw badRequest("Order shipping address is missing " + key + ".");
    }
  }
  const pincode = String(a.pincode).trim();
  const rawPhone = String(a.phone).replace(/\D/g, "");
  const phone =
    rawPhone.startsWith("91") && rawPhone.length === 12
      ? rawPhone.slice(2)
      : rawPhone;
  if (!/^\d{6}$/.test(pincode))
    throw badRequest("Order has an invalid delivery PIN code.");
  if (!/^[6-9]\d{9}$/.test(phone)) {
    throw badRequest("Order has an invalid Indian contact phone number.");
  }
  return {
    firstName: String(a.firstName).trim(),
    lastName: String(a.lastName).trim(),
    line1: String(a.line1).trim(),
    line2: typeof a.line2 === "string" ? a.line2.trim() : undefined,
    city: String(a.city).trim(),
    state: String(a.state).trim(),
    pincode,
    phone,
  };
};

/**
 * Local-only preparation. This reserves/identifies a local Shipment record
 * for a later explicit Shiprocket create-order action. It never calls
 * Shiprocket, changes payment state, or changes the order lifecycle.
 */
export const prepareShiprocketShipment = async (
  orderNumber: string,
  actorId: string,
  ip?: string,
) => {
  if (env.SHIPROCKET_ENABLED !== "true") {
    throw conflict(
      "SHIPROCKET_DISABLED",
      "Shiprocket integration is disabled.",
    );
  }
  if (!env.SHIPROCKET_PICKUP_LOCATION.trim()) {
    throw badRequest(
      "SHIPROCKET_PICKUP_LOCATION must be set to an exact pickup location configured in Shiprocket.",
    );
  }

  const result = await prisma.$transaction(
    async (tx) => {
      const found = await tx.order.findUnique({
        where: { orderNumber },
        select: { id: true },
      });
      if (!found) throw notFound("Order not found");

      // Serialize duplicate admin requests and payment/fulfilment transitions.
      await tx.$queryRaw`SELECT id FROM "Order" WHERE id = ${found.id} FOR UPDATE`;
      const order = await tx.order.findUniqueOrThrow({
        where: { id: found.id },
        include: { items: true, payments: true, shipments: true },
      });

      if (!["CONFIRMED", "PROCESSING"].includes(order.status)) {
        throw badRequest(
          "Only CONFIRMED or PROCESSING orders can be prepared for Shiprocket.",
        );
      }
      const codPayment = order.payments.find((p) => p.method === "COD");
      const prepaidPaid =
        order.paymentStatus === "PAID" &&
        order.payments.some(
          (payment) =>
            payment.method !== "COD" &&
            payment.status === "CAPTURED" &&
            payment.webhookVerifiedAt !== null,
        );
      const codAllowed =
        !!codPayment &&
        codPayment.status === "COD_PENDING" &&
        order.paymentStatus === "COD_PENDING" &&
        env.COD_ALLOW_DISPATCH_UNPAID === "true";
      if (!prepaidPaid && !codAllowed) {
        throw badRequest(
          codPayment
            ? "COD shipment preparation is blocked by the COD dispatch policy or missing COD payment record."
            : "Prepaid shipment preparation requires a verified PAID order.",
        );
      }
      if (!order.items.length)
        throw badRequest(
          "Cannot prepare a shipment for an order with no items.",
        );

      const address = readAddress(order.shippingAddress);
      const shiprocketShipments = order.shipments.filter(
        (s) => s.provider === "SHIPROCKET",
      );

      const hasShiprocketMetadata = (s: (typeof order.shipments)[number]) =>
        !!(
          s.shiprocketOrderId ||
          s.shiprocketShipmentId ||
          s.shiprocketAwbCode ||
          s.shiprocketCourierId ||
          s.shiprocketCourierName ||
          s.shiprocketLabelUrl ||
          s.shiprocketTrackingUrl ||
          s.shiprocketPickupId ||
          s.shiprocketPickupScheduledAt ||
          s.providerStatus ||
          s.lastTrackingSyncAt
        );

      // Reject manually assigned shipments and shipments belonging to
      // another provider. Also catch Shiprocket metadata without the
      // corresponding provider assignment.
      const conflicting = order.shipments.find(
        (s) =>
          s.provider !== "SHIPROCKET" &&
          (!!s.provider ||
            !!s.carrier ||
            !!s.trackingNumber ||
            hasShiprocketMetadata(s)),
      );

      if (conflicting) {
        throw conflict(
          "SHIPMENT_ALREADY_ASSIGNED",
          "This order already has a manually assigned carrier, tracking number, or another shipping provider.",
        );
      }

      // The first release supports one shipment record per order.
      // Do not silently select one when multiple records exist.
      if (order.shipments.length > 1 || shiprocketShipments.length > 1) {
        throw conflict(
          "SHIPMENT_STATE_AMBIGUOUS",
          "Multiple shipment records exist for this order. Review them before preparing Shiprocket fulfilment.",
        );
      }

      const existingShiprocket = shiprocketShipments[0];

      if (existingShiprocket) {
        return {
          shipment: existingShiprocket,
          orderNumber: order.orderNumber,
          address,
          items: order.items,
          reused: true,
        };
      }

      const untouched = order.shipments.find(
        (s) =>
          !s.provider &&
          !s.carrier &&
          !s.trackingNumber &&
          !hasShiprocketMetadata(s) &&
          !s.shippedAt &&
          !s.deliveredAt &&
          s.status === "PENDING",
      );
      if (order.shipments.length === 1 && !untouched) {
        throw conflict(
          "SHIPMENT_STATE_AMBIGUOUS",
          "An existing shipment record is not eligible for Shiprocket preparation. Review it before proceeding.",
        );
      }

      const shipment = untouched
        ? await tx.shipment.update({
            where: { id: untouched.id },
            data: { provider: "SHIPROCKET" },
          })
        : await tx.shipment.create({
            data: { orderId: order.id, provider: "SHIPROCKET" },
          });
      await tx.auditLog.create({
        data: {
          actorId,
          action: "SHIPROCKET_SHIPMENT_PREPARED",
          entity: "Shipment",
          entityId: shipment.id,
          diff: {
            orderNumber: order.orderNumber,
            provider: "SHIPROCKET",
            localOnly: true,
          },
          ip: ip ?? null,
        },
      });

      return {
        shipment,
        orderNumber: order.orderNumber,
        address,
        items: order.items,
        reused: false,
      };
    },
    { timeout: 15000 },
  );

  return {
    shipment: result.shipment,
    orderNumber: result.orderNumber,
    reused: result.reused,
    shiprocket: {
      pickupLocation: env.SHIPROCKET_PICKUP_LOCATION,
      pickupPincode: env.SHIPROCKET_PICKUP_PINCODE,
      deliveryPincode: result.address.pincode,
      customer: {
        name: [result.address.firstName, result.address.lastName]
          .filter(Boolean)
          .join(" "),
        phone: result.address.phone,
      },
      package: {
        weightKg: env.SHIPROCKET_PACKAGE_WEIGHT,
        lengthCm: env.SHIPROCKET_PACKAGE_LENGTH,
        breadthCm: env.SHIPROCKET_PACKAGE_BREADTH,
        heightCm: env.SHIPROCKET_PACKAGE_HEIGHT,
        provisional: true,
      },
      items: result.items.map((item) => ({
        name: item.productName,
        sku: item.sku,
        quantity: item.quantity,
        unitPricePaise: item.unitPricePaise,
      })),
    },
    nextStep:
      "Shipment is prepared locally. No Shiprocket order has been created.",
  };
};
