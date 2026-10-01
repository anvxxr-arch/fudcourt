import { C } from '@/styles/shared';
import { isSafeNext } from '@/platform/auth/guard';
// The login view itself. It lives in features/auth because it is the auth
// family's UI; the route (`/login`) is the thin wrapper that reads
// `searchParams` and renders it. The body below is the route's original render,
// moved verbatim — same copy, same styling, same redirect-safety predicate.
const ERRORS: Record<string, string> = {
  discord_denied: 'Login dibatalkan di Discord.',
  bad_state: 'Sesi login tidak valid atau sudah kedaluwarsa. Coba lagi.',
  auth_unconfigured: 'Konfigurasi OAuth server belum lengkap.',
  token_exchange_failed: 'Discord menolak tukar kode OAuth. Coba lagi.',
  discord_api_failed: 'Gagal memprofilkan akun Discord. Coba lagi.',
  session_secret_missing: 'FUDCOURT_SESSION_SECRET belum diatur di server.',
};
export default function LoginPanel({ error, next }: { error?: string; next?: string }) {
  // The same predicate the login route and the callback use: this value becomes
  // a redirect target, so a scheme-ful or `//host` value would be an open
  // redirect.
  const target = isSafeNext(next) ? next : '/';
  const loginHref = `/api/auth/login?next=${encodeURIComponent(target)}`;
  const message = error ? ERRORS[error] ?? 'Login gagal. Coba lagi.' : null;
  return (
    <main
      style={{
        minHeight: '100vh',
        background: C.bg,
        color: C.white,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: 20,
        fontFamily: 'ui-monospace, monospace',
      }}
    >
      <div
        style={{
          width: '100%',
          maxWidth: 420,
          background: C.card,
          border: `1px solid ${C.border}`,
          borderRadius: 8,
          padding: 28,
        }}
      >
        <h1 style={{ margin: 0, fontSize: 18, letterSpacing: 1 }}>FUDCOURT ACCESS</h1>
        <p style={{ color: C.dim, fontSize: 13, lineHeight: 1.6 }}>
          Masuk dengan Discord untuk membuka member, terminal, dan management. Level akses mengikuti role
          Discord kamu di guild FUDCOURT.
        </p>
        {message && (
          <p
            style={{
              color: C.red,
              fontSize: 12,
              border: `1px solid ${C.red}`,
              borderRadius: 6,
              padding: '8px 10px',
              margin: '0 0 16px',
            }}
          >
            {message}
          </p>
        )}
        {target !== '/' && (
          <p style={{ color: C.dim, fontSize: 12, margin: '0 0 16px' }}>
            Setelah login kamu kembali ke <span style={{ color: C.accent }}>{target}</span>
          </p>
        )}
        <a
          href={loginHref}
          style={{
            display: 'block',
            textAlign: 'center',
            background: C.accent,
            color: C.bg,
            fontWeight: 700,
            fontSize: 13,
            padding: '12px 16px',
            borderRadius: 6,
            textDecoration: 'none',
          }}
        >
          CONTINUE WITH DISCORD
        </a>
        <p style={{ color: C.dim, fontSize: 11, margin: '18px 0 0' }}>
          Scopes: <code>identify guilds</code>. Bot hanya membaca role id kamu di guild FUDCOURT.
        </p>
      </div>
    </main>
  );
}
