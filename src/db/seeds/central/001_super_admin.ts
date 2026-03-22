import { Knex } from 'knex';
import bcrypt from 'bcryptjs';

export async function seed(knex: Knex): Promise<void> {
  // Only seed if no super admin exists
  const existing = await knex('central.super_admins').count('id as count').first();
  if (existing && Number(existing.count) > 0) return;

  const passwordHash = await bcrypt.hash('Admin@123', 12);

  await knex('central.super_admins').insert({
    name: 'Super Admin',
    email: 'superadmin@mfghub.com',
    password_hash: passwordHash,
  });

  console.log('✓ Default super admin created: superadmin@mfghub.com / Admin@123');
  console.log('  !! Change the password immediately after first login !!');
}
