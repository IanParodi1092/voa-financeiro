import 'dotenv/config';
import dotenv from 'dotenv';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { loadConfig } from '../config.js';
import { hashPassword } from './password.js';

dotenv.config({ path: resolve(dirname(fileURLToPath(import.meta.url)), '../../../.env') });

const config = loadConfig();
const email = process.env.ADMIN_EMAIL?.trim().toLowerCase();
const password = process.env.ADMIN_PASSWORD;
const displayName = process.env.ADMIN_DISPLAY_NAME?.trim() || 'Administrador';

if (!email || !password) throw new Error('ADMIN_EMAIL and ADMIN_PASSWORD must be provided as temporary environment variables.');
if (password.length < 12) throw new Error('ADMIN_PASSWORD must contain at least 12 characters.');

const pool = new pg.Pool({ connectionString: config.DIRECT_DATABASE_URL ?? config.DATABASE_URL });
const client = await pool.connect();

try {
  await client.query('BEGIN');
  const roleResult = await client.query<{ id: string }>(`INSERT INTO roles (name, description)
    VALUES ('admin', 'Full access to the administrative application')
    ON CONFLICT (name) DO UPDATE SET description = EXCLUDED.description
    RETURNING id`, []);
  const userResult = await client.query<{ id: string }>(`INSERT INTO users (email, password_hash, display_name)
    VALUES ($1, $2, $3)
    ON CONFLICT (email) DO UPDATE SET display_name = EXCLUDED.display_name, updated_at = now()
    RETURNING id`, [email, await hashPassword(password), displayName]);
  const role = roleResult.rows[0];
  const user = userResult.rows[0];
  if (!role || !user) throw new Error('Could not create administrator role or user.');
  await client.query(`INSERT INTO user_roles (user_id, role_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`, [user.id, role.id]);
  await client.query('COMMIT');
  console.log(`Administrator ready: ${email}`);
} catch (error) {
  await client.query('ROLLBACK');
  throw error;
} finally {
  client.release();
  await pool.end();
}
