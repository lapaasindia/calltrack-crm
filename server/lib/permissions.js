// Central role model. The whole app derives authorization from here so the
// matrix lives in exactly one place (routes, middleware, and the client nav all
// reference these helpers / the mirrored copy in client/src/permissions.js).
//
// Legacy rows use 'admin' / 'caller'; both stay valid and keep their original
// powers — 'admin' is the top tier, 'caller' sees only its own leads.

export const ROLES = [
  'super_admin',
  'admin',
  'manager',
  'agent',
  'caller',
  'employee',
  'read_only',
];

// Team-management tier (matches the PRD's isAdmin). Can manage team + delete records.
export function isAdmin(role) {
  return role === 'super_admin' || role === 'admin' || role === 'manager';
}

// Settings / catalog / grade-delete tier — strictly the owners. (Managers are
// NOT owners: they run the team but don't reconfigure the system.)
export function isOwner(role) {
  return role === 'super_admin' || role === 'admin';
}

// Alias kept for readability at call sites that conceptually mean "owner".
export const isSuperAdmin = isOwner;

// Sees every lead (vs. only-assigned). Same tier as isAdmin.
export function canSeeAllLeads(role) {
  return isAdmin(role);
}

// read_only can never write.
export function isReadOnly(role) {
  return role === 'read_only';
}

// Permission matrix. Keep in sync with docs/LAPAASOS-PLAN.md "Phase 1".
const PERMISSIONS = {
  MANAGE_TEAM: isAdmin, // super_admin | admin | manager
  DELETE_RECORDS: isAdmin, // super_admin | admin | manager
  MANAGE_SETTINGS: isOwner, // super_admin | admin
  EDIT_CATALOG: isOwner, // super_admin | admin
  VIEW_ADMIN_DASHBOARD: isOwner, // super_admin | admin
  CREATE_PROJECT: (role) => role !== 'read_only', // everyone except read_only
};

export function hasPermission(role, perm) {
  const check = PERMISSIONS[perm];
  return check ? check(role) : false;
}

export const PERMISSION_KEYS = Object.keys(PERMISSIONS);
