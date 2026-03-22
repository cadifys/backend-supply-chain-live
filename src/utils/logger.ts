import winston from 'winston';
import { env } from '../config/env';

export const logger = winston.createLogger({
  level: env.logLevel,
  format: winston.format.combine(
    winston.format.timestamp(),
    env.isDev
      ? winston.format.colorize()
      : winston.format.json(),
    env.isDev
      ? winston.format.printf(({ timestamp, level, message, ...meta }) => {
          const metaStr = Object.keys(meta).length ? ` ${JSON.stringify(meta)}` : '';
          return `${timestamp} [${level}] ${message}${metaStr}`;
        })
      : winston.format.json()
  ),
  transports: [new winston.transports.Console()],
});
