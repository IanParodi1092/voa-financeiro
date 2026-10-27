import type { FastifyInstance, FastifyReply } from 'fastify';
import type { Pool, PoolClient } from 'pg';
import { z } from 'zod';
import { recordAudit } from '../audit.js';
import { clearRefreshCookie, readCookie, serializeRefreshCookie } from '../auth/cookies.js';
import { verifyPassword } from '../auth/password.js';
import {
  ACCESS_TOKEN_TTL_SECONDS,
  REFRESH_TOKEN_TTL_SECONDS,
  createRefreshToken,
  createSessionTokenId,
  hashRefreshToken
} from '../auth/tokens.js';
import type { RouteDeps } from '../http/deps.js';
import { actorIdOf, authenticate, requirePermission } from '../http/guards.js';

const loginSchema = z.object({
  email: z.string().email().transform((value) => value.toLowerCase()),
  password: z.string().min(1)
});

/** Sessao: login, rotacao de refresh, logout, identidade corrente e a trilha de auditoria. */
export function registerIdentityRoutes(app: FastifyInstance, deps: RouteDeps): void {
  const { pool, config } = deps;

  type Queryable = Pool | PoolClient;

  const issueSession = async (
    executor: Queryable,
    userId: string,
    displayName: string,
    roles: string[],
    userAgent: string | undefined
  ) => {
    const tokenId = createSessionTokenId();
    const refreshToken = createRefreshToken();
    await executor.query(
      `INSERT INTO auth_sessions (user_id, token_id, refresh_token_hash, refresh_expires_at, expires_at, user_agent)
       VALUES ($1, $2, $3, now() + make_interval(secs => $4::int), now() + make_interval(secs => $4::int), $5)`,
      [userId, tokenId, hashRefreshToken(refreshToken, config.refreshSecret), REFRESH_TOKEN_TTL_SECONDS, userAgent ?? null]
    );
    const accessToken = app.jwt.sign({ sub: userId, sid: tokenId, name: displayName, roles });
    return { tokenId, refreshToken, accessToken };
  };

  const setRefreshCookie = (reply: FastifyReply, refreshToken: string): void => {
    reply.header('set-cookie', serializeRefreshCookie(config.refreshCookie, refreshToken, REFRESH_TOKEN_TTL_SECONDS));
  };

  const clearRefresh = (reply: FastifyReply): void => {
    reply.header('set-cookie', clearRefreshCookie(config.refreshCookie));
  };
  app.post('/api/v1/auth/login', async (request, reply) => {
    const parsed = loginSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ code: 'INVALID_REQUEST', message: 'Invalid login data', correlationId: request.id });
    }
    if (!pool) {
      return reply.code(503).send({ code: 'DATABASE_UNAVAILABLE', message: 'Authentication is temporarily unavailable', correlationId: request.id });
    }

    const result = await pool.query<{
      id: string;
      password_hash: string;
      display_name: string;
      roles: string[] | null;
    }>(`SELECT u.id, u.password_hash, u.display_name,
               COALESCE(array_agg(r.name) FILTER (WHERE r.name IS NOT NULL), ARRAY[]::text[]) AS roles
          FROM users u
          LEFT JOIN user_roles ur ON ur.user_id = u.id
          LEFT JOIN roles r ON r.id = ur.role_id
         WHERE u.email = $1 AND u.is_active = true
         GROUP BY u.id`, [parsed.data.email]);
    const user = result.rows[0];
    if (!user || !(await verifyPassword(parsed.data.password, user.password_hash))) {
      await recordAudit(pool, request.log, request.id, {
        action: 'auth.login.failed',
        metadata: { email: parsed.data.email }
      });
      return reply.code(401).send({ code: 'INVALID_CREDENTIALS', message: 'Invalid email or password', correlationId: request.id });
    }

    const session = await issueSession(pool, user.id, user.display_name, user.roles ?? [], request.headers['user-agent']);
    setRefreshCookie(reply, session.refreshToken);
    await recordAudit(pool, request.log, request.id, {
      action: 'auth.login.succeeded',
      actorId: user.id,
      entityType: 'auth_session',
      entityId: session.tokenId
    });
    return { accessToken: session.accessToken, tokenType: 'Bearer', expiresIn: ACCESS_TOKEN_TTL_SECONDS };
  });

  /**
   * Rotates the refresh token: the presented session is revoked and a new one is issued.
   *
   * A refresh token is single-use; replaying one that was already rotated, revoked or expired is
   * refused with 401 and the cookie is cleared.
   */
  app.post('/api/v1/auth/refresh', async (request, reply) => {
    if (!pool) {
      return reply.code(503).send({ code: 'DATABASE_UNAVAILABLE', message: 'Authentication is temporarily unavailable', correlationId: request.id });
    }
    const presented = readCookie(request.headers.cookie, config.refreshCookie.name);
    if (!presented) {
      clearRefresh(reply);
      return reply.code(401).send({ code: 'UNAUTHORIZED', message: 'Refresh token missing', correlationId: request.id });
    }

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const found = await client.query<{
        token_id: string;
        user_id: string;
        display_name: string;
        roles: string[] | null;
      }>(`SELECT s.token_id, s.user_id, u.display_name,
                 COALESCE(array_agg(r.name) FILTER (WHERE r.name IS NOT NULL), ARRAY[]::text[]) AS roles
            FROM auth_sessions s
            JOIN users u ON u.id = s.user_id
            LEFT JOIN user_roles ur ON ur.user_id = u.id
            LEFT JOIN roles r ON r.id = ur.role_id
           WHERE s.refresh_token_hash = $1
             AND s.revoked_at IS NULL
             AND s.refresh_expires_at > now()
             AND u.is_active = true
           GROUP BY s.id, s.token_id, s.user_id, u.display_name`,
        [hashRefreshToken(presented, config.refreshSecret)]);
      const current = found.rows[0];
      const revoked = current
        ? await client.query('UPDATE auth_sessions SET revoked_at = now() WHERE token_id = $1 AND revoked_at IS NULL', [current.token_id])
        : null;
      if (!current || revoked === null || revoked.rowCount === 0) {
        await client.query('ROLLBACK');
        clearRefresh(reply);
        await recordAudit(pool, request.log, request.id, { action: 'auth.refresh.rejected' });
        return reply.code(401).send({ code: 'UNAUTHORIZED', message: 'Refresh token is not valid anymore', correlationId: request.id });
      }
      const session = await issueSession(client, current.user_id, current.display_name, current.roles ?? [], request.headers['user-agent']);
      await client.query('COMMIT');
      setRefreshCookie(reply, session.refreshToken);
      await recordAudit(pool, request.log, request.id, {
        action: 'auth.refresh',
        actorId: current.user_id,
        entityType: 'auth_session',
        entityId: session.tokenId,
        metadata: { rotatedFrom: current.token_id }
      });
      return { accessToken: session.accessToken, tokenType: 'Bearer', expiresIn: ACCESS_TOKEN_TTL_SECONDS };
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  });

  app.post('/api/v1/auth/logout', { preHandler: authenticate }, async (request, reply) => {
    const claims = request.user as { sub?: string; sid?: string };
    const refreshToken = readCookie(request.headers.cookie, config.refreshCookie.name);
    if (pool) {
      if (claims.sid) {
        await pool.query('UPDATE auth_sessions SET revoked_at = now() WHERE token_id = $1 AND revoked_at IS NULL', [claims.sid]);
      }
      if (refreshToken) {
        await pool.query('UPDATE auth_sessions SET revoked_at = now() WHERE refresh_token_hash = $1 AND revoked_at IS NULL', [
          hashRefreshToken(refreshToken, config.refreshSecret)
        ]);
      }
    }
    clearRefresh(reply);
    await recordAudit(pool, request.log, request.id, {
      action: 'auth.logout',
      actorId: claims.sub || null,
      entityType: 'auth_session',
      entityId: claims.sid ?? null
    });
    return reply.code(204).send();
  });

  app.get('/api/v1/auth/me', { preHandler: authenticate }, async (request) => ({ user: request.user }));

  app.get('/api/v1/audit-logs', { preHandler: requirePermission('audit') }, async (request, reply) => {
    if (!pool) return reply.code(503).send({ code: 'DATABASE_UNAVAILABLE', message: 'Database is temporarily unavailable', correlationId: request.id });
    const query = request.query as { action?: string; limit?: string };
    const limit = Math.min(Math.max(Number(query.limit ?? 50) || 50, 1), 200);
    const action = query.action?.trim() ?? '';
    const result = await pool.query(`SELECT id, action, entity_type AS "entityType", entity_id AS "entityId",
        correlation_id AS "correlationId", metadata, created_at AS "createdAt"
      FROM audit_logs
      WHERE ($1 = '' OR action = $1)
      ORDER BY created_at DESC LIMIT $2`, [action, limit]);
    return { items: result.rows, limit, action };
  });
}
