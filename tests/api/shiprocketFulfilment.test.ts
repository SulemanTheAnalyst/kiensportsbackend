import { beforeAll, afterAll, describe, expect, it, vi } from "vitest";
import request from "supertest";
import { createHmac } from "node:crypto";
import bcrypt from "bcryptjs";

import { env } from "../../src/config/env";

describe("Shiprocket fulfilment preparation", () => {
  let app: any;
  let prisma: any;
  let adminTokenValue: string;
  let cachedCustomer: { email: string; token: string } | undefined;

  const created = {
    orderIds: [] as string[],
    productIds: [] as string[],
    categoryIds: [] as string[],
    userIds: [] as string[],
  };

  const originalConfig = {
    enabled: env.SHIPROCKET_ENABLED,
    pickupLocation: env.SHIPROCKET_PICKUP_LOCATION,
    codAllowed: env.COD_ALLOW_DISPATCH_UNPAID,
  };

  const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

  const uniqueEmail = () =>
    `shiprocket-${stamp}-${Math.random().toString(36).slice(2, 8)}@example.com`;

  async function createAdminToken() {
    const email = uniqueEmail();
    const password = "TestPassword123!";

    const user = await prisma.user.create({
      data: {
        email,
        passwordHash: await bcrypt.hash(password, 4),
        firstName: "Shiprocket",
        lastName: "Admin",
        emailVerifiedAt: new Date(),
        roles: {
          create: {
            role: {
              connect: { name: "ADMIN" },
            },
          },
        },
      },
    });

    created.userIds.push(user.id);

    const login = await request(app)
      .post("/api/v1/auth/login")
      .send({ email, password });

    expect(login.status).toBe(200);

    return login.body.data.accessToken;
  }

  async function createProduct(pricePaise = 199900) {
    const productStamp =
      Date.now().toString(36) + Math.random().toString(36).slice(2, 8);

    const category = await prisma.category.create({
      data: {
        slug: `cat-${productStamp}`,
        name: `Cat ${productStamp}`,
        world: "sport",
        description: "Test category",
      },
    });

    created.categoryIds.push(category.id);

    const product = await prisma.product.create({
      data: {
        slug: `prod-${productStamp}`,
        name: `Prod ${productStamp}`,
        shortDescription: "Test product",
        description: "Shiprocket fulfilment test product",
        categoryId: category.id,
        pricePaise,
        status: "ACTIVE",
        variants: {
          create: {
            sku: `SKU-${productStamp}`,
            colorName: "Black",
            colorHex: "#000000",
            size: "M",
          },
        },
      },
    });

    created.productIds.push(product.id);

    const variant = await prisma.productVariant.findFirstOrThrow({
      where: { productId: product.id },
    });

    await prisma.inventory.create({
      data: {
        variantId: variant.id,
        availableQty: 10,
        reservedQty: 0,
        soldQty: 0,
      },
    });

    return variant.id;
  }

  async function registerCustomer() {
    if (cachedCustomer) {
      return cachedCustomer;
    }

    const email = uniqueEmail();

    const reg = await request(app).post("/api/v1/auth/register").send({
      email,
      password: "Password123",
      firstName: "Test",
      lastName: "Customer",
    });

    expect(reg.status).toBe(201);

    const user = await prisma.user.findUnique({ where: { email } });
    created.userIds.push(user.id);

    cachedCustomer = {
      email,
      token: reg.body.data.accessToken,
    };

    return cachedCustomer;
  }

  async function placeOrder(method: "CARD" | "COD") {
    const customer = await registerCustomer();
    const variantId = await createProduct();

    const agent = request.agent(app);

    const cart = await agent
      .post("/api/v1/cart/items")
      .set("Authorization", `Bearer ${customer.token}`)
      .send({
        variantId,
        quantity: 1,
      });

    expect(cart.status).toBe(201);

    const checkout = await agent
      .post("/api/v1/orders")
      .set("Authorization", `Bearer ${customer.token}`)
      .send({
        email: customer.email,
        address: {
          firstName: "Test",
          lastName: "Customer",
          line1: "1 Test Street",
          city: "Patna",
          state: "Bihar",
          pincode: "800006",
          phone: "9876543210",
        },
        paymentMethod: method,
      });

    expect(checkout.status).toBe(201);

    const orderNumber = checkout.body.data.order.orderNumber;

    const order = await prisma.order.findUnique({
      where: { orderNumber },
      include: { payments: true },
    });

    expect(order).toBeTruthy();
    created.orderIds.push(order.id);

    return { order, orderNumber };
  }

  async function markPrepaidOrderAsPaid(order: any) {
    const payment = order.payments[0];
    expect(payment).toBeTruthy();

    const payload = {
      event: "payment.captured",
      payload: {
        payment: {
          entity: {
            id: `pay_${stamp}`,
            order_id: payment.providerOrderId,
            amount: payment.amountPaise,
            currency: "INR",
            status: "captured",
          },
        },
      },
    };

    const rawBody = JSON.stringify(payload);
    const secret = process.env.PAYMENT_WEBHOOK_SECRET ?? "";

    const signature = createHmac("sha256", secret)
      .update(rawBody)
      .digest("hex");

    const response = await request(app)
      .post("/api/v1/payments/webhook/razorpay")
      .set("Content-Type", "application/json")
      .set("x-razorpay-signature", signature)
      .send(rawBody);

    expect([200, 201]).toContain(response.status);
  }

  async function prepare(orderNumber: string) {
    return request(app)
      .post(`/api/v1/admin/shipping/orders/${orderNumber}/shiprocket/prepare`)
      .set("Authorization", `Bearer ${adminTokenValue}`);
  }

  beforeAll(async () => {
    const prismaModule = await import("../../src/lib/prisma");
    const appModule = await import("../../src/app");

    prisma = prismaModule.prisma;
    app = appModule.createApp();

    env.SHIPROCKET_ENABLED = "true";
    env.SHIPROCKET_PICKUP_LOCATION = "Test Warehouse";
    env.COD_ALLOW_DISPATCH_UNPAID = "true";

    adminTokenValue = await createAdminToken();
  });

  afterAll(async () => {
    vi.restoreAllMocks();

    env.SHIPROCKET_ENABLED = originalConfig.enabled;
    env.SHIPROCKET_PICKUP_LOCATION = originalConfig.pickupLocation;
    env.COD_ALLOW_DISPATCH_UNPAID = originalConfig.codAllowed;

    if (created.orderIds.length) {
      await prisma.order.deleteMany({
        where: { id: { in: created.orderIds } },
      });
    }

    if (created.productIds.length) {
      await prisma.product.deleteMany({
        where: { id: { in: created.productIds } },
      });
    }

    if (created.categoryIds.length) {
      await prisma.category.deleteMany({
        where: { id: { in: created.categoryIds } },
      });
    }

    if (created.userIds.length) {
      await prisma.user.deleteMany({
        where: { id: { in: created.userIds } },
      });
    }

    await prisma.$disconnect();
  });

  it("rejects preparation when Shiprocket is disabled", async () => {
    const { orderNumber } = await placeOrder("COD");

    env.SHIPROCKET_ENABLED = "false";

    const response = await prepare(orderNumber);

    expect(response.status).toBe(409);
    expect(response.body.error?.code).toBe("SHIPROCKET_DISABLED");

    env.SHIPROCKET_ENABLED = "true";
  });

  it("rejects preparation when Shiprocket pickup location is blank", async () => {
    const { order, orderNumber } = await placeOrder("COD");

    const originalPickupLocation = env.SHIPROCKET_PICKUP_LOCATION;

    try {
      env.SHIPROCKET_PICKUP_LOCATION = "";

      const response = await prepare(orderNumber);

      expect(response.status).toBe(400);
      expect(response.body.error.message).toContain(
        "SHIPROCKET_PICKUP_LOCATION",
      );

      const shipments = await prisma.shipment.findMany({
        where: { orderId: order.id },
      });

      expect(shipments).toHaveLength(0);
    } finally {
      env.SHIPROCKET_PICKUP_LOCATION = originalPickupLocation;
    }
  });

  it("prepares a paid prepaid order without creating a duplicate shipment", async () => {
    const { order, orderNumber } = await placeOrder("CARD");

    await markPrepaidOrderAsPaid(order);

    const response = await prepare(orderNumber);

    expect(response.status).toBe(200);
    expect(response.body.data.shipment?.provider).toBe("SHIPROCKET");

    const shipments = await prisma.shipment.findMany({
      where: { orderId: order.id },
    });

    expect(shipments).toHaveLength(1);
    expect(shipments[0].provider).toBe("SHIPROCKET");
  });
  it("rejects a PAID order without a verified captured prepaid payment", async () => {
    const { order, orderNumber } = await placeOrder("CARD");

    // Simulate an incorrectly marked PAID order without verified payment.
    await prisma.order.update({
      where: { id: order.id },
      data: {
        paymentStatus: "PAID",
        status: "CONFIRMED",
      },
    });

    const response = await prepare(orderNumber);

    expect(response.status).toBe(400);
    expect(response.body.error.message).toContain(
      "Prepaid shipment preparation requires a verified PAID order.",
    );

    const shipments = await prisma.shipment.findMany({
      where: { orderId: order.id },
    });

    expect(shipments).toHaveLength(0);
  });

  it("rejects a prepaid order that has not been paid", async () => {
    const { order, orderNumber } = await placeOrder("CARD");

    // Move it to a dispatch-eligible order status while keeping payment unpaid.
    await prisma.order.update({
      where: { id: order.id },
      data: { status: "CONFIRMED" },
    });

    const response = await prepare(orderNumber);

    expect(response.status).toBe(400);
    expect(response.body.shipment).toBeUndefined();
  });

  it("prepares an eligible COD order without changing its COD payment status", async () => {
    const { order, orderNumber } = await placeOrder("COD");

    const response = await prepare(orderNumber);

    expect(response.status).toBe(200);
    expect(response.body.data.shipment?.provider).toBe("SHIPROCKET");

    const updatedOrder = await prisma.order.findUnique({
      where: { id: order.id },
    });

    expect(updatedOrder.paymentStatus).toBe("COD_PENDING");
  });

  it("rejects COD dispatch when the unpaid COD policy is disabled", async () => {
    const { orderNumber } = await placeOrder("COD");

    env.COD_ALLOW_DISPATCH_UNPAID = "false";

    const response = await prepare(orderNumber);

    expect(response.status).toBe(400);

    env.COD_ALLOW_DISPATCH_UNPAID = "true";
  });

  it("rejects an invalid shipping address", async () => {
    const { order, orderNumber } = await placeOrder("COD");

    await prisma.order.update({
      where: { id: order.id },
      data: {
        shippingAddress: {
          firstName: "Test",
          lastName: "Customer",
          line1: "1 Test Street",
          city: "Patna",
          state: "Bihar",
          pincode: "123",
          phone: "9876543210",
        },
      },
    });

    const response = await prepare(orderNumber);

    expect(response.status).toBe(400);
  });

  it("rejects an order that is not eligible for fulfilment", async () => {
    const { order, orderNumber } = await placeOrder("COD");

    await prisma.order.update({
      where: { id: order.id },
      data: {
        status: "CANCELLED",
      },
    });

    const response = await prepare(orderNumber);

    expect(response.status).toBe(400);
    expect(response.body.error.message).toContain(
      "Only CONFIRMED or PROCESSING orders can be prepared",
    );

    const shipments = await prisma.shipment.findMany({
      where: { orderId: order.id },
    });

    expect(shipments).toHaveLength(0);
  });

  it("rejects an invalid Indian mobile number", async () => {
    const { order, orderNumber } = await placeOrder("COD");

    await prisma.order.update({
      where: { id: order.id },
      data: {
        shippingAddress: {
          firstName: "Test",
          lastName: "Customer",
          line1: "1 Test Street",
          city: "Patna",
          state: "Bihar",
          pincode: "800006",
          phone: "+441234567890",
        },
      },
    });

    const response = await prepare(orderNumber);

    expect(response.status).toBe(400);
    expect(response.body.error.message).toContain(
      "invalid Indian contact phone number",
    );

    const shipments = await prisma.shipment.findMany({
      where: { orderId: order.id },
    });

    expect(shipments).toHaveLength(0);
  });

  it("reuses an existing Shiprocket shipment", async () => {
    const { order, orderNumber } = await placeOrder("COD");

    const existing = await prisma.shipment.create({
      data: {
        orderId: order.id,
        provider: "SHIPROCKET",
        shiprocketOrderId: `existing-${stamp}`,
      },
    });

    const response = await prepare(orderNumber);

    expect(response.status).toBe(200);
    expect(response.body.data.reused).toBe(true);

    const shipments = await prisma.shipment.findMany({
      where: { orderId: order.id },
    });

    expect(shipments).toHaveLength(1);
    expect(shipments[0].id).toBe(existing.id);
  });

  it("does not take over a shipment already assigned to a manual carrier", async () => {
    const { order, orderNumber } = await placeOrder("COD");

    await prisma.shipment.create({
      data: {
        orderId: order.id,
        carrier: "Manual Carrier",
        trackingNumber: `MANUAL-${stamp}`,
      },
    });

    const response = await prepare(orderNumber);

    expect(response.status).toBe(409);

    const shipments = await prisma.shipment.findMany({
      where: { orderId: order.id },
    });

    expect(shipments).toHaveLength(1);
    expect(shipments[0].provider).not.toBe("SHIPROCKET");
  });

  it("rejects Shiprocket metadata without a provider assignment", async () => {
    const { order, orderNumber } = await placeOrder("COD");

    await prisma.shipment.create({
      data: {
        orderId: order.id,
        shiprocketOrderId: `orphan-${stamp}`,
        provider: null,
      },
    });

    const response = await prepare(orderNumber);

    expect(response.status).toBe(409);
    expect(response.body.error?.code).toBe("SHIPMENT_ALREADY_ASSIGNED");

    const shipments = await prisma.shipment.findMany({
      where: { orderId: order.id },
    });

    expect(shipments).toHaveLength(1);
    expect(shipments[0].provider).toBeNull();
    expect(shipments[0].shiprocketOrderId).toBe(`orphan-${stamp}`);
  });

  it("does not create duplicate shipments when two preparation requests arrive together", async () => {
    const { order, orderNumber } = await placeOrder("COD");

    const [first, second] = await Promise.all([
      prepare(orderNumber),
      prepare(orderNumber),
    ]);

    expect([200, 200]).toEqual([first.status, second.status]);

    const shipments = await prisma.shipment.findMany({
      where: { orderId: order.id },
    });

    expect(shipments).toHaveLength(1);
    expect(shipments[0].provider).toBe("SHIPROCKET");
  });

  it("does not make an external network request during local preparation", async () => {
    const { orderNumber } = await placeOrder("COD");

    const fetchSpy = vi.spyOn(globalThis, "fetch");

    const response = await prepare(orderNumber);

    expect(response.status).toBe(200);
    const shiprocketCalls = fetchSpy.mock.calls.filter(([url]) =>
      String(url).startsWith("https://apiv2.shiprocket.in/v1/external"),
    );

    expect(shiprocketCalls).toHaveLength(0);

    fetchSpy.mockRestore();
  });
  it("rejects an existing Shiprocket shipment alongside a manual carrier assignment", async () => {
    const { order, orderNumber } = await placeOrder("COD");

    await prisma.shipment.createMany({
      data: [
        {
          orderId: order.id,
          provider: "SHIPROCKET",
          shiprocketOrderId: `sr-${stamp}`,
        },
        {
          orderId: order.id,
          carrier: "Delhivery",
          trackingNumber: `DEL-${stamp}`,
        },
      ],
    });

    const response = await prepare(orderNumber);

    expect(response.status).toBe(409);
    expect(response.body.error?.code).toBe("SHIPMENT_ALREADY_ASSIGNED");
  });

  it("rejects an existing Shiprocket shipment alongside another provider", async () => {
    const { order, orderNumber } = await placeOrder("COD");

    await prisma.shipment.createMany({
      data: [
        {
          orderId: order.id,
          provider: "SHIPROCKET",
          shiprocketOrderId: `sr-${stamp}`,
        },
        {
          orderId: order.id,
          provider: "DELHIVERY",
        },
      ],
    });

    const response = await prepare(orderNumber);

    expect(response.status).toBe(409);
  });

  it("rejects multiple existing Shiprocket shipments", async () => {
    const { order, orderNumber } = await placeOrder("COD");

    await prisma.shipment.createMany({
      data: [
        {
          orderId: order.id,
          provider: "SHIPROCKET",
          shiprocketOrderId: `sr-a-${stamp}`,
        },
        {
          orderId: order.id,
          provider: "SHIPROCKET",
          shiprocketOrderId: `sr-b-${stamp}`,
        },
      ],
    });

    const response = await prepare(orderNumber);

    expect(response.status).toBe(409);
    expect(response.body.error?.code).toBe("SHIPMENT_STATE_AMBIGUOUS");
  });

  it("rejects multiple untouched shipment records", async () => {
    const { order, orderNumber } = await placeOrder("COD");

    await prisma.shipment.createMany({
      data: [{ orderId: order.id }, { orderId: order.id }],
    });

    const response = await prepare(orderNumber);

    expect(response.status).toBe(409);
    expect(response.body.error?.code).toBe("SHIPMENT_STATE_AMBIGUOUS");
  });
  it("rejects manual updates to Shiprocket-managed shipments", async () => {
    const { order } = await placeOrder("COD");

    const shipment = await prisma.shipment.create({
      data: {
        orderId: order.id,
        provider: "SHIPROCKET",
        carrier: "Shiprocket",
        trackingNumber: `SR-${stamp}`,
        status: "PENDING",
      },
    });

    const originalOrderStatus = order.status;

    const response = await request(app)
      .patch(`/api/v1/admin/shipments/${shipment.id}`)
      .set("Authorization", `Bearer ${adminTokenValue}`)
      .send({
        carrier: "Delhivery",
        trackingNumber: `DEL-${stamp}`,
        status: "IN_TRANSIT",
      });

    expect(response.status).toBe(409);
    expect(response.body.error?.code).toBe("SHIPMENT_PROVIDER_MANAGED");

    const updatedShipment = await prisma.shipment.findUnique({
      where: { id: shipment.id },
    });

    const updatedOrder = await prisma.order.findUnique({
      where: { id: order.id },
    });

    expect(updatedShipment.provider).toBe("SHIPROCKET");
    expect(updatedShipment.carrier).toBe("Shiprocket");
    expect(updatedShipment.trackingNumber).toBe(`SR-${stamp}`);
    expect(updatedShipment.status).toBe("PENDING");
    expect(updatedOrder.status).toBe(originalOrderStatus);
  });
  it("allows manual updates to shipments without a provider", async () => {
    const { order } = await placeOrder("COD");

    const shipment = await prisma.shipment.create({
      data: {
        orderId: order.id,
        status: "PENDING",
      },
    });

    const response = await request(app)
      .patch(`/api/v1/admin/shipments/${shipment.id}`)
      .set("Authorization", `Bearer ${adminTokenValue}`)
      .send({
        carrier: "Delhivery",
        trackingNumber: `DEL-${stamp}`,
        status: "EXCEPTION",
      });

    expect(response.status).toBe(200);

    const updatedShipment = await prisma.shipment.findUnique({
      where: { id: shipment.id },
    });

    expect(updatedShipment.provider).toBeNull();
    expect(updatedShipment.carrier).toBe("Delhivery");
    expect(updatedShipment.trackingNumber).toBe(`DEL-${stamp}`);
    expect(updatedShipment.status).toBe("EXCEPTION");
  });
  it("requires admin authentication for manual shipment updates", async () => {
    const { order } = await placeOrder("COD");

    const shipment = await prisma.shipment.create({
      data: {
        orderId: order.id,
        status: "PENDING",
      },
    });

    const response = await request(app)
      .patch(`/api/v1/admin/shipments/${shipment.id}`)
      .send({
        carrier: "Delhivery",
        trackingNumber: `DEL-${stamp}`,
      });

    expect(response.status).toBe(401);
  });
  it("rejects an existing non-pending shipment in an ambiguous state", async () => {
    const { order, orderNumber } = await placeOrder("COD");

    await prisma.shipment.create({
      data: {
        orderId: order.id,
        status: "IN_TRANSIT",
        carrier: null,
        trackingNumber: null,
        provider: null,
      },
    });

    const response = await prepare(orderNumber);

    expect(response.status).toBe(409);
    expect(response.body.error?.code).toBe("SHIPMENT_STATE_AMBIGUOUS");

    const shipments = await prisma.shipment.findMany({
      where: { orderId: order.id },
    });

    expect(shipments).toHaveLength(1);
    expect(shipments[0].status).toBe("IN_TRANSIT");
    expect(shipments[0].provider).toBeNull();
  });
});
