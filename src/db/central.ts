import knex, { Knex } from 'knex';
import { env } from '../config/env';
import { logger } from '../utils/logger';

const centralConfig: Knex.Config = {
  client: 'pg',
  connection: {
    host: env.db.host,
    port: env.db.port,
    database: env.db.name,
    user: env.db.user,
    password: env.db.password,
  },
  pool: {
    min: 2,
    max: 10,
    acquireTimeoutMillis: 30000,
    idleTimeoutMillis: 30000,
  },
  searchPath: ['central', 'public'],
  migrations: {
    directory: './migrations/central',
    tableName: 'knex_migrations',
    schemaName: 'central',
  },
};

export const centralDb = knex(centralConfig);

export async function testCentralConnection(): Promise<void> {
  await centralDb.raw('SELECT 1');
  logger.info('Central DB connection established');
}
