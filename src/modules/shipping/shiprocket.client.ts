import { env } from "../../config/env";

const SHIPROCKET_BASE_URL = "https://apiv2.shiprocket.in/v1/external";

interface ShiprocketAuthResponse {
  token?: string;
  message?: string;
}

interface ShiprocketErrorResponse {
  message?: string;
  errors?: unknown;
}

interface CachedToken {
  value: string;
  expiresAt: number;
}

let cachedToken: CachedToken | null = null;
let authInFlight: Promise<string> | null = null;

// Authenticate using the dedicated Shiprocket API user.
const performShiprocketAuthentication = async (): Promise<string> => {
  if (!env.SHIPROCKET_EMAIL || !env.SHIPROCKET_PASSWORD) {
    throw new Error("Shiprocket API credentials are not configured.");
  }

  const response = await fetch(`${SHIPROCKET_BASE_URL}/auth/login`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify({
      email: env.SHIPROCKET_EMAIL,
      password: env.SHIPROCKET_PASSWORD,
    }),
    signal: AbortSignal.timeout(15000),
  });

  let data: ShiprocketAuthResponse;

  try {
    data = (await response.json()) as ShiprocketAuthResponse;
  } catch {
    throw new Error(
      `Shiprocket authentication returned an invalid response. HTTP ${response.status}`,
    );
  }

  if (!response.ok || !data.token) {
    throw new Error(
      `Shiprocket authentication failed: ${
        data.message ?? `HTTP ${response.status}`
      }`,
    );
  }

  // Shiprocket tokens have a 10-day validity.
  // Refresh after 9 days to avoid using an expired token.
  cachedToken = {
    value: data.token,
    expiresAt: Date.now() + 9 * 24 * 60 * 60 * 1000,
  };

  return data.token;
};

export const authenticateShiprocket = async (): Promise<string> => {
  if (authInFlight) return authInFlight;
  authInFlight = performShiprocketAuthentication().finally(() => {
    authInFlight = null;
  });
  return authInFlight;
};

// Return the cached token or authenticate again.
export const getShiprocketToken = async (): Promise<string> => {
  if (cachedToken && Date.now() < cachedToken.expiresAt) {
    return cachedToken.value;
  }

  return authenticateShiprocket();
};

// Centralized authenticated API request handler.
export const shiprocketRequest = async <T>(
  endpoint: string,
  options: RequestInit = {},
): Promise<T> => {
  if (env.SHIPROCKET_ENABLED !== "true") {
    throw new Error("Shiprocket integration is currently disabled.");
  }

  const method = (options.method ?? "GET").toUpperCase();

  const makeRequest = async (token: string) =>
    fetch(`${SHIPROCKET_BASE_URL}${endpoint}`, {
      ...options,
      method,
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
        ...options.headers,
        Authorization: `Bearer ${token}`,
      },
      signal: options.signal ?? AbortSignal.timeout(20000),
    });

  let token = await getShiprocketToken();
  let response = await makeRequest(token);

  // Retry only safe, read-only requests after an authentication failure.
  if (response.status === 401 && ["GET", "HEAD"].includes(method)) {
    // Clear the cached token only if it is still the token used
    // by this request. Another request may already have refreshed it.
    if (cachedToken?.value === token) {
      cachedToken = null;
    }

    token = await getShiprocketToken();
    response = await makeRequest(token);
  }

  const responseText = await response.text();

  let data: unknown = null;

  try {
    data = responseText ? JSON.parse(responseText) : null;
  } catch {
    throw new Error(
      `Shiprocket returned an invalid response. HTTP ${response.status}`,
    );
  }

  if (!response.ok) {
    const message =
      data &&
      typeof data === "object" &&
      "message" in data &&
      typeof data.message === "string"
        ? data.message
        : `Shiprocket request failed. HTTP ${response.status}`;

    throw new Error(message);
  }

  return data as T;
};

// Check courier availability and shipping rates.
// This is a read-only Shiprocket API operation.
export const checkShiprocketServiceability = async (params: {
  deliveryPincode: string;
  cod: boolean;
}) => {
  const query = new URLSearchParams({
    pickup_postcode: env.SHIPROCKET_PICKUP_PINCODE,
    delivery_postcode: params.deliveryPincode,
    cod: params.cod ? "1" : "0",
    weight: String(env.SHIPROCKET_PACKAGE_WEIGHT),
    length: String(env.SHIPROCKET_PACKAGE_LENGTH),
    breadth: String(env.SHIPROCKET_PACKAGE_BREADTH),
    height: String(env.SHIPROCKET_PACKAGE_HEIGHT),
  });

  return shiprocketRequest<unknown>(
    `/courier/serviceability/?${query.toString()}`,
    {
      method: "GET",
    },
  );
};
