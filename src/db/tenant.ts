import knex, { Knex } from 'knex';
import { env } from '../config/env';
import { logger } from '../utils/logger';

// Connection pool cache: one per org schema
const tenantConnections = new Map<string, Knex>();

/**
 * Patch existing tenant schemas with new columns (idempotent).
 * Called at server startup for all active orgs.
 */
export async function patchAllTenantSchemas(orgSlugs: string[]): Promise<void> {
  for (const slug of orgSlugs) {
    const schema = `org_${slug}`;
    const db = getTenantDb(schema);
    try {
      // Add unit column to stage_transactions (idempotent)
      await db.raw(`ALTER TABLE stage_transactions ADD COLUMN IF NOT EXISTS unit VARCHAR(20) DEFAULT 'kg'`);

      // Fix loss_qty formula: loss = processed - output (instock is auto = input - processed)
      await db.raw(`ALTER TABLE stage_transactions DROP COLUMN IF EXISTS loss_qty`);
      await db.raw(`ALTER TABLE stage_transactions ADD COLUMN loss_qty NUMERIC(12,3) GENERATED ALWAYS AS (processed_qty - output_qty) STORED`);

      logger.info(`Schema patched: ${schema}`);
    } catch (err: any) {
      logger.warn(`Schema patch skipped for ${schema}: ${err.message}`);
    }
  }
}

/**
 * Get (or create) a knex connection scoped to the org's schema.
 * The search_path ensures all queries land in org_<slug> schema automatically.
 */
export function getTenantDb(orgSchema: string): Knex {
  if (tenantConnections.has(orgSchema)) {
    return tenantConnections.get(orgSchema)!;
  }

  const db = knex({
    client: 'pg',
    connection: {
      host: env.db.host,
      port: env.db.port,
      database: env.db.name,
      user: env.db.user,
      password: env.db.password,
      ssl: env.db.ssl ? { rejectUnauthorized: false } : false,
    },
    pool: {
      min: 1,
      max: 5,
      acquireTimeoutMillis: 30000,
      idleTimeoutMillis: 30000,
      afterCreate: (conn: any, done: Function) => {
        // Set search_path for every connection in this pool
        conn.query(`SET search_path = "${orgSchema}", public`, (err: Error) => {
          done(err, conn);
        });
      },
    },
    searchPath: [orgSchema, 'public'],
  });

  tenantConnections.set(orgSchema, db);
  logger.debug(`Created DB pool for schema: ${orgSchema}`);
  return db;
}

/**
 * Create schema and run tenant migrations for a new org
 */
export async function bootstrapTenantSchema(orgSchema: string): Promise<void> {
  const db = knex({
    client: 'pg',
    connection: {
      host: env.db.host,
      port: env.db.port,
      database: env.db.name,
      user: env.db.user,
      password: env.db.password,
      ssl: env.db.ssl ? { rejectUnauthorized: false } : false,
    },
  });

  try {
    // Create schema if not exists
    await db.raw(`CREATE SCHEMA IF NOT EXISTS "${orgSchema}"`);
    logger.info(`Schema created: ${orgSchema}`);

    // Run migrations in this schema
    const tenantDb = db.withUserParams({ schemaName: orgSchema });
    await tenantDb.raw(`SET search_path = "${orgSchema}", public`);

    // Run all tenant migration SQL directly
    await runTenantMigrations(db, orgSchema);
    logger.info(`Migrations complete for schema: ${orgSchema}`);
  } finally {
    await db.destroy();
  }
}

async function runTenantMigrations(db: Knex, schema: string): Promise<void> {
  const s = `"${schema}"`;

  // Users table
  await db.raw(`
    CREATE TABLE IF NOT EXISTS ${s}.users (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      name VARCHAR(255) NOT NULL,
      email VARCHAR(255) UNIQUE,
      phone VARCHAR(20) UNIQUE,
      password_hash VARCHAR(255) NOT NULL,
      role VARCHAR(20) NOT NULL CHECK (role IN ('admin','manager','lead','worker')),
      is_active BOOLEAN DEFAULT true,
      created_by UUID,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);

  // Stages table (configurable by admin)
  await db.raw(`
    CREATE TABLE IF NOT EXISTS ${s}.stages (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      name VARCHAR(255) NOT NULL,
      description TEXT,
      stage_order INT NOT NULL DEFAULT 0,
      is_active BOOLEAN DEFAULT true,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);

  // Stage connections (DAG - defines allowed material flow paths)
  await db.raw(`
    CREATE TABLE IF NOT EXISTS ${s}.stage_connections (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      from_stage_id UUID REFERENCES ${s}.stages(id) ON DELETE CASCADE,
      to_stage_id UUID REFERENCES ${s}.stages(id) ON DELETE CASCADE,
      is_active BOOLEAN DEFAULT true,
      UNIQUE(from_stage_id, to_stage_id)
    )
  `);

  // Machines table
  await db.raw(`
    CREATE TABLE IF NOT EXISTS ${s}.machines (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      name VARCHAR(255) NOT NULL,
      stage_id UUID REFERENCES ${s}.stages(id) ON DELETE SET NULL,
      description TEXT,
      is_active BOOLEAN DEFAULT true,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);

  // User stage assignments (which users work on which stages)
  await db.raw(`
    CREATE TABLE IF NOT EXISTS ${s}.user_stage_assignments (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id UUID REFERENCES ${s}.users(id) ON DELETE CASCADE,
      stage_id UUID REFERENCES ${s}.stages(id) ON DELETE CASCADE,
      assigned_at TIMESTAMPTZ DEFAULT NOW(),
      UNIQUE(user_id, stage_id)
    )
  `);

  // Lots / Batches (raw material intake)
  await db.raw(`
    CREATE TABLE IF NOT EXISTS ${s}.lots (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      lot_number VARCHAR(100) NOT NULL UNIQUE,
      crop VARCHAR(255),
      variety VARCHAR(255),
      total_qty NUMERIC(12,3) NOT NULL,
      unit VARCHAR(20) NOT NULL DEFAULT 'kg',
      current_stage_id UUID REFERENCES ${s}.stages(id),
      supplier_name VARCHAR(255),
      intake_date DATE NOT NULL DEFAULT CURRENT_DATE,
      notes TEXT,
      status VARCHAR(20) DEFAULT 'active' CHECK (status IN ('active','completed','cancelled')),
      created_by UUID REFERENCES ${s}.users(id),
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);

  // Stage transactions (work done by a worker on a lot at a stage)
  await db.raw(`
    CREATE TABLE IF NOT EXISTS ${s}.stage_transactions (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      lot_id UUID REFERENCES ${s}.lots(id) ON DELETE CASCADE,
      stage_id UUID REFERENCES ${s}.stages(id),
      machine_id UUID REFERENCES ${s}.machines(id),
      worker_id UUID REFERENCES ${s}.users(id),
      transaction_date DATE NOT NULL DEFAULT CURRENT_DATE,
      unit VARCHAR(20) NOT NULL DEFAULT 'kg',
      input_qty NUMERIC(12,3) NOT NULL DEFAULT 0,
      processed_qty NUMERIC(12,3) NOT NULL DEFAULT 0,
      instock_qty NUMERIC(12,3) NOT NULL DEFAULT 0,
      output_qty NUMERIC(12,3) NOT NULL DEFAULT 0,
      loss_qty NUMERIC(12,3) GENERATED ALWAYS AS (processed_qty - output_qty) STORED,
      notes TEXT,
      status VARCHAR(20) DEFAULT 'completed' CHECK (status IN ('pending','completed')),
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);

  // Material transfers between stages
  await db.raw(`
    CREATE TABLE IF NOT EXISTS ${s}.material_transfers (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      lot_id UUID REFERENCES ${s}.lots(id) ON DELETE CASCADE,
      from_stage_id UUID REFERENCES ${s}.stages(id),
      to_stage_id UUID REFERENCES ${s}.stages(id),
      qty NUMERIC(12,3) NOT NULL,
      unit VARCHAR(20) NOT NULL DEFAULT 'kg',
      requested_by UUID REFERENCES ${s}.users(id),
      accepted_by UUID REFERENCES ${s}.users(id),
      status VARCHAR(20) DEFAULT 'pending' CHECK (status IN ('pending','accepted','rejected')),
      notes TEXT,
      requested_at TIMESTAMPTZ DEFAULT NOW(),
      responded_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);

  // Indexes for performance
  await db.raw(`CREATE INDEX IF NOT EXISTS idx_st_worker_date ON ${s}.stage_transactions(worker_id, transaction_date)`);
  await db.raw(`CREATE INDEX IF NOT EXISTS idx_st_stage_date ON ${s}.stage_transactions(stage_id, transaction_date)`);
  await db.raw(`CREATE INDEX IF NOT EXISTS idx_st_lot ON ${s}.stage_transactions(lot_id)`);
  await db.raw(`CREATE INDEX IF NOT EXISTS idx_mt_status ON ${s}.material_transfers(status, to_stage_id)`);
  await db.raw(`CREATE INDEX IF NOT EXISTS idx_lots_status ON ${s}.lots(status)`);
}
