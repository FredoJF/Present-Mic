import pino from 'pino';

import { env } from '../config/env.js';

const errorSerializer = (value: unknown): unknown => {
  if (value instanceof Error) {
    return pino.stdSerializers.err(value);
  }

  return value;
};

export const logger = pino({
  level: env.LOG_LEVEL,
  serializers: {
    error: errorSerializer,
    err: errorSerializer
  },
  ...(process.env.NODE_ENV === 'production'
    ? {}
    : {
        transport: {
          target: 'pino-pretty',
          options: {
            colorize: true,
            translateTime: 'SYS:standard'
          }
        }
      })
});
