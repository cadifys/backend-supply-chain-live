import { Knex } from 'knex';

export async function up(knex: Knex): Promise<void> {
  // Create central schema
  await knex.raw('CREATE SCHEMA IF NOT EXISTS central');
  await knex.raw('SET search_path = central, public');

  // Enable UUID extension
  await knex.raw('CREATE EXTENSION IF NOT EXISTS "pgcrypto"');

  // Super admins (global platform admins)
  await knex.schema.withSchema('central').createTable('super_admins', (t) => {
    t.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    t.string('name', 255).notNullable();
    t.string('email', 255).notNullable().unique();
    t.string('password_hash', 255).notNullable();
    t.boolean('is_active').defaultTo(true);
    t.timestamps(true, true);
  });

  // Organizations
  await knex.schema.withSchema('central').createTable('organizations', (t) => {
    t.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    t.string('name', 255).notNullable();
    t.string('slug', 100).notNullable().unique(); // used as DB schema name: org_<slug>
    t.string('industry', 100); // seed, metal, textile, etc.
    t.string('contact_email', 255);
    t.string('contact_phone', 20);
    t.string('address', 500);
    t.string('logo_url', 500);
    t.boolean('is_active').defaultTo(true);
    t.uuid('created_by').references('id').inTable('central.super_admins').onDelete('SET NULL');
    t.timestamps(true, true);
  });

  // Org admins (one or more per org, managed by super admin)
  await knex.schema.withSchema('central').createTable('org_admins', (t) => {
    t.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    t.uuid('org_id').notNullable().references('id').inTable('central.organizations').onDelete('CASCADE');
    t.string('name', 255).notNullable();
    t.string('email', 255).notNullable().unique();
    t.string('phone', 20);
    t.string('password_hash', 255).notNullable();
    t.boolean('is_active').defaultTo(true);
    t.uuid('created_by').references('id').inTable('central.super_admins').onDelete('SET NULL');
    t.timestamps(true, true);
  });

  // Indexes
  await knex.raw('CREATE INDEX ON central.org_admins(org_id)');
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.withSchema('central').dropTableIfExists('org_admins');
  await knex.schema.withSchema('central').dropTableIfExists('organizations');
  await knex.schema.withSchema('central').dropTableIfExists('super_admins');
}
