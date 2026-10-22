/**
 * RBAC minimo do sistema: papeis fixos (`roles.name`) e a permissao que cada um concede.
 *
 * A tabela `roles` continua sendo o cadastro dos papeis (o `create-admin` cria `admin`), mas a
 * permissao de cada papel vive aqui para o servidor recusar escrita antes de tocar no banco. Um
 * usuario sem nenhum papel recebe 403 em qualquer rota de dominio - `read` tambem e uma permissao.
 */
export const ROLE_NAMES = ['admin', 'finance', 'operator', 'viewer'] as const;
export type RoleName = (typeof ROLE_NAMES)[number];

export const PERMISSIONS = ['read', 'catalog:write', 'finance:write', 'migration:write', 'audit'] as const;
export type Permission = (typeof PERMISSIONS)[number];

export const PERMISSION_ROLES: Record<Permission, readonly RoleName[]> = {
  read: ['admin', 'finance', 'operator', 'viewer'],
  'catalog:write': ['admin', 'operator'],
  'finance:write': ['admin', 'finance'],
  // Migracao sela o lote que a carga canonica consome: so o admin decide sobre o legado.
  'migration:write': ['admin'],
  audit: ['admin']
};

export function rolesForPermission(permission: Permission): readonly RoleName[] {
  return PERMISSION_ROLES[permission];
}

export function hasPermission(roles: readonly string[], permission: Permission): boolean {
  const allowed = PERMISSION_ROLES[permission] as readonly string[];
  return roles.some((role) => allowed.includes(role));
}
