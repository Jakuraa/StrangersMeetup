// api/index.js - The only Vercel function. vercel.json rewrites all dynamic paths here.
import { handle } from '../lib/router.js';

export default function handler(req, res) {
  return handle(req, res);
}
