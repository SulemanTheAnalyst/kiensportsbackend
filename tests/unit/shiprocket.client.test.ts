import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { env as originalEnv } from "../../src/config/env";

let env: typeof originalEnv;

const BASE_URL = "https://apiv2.shiprocket.in/v1/external";

describe("Shiprocket API client", () => {
  let authenticateShiprocket: () => Promise<string>;
  let getShiprocketToken: () => Promise<string>;
  let shiprocketRequest: <T>(
    endpoint: string,
    options?: RequestInit,
  ) => Promise<T>;
  let checkShiprocketServiceability: (params: {
    deliveryPincode: string;
    cod: boolean;
  }) => Promise<unknown>;

  const originalConfig = {
    enabled: originalEnv.SHIPROCKET_ENABLED,
    email: originalEnv.SHIPROCKET_EMAIL,
    password: originalEnv.SHIPROCKET_PASSWORD,
    pickupPincode: originalEnv.SHIPROCKET_PICKUP_PINCODE,
    weight: originalEnv.SHIPROCKET_PACKAGE_WEIGHT,
    length: originalEnv.SHIPROCKET_PACKAGE_LENGTH,
    breadth: originalEnv.SHIPROCKET_PACKAGE_BREADTH,
    height: originalEnv.SHIPROCKET_PACKAGE_HEIGHT,
  };

  const mockFetch = vi.fn();

  const jsonResponse = (data: unknown, status = 200) =>
    new Response(JSON.stringify(data), {
      status,
      headers: {
        "Content-Type": "application/json",
      },
    });

  beforeEach(async () => {
    vi.resetModules();

    const configModule = await import("../../src/config/env");
    env = configModule.env;

    vi.stubGlobal("fetch", mockFetch);

    mockFetch.mockReset();

    env.SHIPROCKET_ENABLED = "true";
    env.SHIPROCKET_EMAIL = "test@example.com";
    env.SHIPROCKET_PASSWORD = "test-password";
    env.SHIPROCKET_PICKUP_PINCODE = "800006";
    env.SHIPROCKET_PACKAGE_WEIGHT = 0.5;
    env.SHIPROCKET_PACKAGE_LENGTH = 20;
    env.SHIPROCKET_PACKAGE_BREADTH = 13.5;
    env.SHIPROCKET_PACKAGE_HEIGHT = 20;

    ({
      authenticateShiprocket,
      getShiprocketToken,
      shiprocketRequest,
      checkShiprocketServiceability,
    } = await import("../../src/modules/shipping/shiprocket.client"));
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();

    env.SHIPROCKET_ENABLED = originalConfig.enabled;
    env.SHIPROCKET_EMAIL = originalConfig.email;
    env.SHIPROCKET_PASSWORD = originalConfig.password;
    env.SHIPROCKET_PICKUP_PINCODE = originalConfig.pickupPincode;
    env.SHIPROCKET_PACKAGE_WEIGHT = originalConfig.weight;
    env.SHIPROCKET_PACKAGE_LENGTH = originalConfig.length;
    env.SHIPROCKET_PACKAGE_BREADTH = originalConfig.breadth;
    env.SHIPROCKET_PACKAGE_HEIGHT = originalConfig.height;
  });

  it("authenticates successfully and returns an access token", async () => {
    mockFetch.mockResolvedValueOnce(
      jsonResponse({ token: "shiprocket-token-123" }),
    );

    const token = await authenticateShiprocket();

    expect(token).toBe("shiprocket-token-123");

    expect(mockFetch).toHaveBeenCalledTimes(1);

    expect(mockFetch).toHaveBeenCalledWith(
      `${BASE_URL}/auth/login`,
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({
          "Content-Type": "application/json",
        }),
        body: JSON.stringify({
          email: "test@example.com",
          password: "test-password",
        }),
      }),
    );
  });

  it("rejects authentication when credentials are missing", async () => {
    env.SHIPROCKET_EMAIL = "";

    await expect(authenticateShiprocket()).rejects.toThrow(
      "Shiprocket API credentials are not configured.",
    );

    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("rejects authentication when Shiprocket returns an error", async () => {
    mockFetch.mockResolvedValueOnce(
      jsonResponse(
        {
          message: "Invalid credentials",
        },
        401,
      ),
    );

    await expect(authenticateShiprocket()).rejects.toThrow(
      "Shiprocket authentication failed: Invalid credentials",
    );
  });

  it("rejects authentication when the response is invalid JSON", async () => {
    mockFetch.mockResolvedValueOnce(
      new Response("Invalid JSON", {
        status: 200,
      }),
    );

    await expect(authenticateShiprocket()).rejects.toThrow(
      "Shiprocket authentication returned an invalid response. HTTP 200",
    );
  });

  it("reuses a cached token without authenticating again", async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse({ token: "cached-token" }));

    const first = await getShiprocketToken();
    const second = await getShiprocketToken();

    expect(first).toBe("cached-token");
    expect(second).toBe("cached-token");

    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it("authenticates again after the cached token expires", async () => {
    vi.useFakeTimers();

    vi.setSystemTime(new Date("2026-11-24T12:00:00Z"));

    mockFetch
      .mockResolvedValueOnce(jsonResponse({ token: "old-token" }))
      .mockResolvedValueOnce(jsonResponse({ token: "new-token" }));

    const first = await getShiprocketToken();

    expect(first).toBe("old-token");

    // Client refreshes its token after nine days.
    await vi.advanceTimersByTimeAsync(9 * 24 * 60 * 60 * 1000);

    const second = await getShiprocketToken();

    expect(second).toBe("new-token");
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it("deduplicates simultaneous authentication requests", async () => {
    let resolveAuthentication!: (response: Response) => void;

    mockFetch.mockReturnValueOnce(
      new Promise<Response>((resolve) => {
        resolveAuthentication = resolve;
      }),
    );

    const first = authenticateShiprocket();
    const second = authenticateShiprocket();
    const third = authenticateShiprocket();

    resolveAuthentication(jsonResponse({ token: "shared-token" }));

    const tokens = await Promise.all([first, second, third]);

    expect(tokens).toEqual(["shared-token", "shared-token", "shared-token"]);

    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it("makes an authenticated GET request successfully", async () => {
    mockFetch
      .mockResolvedValueOnce(jsonResponse({ token: "api-token" }))
      .mockResolvedValueOnce(jsonResponse({ success: true }));

    const result = await shiprocketRequest<{ success: boolean }>(
      "/courier/serviceability/",
    );

    expect(result).toEqual({ success: true });

    expect(mockFetch).toHaveBeenCalledTimes(2);

    expect(mockFetch.mock.calls[1][1]).toEqual(
      expect.objectContaining({
        method: "GET",
        headers: expect.objectContaining({
          Authorization: "Bearer api-token",
        }),
      }),
    );
  });

  it("re-authenticates and retries a GET request after HTTP 401", async () => {
    mockFetch
      .mockResolvedValueOnce(jsonResponse({ token: "expired-token" }))
      .mockResolvedValueOnce(jsonResponse({ message: "Unauthorized" }, 401))
      .mockResolvedValueOnce(jsonResponse({ token: "refreshed-token" }))
      .mockResolvedValueOnce(jsonResponse({ success: true }));

    const result = await shiprocketRequest<{ success: boolean }>(
      "/courier/serviceability/",
    );

    expect(result).toEqual({ success: true });

    expect(mockFetch).toHaveBeenCalledTimes(4);

    expect(mockFetch.mock.calls[1][1].headers).toEqual(
      expect.objectContaining({
        Authorization: "Bearer expired-token",
      }),
    );

    expect(mockFetch.mock.calls[3][1].headers).toEqual(
      expect.objectContaining({
        Authorization: "Bearer refreshed-token",
      }),
    );
  });

  it("does not retry POST requests after HTTP 401", async () => {
    mockFetch
      .mockResolvedValueOnce(jsonResponse({ token: "api-token" }))
      .mockResolvedValueOnce(jsonResponse({ message: "Unauthorized" }, 401));

    await expect(
      shiprocketRequest("/orders/create/adhoc", {
        method: "POST",
        body: JSON.stringify({ order_id: 123 }),
      }),
    ).rejects.toThrow("Unauthorized");

    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it("rejects API requests when Shiprocket is disabled", async () => {
    env.SHIPROCKET_ENABLED = "false";

    await expect(shiprocketRequest("/courier/serviceability/")).rejects.toThrow(
      "Shiprocket integration is currently disabled.",
    );

    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("returns the Shiprocket API error message", async () => {
    mockFetch
      .mockResolvedValueOnce(jsonResponse({ token: "api-token" }))
      .mockResolvedValueOnce(
        jsonResponse({ message: "Invalid delivery pincode" }, 422),
      );

    await expect(shiprocketRequest("/courier/serviceability/")).rejects.toThrow(
      "Invalid delivery pincode",
    );
  });

  it("rejects invalid JSON returned by the API", async () => {
    mockFetch
      .mockResolvedValueOnce(jsonResponse({ token: "api-token" }))
      .mockResolvedValueOnce(
        new Response("Not JSON", {
          status: 200,
        }),
      );

    await expect(shiprocketRequest("/courier/serviceability/")).rejects.toThrow(
      "Shiprocket returned an invalid response. HTTP 200",
    );
  });

  it("checks serviceability with the correct pickup and delivery parameters", async () => {
    mockFetch
      .mockResolvedValueOnce(jsonResponse({ token: "serviceability-token" }))
      .mockResolvedValueOnce(
        jsonResponse({
          data: {
            available_courier_companies: [],
          },
        }),
      );

    const result = await checkShiprocketServiceability({
      deliveryPincode: "110001",
      cod: true,
    });

    expect(result).toEqual({
      data: {
        available_courier_companies: [],
      },
    });

    const requestedUrl = new URL(mockFetch.mock.calls[1][0]);

    expect(requestedUrl.pathname).toBe("/v1/external/courier/serviceability/");

    expect(requestedUrl.searchParams.get("pickup_postcode")).toBe("800006");

    expect(requestedUrl.searchParams.get("delivery_postcode")).toBe("110001");

    expect(requestedUrl.searchParams.get("cod")).toBe("1");
    expect(requestedUrl.searchParams.get("weight")).toBe("0.5");
    expect(requestedUrl.searchParams.get("length")).toBe("20");
    expect(requestedUrl.searchParams.get("breadth")).toBe("13.5");
    expect(requestedUrl.searchParams.get("height")).toBe("20");
  });

  it("passes the COD flag as zero for prepaid serviceability checks", async () => {
    mockFetch
      .mockResolvedValueOnce(jsonResponse({ token: "serviceability-token" }))
      .mockResolvedValueOnce(jsonResponse({ data: {} }));

    await checkShiprocketServiceability({
      deliveryPincode: "110001",
      cod: false,
    });

    const requestedUrl = new URL(mockFetch.mock.calls[1][0]);

    expect(requestedUrl.searchParams.get("cod")).toBe("0");
  });

  it("propagates network and timeout errors", async () => {
    mockFetch
      .mockResolvedValueOnce(jsonResponse({ token: "api-token" }))
      .mockRejectedValueOnce(new Error("Network request timed out"));

    await expect(shiprocketRequest("/courier/serviceability/")).rejects.toThrow(
      "Network request timed out",
    );
  });
});
