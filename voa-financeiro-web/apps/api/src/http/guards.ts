/**
 * Guardas de autenticacao e autorizacao dos handlers.
 *
 * Nao dependem da instancia do Fastify: leem o token da propria request (`request.jwtVerify`) e
 * decidem pelo papel, por isso saem do `app.ts` sem mudanca de comportamento.
 */

import type { FastifyReply, FastifyRequest } from 'fastify';
import { hasPermission, type Permission } from '../auth/roles.js';

function sendUnauthorized(request: FastifyRequest, reply: FastifyReply): void {
  reply.code(401).send({ code: 'UNAUTHORIZED', message: 'Authentication required', correlationId: request.id });
}

function sendForbidden(request: FastifyRequest, reply: FastifyReply, permission: Permission): void {
  reply.code(403).send({
    code: 'FORBIDDEN',
    message: `Role lacks the ${permission} permission`,
    correlationId: request.id
  });
}

/** Claims of the verified access token, or `null` when the request was already answered with 401. */
async function verifiedClaims(request: FastifyRequest, reply: FastifyReply) {
  try {
    await request.jwtVerify();
  } catch {
    sendUnauthorized(request, reply);
    return null;
  }
  const claims = request.user as { sub?: string; sid?: string; name?: string; roles?: string[] };
  return {
    sub: String(claims.sub ?? ''),
    sid: claims.sid,
    name: claims.name,
    roles: Array.isArray(claims.roles) ? claims.roles : []
  };
}

/** Builds the preHandler that authenticates the request and requires `permission`. */
function requirePermission(permission: Permission) {
  return async (request: FastifyRequest, reply: FastifyReply): Promise<void> => {
    const claims = await verifiedClaims(request, reply);
    if (!claims) return;
    if (!hasPermission(claims.roles, permission)) sendForbidden(request, reply, permission);
  };
}

/**
 * Authenticates the request and requires the `read` permission (every role has it).
 * Domain writes declare `requirePermission('catalog:write')` or `requirePermission('finance:write')`.
 */
const requireAuthentication = requirePermission('read');

/** preHandler for the auth routes: a valid access token is enough (no role required). */
const authenticate = async (request: FastifyRequest, reply: FastifyReply): Promise<void> => {
  await verifiedClaims(request, reply);
};

/** Id of the authenticated user, for the audit trail. */
function actorIdOf(request: FastifyRequest): string | null {
  const claims = request.user as { sub?: string } | undefined;
  return claims?.sub ?? null;
}

export { requireAuthentication, requirePermission, authenticate, actorIdOf };
