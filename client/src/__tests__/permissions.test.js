import { describe, it, expect } from 'vitest';
import {
  ROLES, isAdmin, isOwner, isSuperAdmin, isAdminTier, canSeeAllLeads, isReadOnly, canWrite, isAssignable,
  hasPermission, PERMISSION_KEYS, roleLabel, RR_ROLES,
} from '../permissions.js';

describe('permissions mirror', () => {
  it('lists the seven roles', () => {
    expect(ROLES).toEqual(['super_admin', 'admin', 'manager', 'agent', 'caller', 'employee', 'read_only']);
  });
  it('admin tier = super_admin | admin | manager', () => {
    for (const r of ['super_admin', 'admin', 'manager']) { expect(isAdmin(r)).toBe(true); expect(canSeeAllLeads(r)).toBe(true); expect(isAdminTier(r)).toBe(true); }
    for (const r of ['agent', 'caller', 'employee', 'read_only', undefined]) { expect(isAdmin(r)).toBe(false); expect(canSeeAllLeads(r)).toBe(false); }
  });
  it('owner tier = super_admin | admin', () => {
    expect(isOwner('super_admin')).toBe(true);
    expect(isOwner('admin')).toBe(true);
    expect(isOwner('manager')).toBe(false);
    expect(isSuperAdmin).toBe(isOwner);
  });
  it('read_only can never write', () => {
    expect(isReadOnly('read_only')).toBe(true);
    expect(canWrite('read_only')).toBe(false);
    expect(canWrite('caller')).toBe(true);
    expect(canWrite(undefined)).toBe(false);
  });
  it('isAssignable filters read_only and inactive users', () => {
    expect(isAssignable({ role: 'caller', is_active: 1 })).toBe(true);
    expect(isAssignable({ role: 'caller' })).toBe(true); // slim list has no is_active
    expect(isAssignable({ role: 'caller', is_active: 0 })).toBe(false);
    expect(isAssignable({ role: 'read_only', is_active: 1 })).toBe(false);
    expect(isAssignable(null)).toBe(false);
  });
  it('hasPermission matches the server matrix', () => {
    expect(PERMISSION_KEYS).toEqual(['MANAGE_TEAM', 'DELETE_RECORDS', 'MANAGE_SETTINGS', 'EDIT_CATALOG', 'VIEW_ADMIN_DASHBOARD', 'CREATE_PROJECT']);
    expect(hasPermission('manager', 'MANAGE_TEAM')).toBe(true);
    expect(hasPermission('manager', 'MANAGE_SETTINGS')).toBe(false);
    expect(hasPermission('caller', 'CREATE_PROJECT')).toBe(true);
    expect(hasPermission('read_only', 'CREATE_PROJECT')).toBe(false);
    expect(hasPermission('admin', 'NOPE')).toBe(false);
  });
  it('labels roles and mirrors the round-robin pool', () => {
    expect(roleLabel('super_admin')).toBe('Super admin');
    expect(roleLabel('weird')).toBe('weird');
    expect(RR_ROLES).toEqual(['agent', 'caller']);
  });
});
