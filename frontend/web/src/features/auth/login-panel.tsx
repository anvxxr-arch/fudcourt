import { color, fontFamily, fontSize, fontWeight, letterSpacing, lineHeight, motion, radius, space, target as higTarget } from '@/styles/tokens';
import { isSafeNext } from '@/server/auth';
// The login view itself. It lives in features/auth because it is the auth
// family's UI; the route (`/login`) is the thin wrapper that reads
// `searchParams` and renders it. The body below is the route's original render,
// moved verbatim — same copy, same styling, same redirect-safety predicate.
const ERRORS: Record<string, string> = {
  discord_denied: 'Sign-in cancelled in Discord.',
  bad_state: 'Login session invalid or expired. Try again.',
  auth_unconfigured: 'Server OAuth is not fully configured.',
  token_exchange_failed: 'Discord refused the OAuth code exchange. Try again.',
  discord_api_failed: 'Could not read your Discord profile. Try again.',
  session_secret_missing: 'FUDCOURT_SESSION_SECRET is not set on the server.',
};
export default function LoginPanel({ error, next }: { error?: string; next?: string }) {
  // The same predicate the login route and the callback use: this value becomes
  // a redirect target, so a scheme-ful or `//host` value would be an open
  // redirect.
  const target = isSafeNext(next) ? next : '/';
  const loginHref = `/api/auth/login?next=${encodeURIComponent(target)}`;
  const message = error ? ERRORS[error] ?? 'Sign-in failed. Try again.' : null;
  const isTeamTarget = target === '/team' || target.startsWith('/team/');
  return (
    <main
      style={{
        minHeight: '100vh',
        background: color.bgBase,
        color: color.labelPrimary,
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
          background: color.bgSecondary,
          border: `1px solid ${color.separator}`,
          borderRadius: radius[20],
          padding: space[32],
        }}
      >
        <h1 style={{ margin: 0, fontSize: fontSize[20], letterSpacing: letterSpacing.wide }}>FUDCOURT ACCESS</h1>
        <p style={{ color: color.labelTertiary, fontSize: fontSize[13], lineHeight: lineHeight.normal }}>
          Sign in with Discord to unlock member, terminal, and management. Your access level follows your
          Discord role in the FUDCOURT guild.
        </p>
        <ul style={{ color: color.labelTertiary, fontSize: fontSize[12], lineHeight: lineHeight.normal, margin: `0 0 ${space[16]}px`, paddingLeft: space[20] }}>
          <li>Browsing stays free — boards, signals, and news are open without sign-in.</li>
          <li>Sign-in only unlocks your private terminal: your balances, positions, and venue risk.</li>
          <li>No exchange key needed to look — connecting a venue is optional, anytime.</li>
        </ul>
        {isTeamTarget && (
          <p style={{ color: color.labelTertiary, fontSize: fontSize[12], margin: `0 0 ${space[16]}px` }}>
            The /team terminal is your private room: cross-chain treasury, wallet + address + hash
            reconciliation, and boards that passed all three gating checks. Sign in once via Discord,
            land back here automatically.
          </p>
        )}
        {message && (
          <p
            style={{
              color: color.red,
              fontSize: fontSize[12],
              border: `1px solid ${color.red}`,
              borderRadius: radius[8],
              padding: `${space[8]}px ${space[8]}px`,
              margin: `0 0 ${space[16]}px`,
            }}
          >
            {message}
          </p>
        )}
        {target !== '/' && (
          <p style={{ color: color.labelTertiary, fontSize: fontSize[12], margin: `0 0 ${space[16]}px` }}>
            After sign-in you return to <span style={{ color: color.blue }}>{target}</span>
          </p>
        )}
        <a
          href={loginHref}
          style={{
            display: 'block',
            textAlign: 'center',
            background: color.blue,
            color: color.labelOnAccent,
            fontWeight: fontWeight.bold,
            fontSize: fontSize[13],
            padding: `${space[12]}px ${space[16]}px`,
            borderRadius: radius[10],
            minHeight: higTarget.min,
            textDecoration: 'none',
          }}
        >
          CONTINUE WITH DISCORD
        </a>
        <p style={{ color: color.labelTertiary, fontSize: fontSize[11], margin: `${space[16]}px 0 0` }}>
          Scopes: <code>identify guilds</code>. The bot only reads your role id in the FUDCOURT guild.
        </p>
        <p style={{ color: color.labelTertiary, fontSize: fontSize[11], margin: `${space[8]}px 0 0` }}>
          <a href="/market" style={{ color: color.blue, textDecoration: 'none' }}>Browse the boards first →</a>
        </p>
      </div>
    </main>
  );
}
