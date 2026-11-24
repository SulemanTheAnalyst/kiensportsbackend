import { Router, Request, Response } from "express";
import { z } from "zod";
import { prisma } from "../../lib/prisma";
import { notFound, conflict } from "../../lib/errors";
import { validate } from "../../middleware/validate";
import { requireAuth, requireRole } from "../../middleware/auth";
import { notifyOrderShipped } from "../email/order.emails";
import { env } from "../../config/env";
import { checkShiprocketServiceability } from "./shiprocket.client";
import { prepareShiprocketShipment } from "./shiprocket.fulfilment";

// Shipping is stored as data; carrier integration is a future provider
// implementation (Shiprocket/Delhivery/etc.) and plugs into Shipment records.

export const shippingRouter = Router();

// Customer-facing tracking by order number (owner-scoped).
shippingRouter.get(
  "/track/:orderNumber",
  requireAuth,
  validate({ params: z.object({ orderNumber: z.string().min(6).max(40) }) }),
  async (req: Request, res: Response) => {
    const order = await prisma.order.findUnique({
      where: { orderNumber: String(req.params.orderNumber) },
      include: { shipments: true },
    });
    if (!order || order.userId !== req.user!.sub)
      throw notFound("Shipment not found");
    res.json({
      data: order.shipments.map((s) => ({
        carrier: s.carrier,
        trackingNumber: s.trackingNumber,
        status: s.status,
        shippedAt: s.shippedAt,
        deliveredAt: s.deliveredAt,
      })),
    });
  },
);

export const adminShippingRouter = Router();
adminShippingRouter.use(requireAuth, requireRole("ADMIN"));

adminShippingRouter.patch(
  "/shipments/:id",
  validate({
    params: z.object({ id: z.string().min(10).max(40) }),
    body: z.object({
      carrier: z.string().max(80).optional(),
      trackingNumber: z.string().max(80).optional(),
      status: z
        .enum([
          "PENDING",
          "IN_TRANSIT",
          "OUT_FOR_DELIVERY",
          "DELIVERED",
          "EXCEPTION",
        ])
        .optional(),
    }),
  }),
  async (req: Request, res: Response) => {
    const shipment = await prisma.shipment.findUnique({
      where: { id: String(req.params.id) },
      select: { id: true, orderId: true },
    });

    if (!shipment) throw notFound("Shipment not found");

    const { carrier, trackingNumber, status } = req.body;

    const result = await prisma.$transaction(async (tx) => {
      // Serialize manual updates against Shiprocket preparation.
      await tx.$queryRaw`
        SELECT id FROM "Order"
        WHERE id = ${shipment.orderId}
        FOR UPDATE
      `;

      // Re-read after acquiring the lock. Never trust the earlier
      // provider value because another request may have changed it.
      const current = await tx.shipment.findUnique({
        where: { id: shipment.id },
        include: { order: true },
      });

      if (!current) throw notFound("Shipment not found");

      if (current.provider !== null) {
        throw conflict(
          "SHIPMENT_PROVIDER_MANAGED",
          "This shipment is managed by its assigned shipping provider.",
        );
      }

      const updated = await tx.shipment.update({
        where: { id: current.id },
        data: {
          carrier,
          trackingNumber,
          status,
          shippedAt:
            status && status !== "PENDING" && !current.shippedAt
              ? new Date()
              : undefined,
          deliveredAt: status === "DELIVERED" ? new Date() : undefined,
        },
      });

      if (status === "DELIVERED") {
        await tx.order.update({
          where: { id: current.orderId },
          data: { status: "DELIVERED" },
        });

        await tx.orderStatusEvent.create({
          data: {
            orderId: current.orderId,
            fromStatus: current.order.status,
            toStatus: "DELIVERED",
            actorId: req.user!.sub,
          },
        });
      } else if (status === "IN_TRANSIT" || status === "OUT_FOR_DELIVERY") {
        await tx.order.update({
          where: { id: current.orderId },
          data: { status: "SHIPPED" },
        });

        await tx.orderStatusEvent.create({
          data: {
            orderId: current.orderId,
            fromStatus: current.order.status,
            toStatus: "SHIPPED",
            actorId: req.user!.sub,
          },
        });
      }

      return {
        shipment: updated,
        orderNumber: current.order.orderNumber,
      };
    });

    if (status === "IN_TRANSIT" || status === "OUT_FOR_DELIVERY") {
      notifyOrderShipped(result.orderNumber);
    }

    res.json({ data: result.shipment });
  },
);

// Check Shiprocket courier availability and rates.
adminShippingRouter.get(
  "/shipping/serviceability",
  validate({
    query: z.object({
      deliveryPincode: z
        .string()
        .regex(/^\d{6}$/, "Enter a valid 6-digit delivery PIN code"),
      cod: z.enum(["true", "false"]).default("false"),
    }),
  }),
  async (req: Request, res: Response) => {
    if (env.SHIPROCKET_ENABLED !== "true") {
      return res.status(503).json({
        message: "Shiprocket integration is currently disabled.",
      });
    }

    const { deliveryPincode, cod } = req.query as {
      deliveryPincode: string;
      cod: "true" | "false";
    };

    const result = await checkShiprocketServiceability({
      deliveryPincode,
      cod: cod === "true",
    });

    res.json({
      data: result,
      package: {
        weightKg: env.SHIPROCKET_PACKAGE_WEIGHT,
        lengthCm: env.SHIPROCKET_PACKAGE_LENGTH,
        breadthCm: env.SHIPROCKET_PACKAGE_BREADTH,
        heightCm: env.SHIPROCKET_PACKAGE_HEIGHT,
        provisional: true,
      },
    });
  },
);

// Prepare an order for Shiprocket locally. This deliberately does not create
// an external Shiprocket order; that must remain a separate explicit action.
adminShippingRouter.post(
  "/shipping/orders/:orderNumber/shiprocket/prepare",
  validate({
    params: z.object({ orderNumber: z.string().min(6).max(40) }),
  }),
  async (req: Request, res: Response) => {
    const result = await prepareShiprocketShipment(
      String(req.params.orderNumber),
      req.user!.sub,
      req.ip,
    );
    res.json({ data: result });
  },
);
