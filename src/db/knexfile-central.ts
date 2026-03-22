import { Knex } from 'knex';
import { env } from '../config/env';

const config: Knex.Config = {
  client: 'pg',
  connection: {
    host: env.db.host,
    port: env.db.port,
    database: env.db.name,
    user: env.db.user,
    password: env.db.password,
  },
  migrations: {
    directory: './migrations/central',
    tableName: 'knex_migrations',
    schemaName: 'central',
    extension: 'ts',
  },
  seeds: {
    directory: './seeds/central',
    extension: 'ts',
  },
};

export default config;
