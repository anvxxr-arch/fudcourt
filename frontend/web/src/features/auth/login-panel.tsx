import { color, fontFamily, fontSize, fontWeight, letterSpacing, lineHeight, radius, space } from '@/styles/tokens';
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
        background: color.bg,
        color: color.text,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: space[20],
        fontFamily: fontFamily.mono,
      }}
    >
      <div
        style={{
          width: '100%',
          maxWidth: 420,
          background: color.surface,
          border: `1px solid ${color.border}`,
          borderRadius: radius[8],
          padding: space[28],
        }}
      >
        <h1 style={{ margin: 0, fontSize: fontSize[18], letterSpacing: letterSpacing.wide }}>FUDCOURT ACCESS</h1>
        <p style={{ color: color.textMuted, fontSize: fontSize[13], lineHeight: lineHeight.normal }}>
          Masuk dengan Discord untuk membuka member, terminal, dan management. Level akses mengikuti role
          Discord kamu di guild FUDCOURT.
        </p>
        {message && (
          <p
            style={{
              color: color.negative,
              fontSize: fontSize[12],
              border: `1px solid ${color.negative}`,
              borderRadius: radius[6],
              padding: `${space[8]}px ${space[10]}px`,
              margin: `0 0 ${space[16]}px`,
            }}
          >
            {message}
          </p>
        )}
        {target !== '/' && (
          <p style={{ color: color.textMuted, fontSize: fontSize[12], margin: `0 0 ${space[16]}px` }}>
            Setelah login kamu kembali ke <span style={{ color: color.accent }}>{target}</span>
          </p>
        )}
        <a
          href={loginHref}
          style={{
            display: 'block',
            textAlign: 'center',
            background: color.accent,
            color: color.textOnAccent,
            fontWeight: fontWeight.bold,
            fontSize: fontSize[13],
            padding: `${space[12]}px ${space[16]}px`,
            borderRadius: radius[6],
            textDecoration: 'none',
          }}
        >
          CONTINUE WITH DISCORD
        </a>
        <p style={{ color: color.textMuted, fontSize: fontSize[11], margin: `${space[18]}px 0 0` }}>
          Scopes: <code>identify guilds</code>. Bot hanya membaca role id kamu di guild FUDCOURT.
        </p>
      </div>
    </main>
  );
}
