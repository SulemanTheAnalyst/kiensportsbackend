import pino from 'pino';
import { isProd } from '../config/env';

export const logger = pino({
  level: process.env.LOG_LEVEL || (isProd ? 'info' : 'debug'),
  redact: {
    paths: [
      'req.headers.authorization',
      'req.headers.cookie',
      'password',
      'passwordHash',
      '*.password',
      '*.passwordHash',
      '*.token',
      '*.refreshToken',
      'webhookRaw',
    ],
    censor: '[REDACTED]',
  },
  transport: isProd ? undefined : { target: 'pino-pretty' },
});
