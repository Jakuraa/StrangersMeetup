// lib/validate.js - zod parsing that turns validation failures into 400s with safe messages.
import { z } from 'zod';
import { HttpError } from './http.js';

export { z };

export function parse(schema, data) {
  const r = schema.safeParse(data);
  if (!r.success) {
    const fields = r.error.issues.slice(0, 10).map((i) => ({ field: i.path.join('.'), message: i.message }));
    throw new HttpError(400, 'validation', 'Please check the highlighted fields', { fields });
  }
  return r.data;
}

export const uuid = z.string().uuid();
export const slug = z.string().regex(/^[a-z0-9]+(-[a-z0-9]+)*$/).max(120);
