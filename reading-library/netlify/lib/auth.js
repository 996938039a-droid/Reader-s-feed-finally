import { createHash, timingSafeEqual } from 'node:crypto';

const sha = (s) => createHash('sha256').update(String(s)).digest();

/** True when the request carries the right passphrase in the X-Passphrase header. */
export function isAuthorised(req, passphrase) {
  if (!passphrase) return false; // refuse to run open if the env var is missing
  const given = req.headers.get('x-passphrase') || '';
  if (!given) return false;
  return timingSafeEqual(sha(given), sha(passphrase));
}
