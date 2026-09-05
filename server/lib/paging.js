// Shared `?limit&offset` parser for list endpoints (audit SCALE-5).
// `explicit` says whether the client asked for paging at all, so legacy
// callers keep the bare-array response shape they were built against.
export function pagingOf(q, { defaultLimit, maxLimit }) {
  const explicit = q.limit !== undefined || q.offset !== undefined;
  let limit = parseInt(q.limit, 10);
  if (!Number.isFinite(limit) || limit < 1) limit = defaultLimit;
  limit = Math.min(maxLimit, limit);
  let offset = parseInt(q.offset, 10);
  if (!Number.isFinite(offset) || offset < 0) offset = 0;
  return { explicit, limit, offset };
}
