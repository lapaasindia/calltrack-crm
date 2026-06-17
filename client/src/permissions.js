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

// Team-management tier (super_admin | admin | manager).
export const isAdmin = (role) => role === 'super_admin' || role === 'admin' || role === 'manager';

// Owner tier (super_admin | admin) — settings / catalog / audit.
export const isOwner = (role) => role === 'super_admin' || role === 'admin';

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
