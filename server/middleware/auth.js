import db from '../db.js';

// Attaches req.user from the session. 401 if not logged in.
export function requireAuth(req, res, next) {
  if (!req.session?.userId) return res.status(401).json({ error: 'Not logged in' });
  const user = db
    .prepare('SELECT id, username, full_name, role, is_active FROM users WHERE id = ?')
    .get(req.session.userId);
  if (!user || !user.is_active) {
    req.session.destroy(() => {});
    return res.status(401).json({ error: 'Account inactive' });
  }
  req.user = user;
  next();
}

export function requireAdmin(req, res, next) {
  if (req.user?.role !== 'admin') return res.status(403).json({ error: 'Admin only' });
  next();
}

// Authorization rule used everywhere lead access is checked:
// admins see all leads; callers only leads assigned to them.
export function canAccessLead(user, lead) {
  if (!lead || lead.deleted_at) return false;
  if (user.role === 'admin') return true;
  return lead.assigned_to === user.id;
}

// Loads the lead and enforces access. 404 for missing, 403 for foreign leads.
export function loadLead(req, res, next) {
  const lead = db.prepare('SELECT * FROM leads WHERE id = ?').get(req.params.id);
  if (!lead || lead.deleted_at) return res.status(404).json({ error: 'Lead not found' });
  if (!canAccessLead(req.user, lead)) return res.status(403).json({ error: 'Not your lead' });
  req.lead = lead;
  next();
}
