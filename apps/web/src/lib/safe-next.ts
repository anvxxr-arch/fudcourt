// Open-redirect guard for the post-login `next` value. The destination is
// attacker-supplied, so both ends of the OAuth round-trip run it through this
// one predicate (login puts the result in `state`, the callback re-checks
// before redirecting). Pure string check, no cookies/crypto/next imports, so
// it is safe to call from anywhere — client component or server.
// Accepts only a site-relative path: a leading `/`, never a second one (which
// would make the value protocol-relative, i.e. another host), no `..` (which
// would climb out of the intended prefix once the browser normalises the path),
// and no `?`, `#` or `%` (which would either smuggle in a second target or make
// the value ambiguous across the cookie + query round-trip). No backslash:
// browsers treat '\\' as '/' during URL parsing, so `/\evil.example` would
// otherwise normalize to the protocol-relative `//evil.example`. Any value
// whose percent-decoded + backslash-normalized form begins with `//` is
// refused too — the exact same predicate identity.IsSafeNext implements.
export function isSafeNext(value: string | null | undefined): value is string {
  if (typeof value !== 'string' || !value.startsWith('/') || value.startsWith('//')) return false;
  if (value.includes('..')) return false;
  if (/[?#%]/.test(value)) return false;
  if (value.includes('\\')) return false;
  let decoded = value;
  try {
    decoded = decodeURIComponent(decoded);
  } catch {
    // A malformed decode leaves the value as-is; the checks above still apply.
  }
  if (decoded.replaceAll('\\', '/').startsWith('//')) return false;
  return true;
}
