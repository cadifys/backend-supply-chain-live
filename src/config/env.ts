import dotenv from 'dotenv';
dotenv.config();

function required(key: string): string {
  const value = process.env[key];
  if (!value) throw new Error(`Missing required environment variable: ${key}`);
  return value;
}

function optional(key: string, defaultValue: string): string {
  return process.env[key] || defaultValue;
}

export const env = {
  nodeEnv: optional('NODE_ENV', 'development'),
  port: parseInt(optional('PORT', '4000'), 10),

  db: {
    host: optional('CENTRAL_DB_HOST', 'localhost'),
    port: parseInt(optional('CENTRAL_DB_PORT', '5432'), 10),
    name: optional('CENTRAL_DB_NAME', 'manufacturing_hub'),
    user: optional('CENTRAL_DB_USER', 'postgres'),
    password: optional('CENTRAL_DB_PASSWORD', 'postgres'),
  },

  jwt: {
    secret: optional('JWT_SECRET', 'dev_secret_change_in_production_min_32chars'),
    expiresIn: optional('JWT_EXPIRES_IN', '7d'),
    refreshExpiresIn: optional('JWT_REFRESH_EXPIRES_IN', '30d'),
  },

  allowedOrigins: optional('ALLOWED_ORIGINS', 'http://localhost:5173').split(','),

  rateLimit: {
    windowMs: parseInt(optional('RATE_LIMIT_WINDOW_MS', '900000'), 10),
    max: parseInt(optional('RATE_LIMIT_MAX', '100'), 10),
  },

  logLevel: optional('LOG_LEVEL', 'debug'),
  isDev: optional('NODE_ENV', 'development') === 'development',
} as const;
