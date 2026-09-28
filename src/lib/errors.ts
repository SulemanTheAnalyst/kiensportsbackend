// Central API error type. Handlers throw these; the error middleware
// serializes them into the public error envelope and never leaks internals.

export class ApiError extends Error {
  constructor(
    public statusCode: number,
    public code: string,
    message: string,
    public details?: unknown,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

export const badRequest = (msg: string, details?: unknown) =>
  new ApiError(400, 'VALIDATION_ERROR', msg, details);
export const unauthorized = (msg = 'Authentication required') =>
  new ApiError(401, 'UNAUTHENTICATED', msg);
export const forbidden = (msg = 'You do not have permission to do this') =>
  new ApiError(403, 'FORBIDDEN', msg);
export const notFound = (msg = 'Resource not found') =>
  new ApiError(404, 'NOT_FOUND', msg);
export const conflict = (code: string, msg: string) =>
  new ApiError(409, code, msg);
export const outOfStock = (sku: string, requested: number, available: number) =>
  new ApiError(409, 'OUT_OF_STOCK', 'Not enough stock for SKU ' + sku, {
    sku,
    requested,
    available,
  });
export const tooMany = (msg = 'Too many requests, slow down') =>
  new ApiError(429, 'RATE_LIMITED', msg);
