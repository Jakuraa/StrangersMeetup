// lib/pagination.js - Offset pagination for list endpoints: ?limit=1..100 (default 25) &offset=n.
// Queries fetch limit + 1 rows so the response can say whether another page exists.

export function page(query, { max = 100, def = 25 } = {}) {
  const limit = Math.min(Math.max(parseInt(query?.get?.('limit') ?? '', 10) || def, 1), max);
  const offset = Math.min(Math.max(parseInt(query?.get?.('offset') ?? '', 10) || 0, 0), 100_000);
  return { limit, offset };
}

export function pageInfo(rows, p, key = 'items') {
  const more = rows.length > p.limit;
  return { [key]: more ? rows.slice(0, p.limit) : rows, page: { limit: p.limit, offset: p.offset, nextOffset: more ? p.offset + p.limit : null } };
}
