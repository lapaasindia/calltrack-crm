// Client mirror of server/lib/permissions.js — used only for showing/hiding
// nav + UI affordances. The SERVER is always the real gate; this never grants
// access, it just avoids rendering controls a user can't use.

export const ROLES = [
  'super_admin', 'admin', 'manager', 'agent', 'caller', 'employee', 'read_only',
];

// Human labels for the role picker / badges.
export const ROLE_LABELS = {
  super_admin: 'Super admin',
  admin: 'Admin',
  manager: 'Manager',
  agent: 'Agent',
  caller: 'Caller',
  employee: 'Employee',
  read_only: 'Read only',
};

export const roleLabel = (role) => ROLE_LABELS[role] || role || '';

// Team-management tier (super_admin | admin | manager).
export const isAdmin = (role) => role === 'super_admin' || role === 'admin' || role === 'manager';
export const isAdminTier = isAdmin;

// Owner tier (super_admin | admin) — settings / catalog / audit.
export const isOwner = (role) => role === 'super_admin' || role === 'admin';
export const isSuperAdmin = isOwner;

// Sees every lead (vs. only-assigned). Same tier as isAdmin.
export const canSeeAllLeads = (role) => isAdmin(role);

// read_only can never write.
export const isReadOnly = (role) => role === 'read_only';
export const canWrite = (role) => !!role && !isReadOnly(role);

// Roles that can be handed leads / follow-ups / tasks (every active user that
// is not read_only). Assignment pickers filter on this.
export const isAssignable = (u) => !!u && !isReadOnly(u.role) && (u.is_active === undefined || !!u.is_active);

// Round-robin pool mirror of server/lib/assignment.js RR_ROLES.
export const RR_ROLES = ['agent', 'caller'];

// Permission matrix mirror of server/lib/permissions.js. Used ONLY to show/hide
// UI affordances — the server is always the real gate.
const PERMISSIONS = {
  MANAGE_TEAM: isAdmin,
  DELETE_RECORDS: isAdmin,
  MANAGE_SETTINGS: isOwner,
  EDIT_CATALOG: isOwner,
  VIEW_ADMIN_DASHBOARD: isOwner,
  CREATE_PROJECT: (role) => role !== 'read_only',
};

export function hasPermission(role, perm) {
  const check = PERMISSIONS[perm];
  return check ? check(role) : false;
}

export const PERMISSION_KEYS = Object.keys(PERMISSIONS);
