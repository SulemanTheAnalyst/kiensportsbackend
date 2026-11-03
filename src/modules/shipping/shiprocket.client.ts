import { env } from '../../config/env';

const SHIPROCKET_BASE_URL =
  'https://apiv2.shiprocket.in/v1/external';

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

// Authenticate using the dedicated Shiprocket API user.
export const authenticateShiprocket = async (): Promise<string> => {
  if (!env.SHIPROCKET_EMAIL || !env.SHIPROCKET_PASSWORD) {
    throw new Error('Shiprocket API credentials are not configured.');
  }

  const response = await fetch(
    `${SHIPROCKET_BASE_URL}/auth/login`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify({
        email: env.SHIPROCKET_EMAIL,
        password: env.SHIPROCKET_PASSWORD,
      }),
      signal: AbortSignal.timeout(15000),
    },
  );

  const data = (await response.json()) as ShiprocketAuthResponse;

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
  if (env.SHIPROCKET_ENABLED !== 'true') {
    throw new Error('Shiprocket integration is currently disabled.');
  }

  const token = await getShiprocketToken();

  const response = await fetch(
    `${SHIPROCKET_BASE_URL}${endpoint}`,
    {
      ...options,
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
        ...options.headers,
        Authorization: `Bearer ${token}`,
      },
      signal: options.signal ?? AbortSignal.timeout(20000),
    },
  );

  const responseText = await response.text();

  let data: unknown;

  try {
    data = responseText ? JSON.parse(responseText) : null;
  } catch {
    throw new Error('Shiprocket returned an invalid response.');
  }

  // If the token is rejected, authenticate once more and retry.
  if (response.status === 401) {
    cachedToken = null;

    const refreshedToken = await authenticateShiprocket();

    const retryResponse = await fetch(
      `${SHIPROCKET_BASE_URL}${endpoint}`,
      {
        ...options,
        headers: {
          Accept: 'application/json',
          'Content-Type': 'application/json',
          ...options.headers,
          Authorization: `Bearer ${refreshedToken}`,
        },
        signal: options.signal ?? AbortSignal.timeout(20000),
      },
    );

    const retryText = await retryResponse.text();

    let retryData: unknown;

    try {
      retryData = retryText ? JSON.parse(retryText) : null;
    } catch {
      throw new Error('Shiprocket returned an invalid retry response.');
    }

    if (!retryResponse.ok) {
      const error = retryData as ShiprocketErrorResponse;

      throw new Error(
        error.message ?? `Shiprocket API error: HTTP ${retryResponse.status}`,
      );
    }

    return retryData as T;
  }

  if (!response.ok) {
    const error = data as ShiprocketErrorResponse;

    throw new Error(
      error.message ?? `Shiprocket API error: HTTP ${response.status}`,
    );
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
    cod: params.cod ? '1' : '0',
    weight: String(env.SHIPROCKET_PACKAGE_WEIGHT),
    length: String(env.SHIPROCKET_PACKAGE_LENGTH),
    breadth: String(env.SHIPROCKET_PACKAGE_BREADTH),
    height: String(env.SHIPROCKET_PACKAGE_HEIGHT),
  });

  return shiprocketRequest<unknown>(
    `/courier/serviceability/?${query.toString()}`,
    {
      method: 'GET',
    },
  );
};
