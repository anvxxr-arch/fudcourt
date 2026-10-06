import '@/app/(frontend)/globals.css';
import { color, fontFamily, fontSize, fontWeight, radius, space } from '@/styles/tokens';
/**
 * Root not-found. It renders inside Next's BUILTIN root layout (there is no
 * `src/app/layout.tsx`), so the frontend layout's theme script and stylesheet do
 * not reach it. Both are re-applied here so a 404 still paints in the site's
 * light/dark design language without a flash, using token values only.
 */
const THEME_SCRIPT =
  "(function(){var t=localStorage.getItem('theme');if(!t){t=window.matchMedia('(prefers-color-scheme: dark)').matches?'dark':'light';}document.documentElement.classList.toggle('dark',t==='dark');})();";
export default function NotFound() {
  return (
    <>
      <script dangerouslySetInnerHTML={{ __html: THEME_SCRIPT }} />
      <main
        style={{
          background: color.bgBase,
          minHeight: '50vh',
          color: color.labelPrimary,
          fontFamily: fontFamily.sans,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          padding: space[20],
        }}
      >
        <div
          style={{
            background: color.bgSecondary,
            border: `1px solid ${color.separator}`,
            borderRadius: radius[12],
            padding: space[24],
            maxWidth: 420,
            width: '100%',
            textAlign: 'center',
          }}
        >
          <h1
            style={{
              margin: 0,
              color: color.blue,
              fontSize: fontSize[17],
              fontWeight: fontWeight.bold,
            }}
          >
            404 — page not found
          </h1>
          <p
            style={{
              margin: `${space[8]}px 0 0`,
              color: color.labelTertiary,
              fontSize: fontSize[12],
            }}
          >
            This page does not exist — try the navigation bar, or head back to the landing page.
          </p>
          <div style={{ marginTop: space[16] }}>
            <a
              className="fc-focusable"
              href="/"
              style={{
                display: 'inline-block',
                color: color.blue,
                background: color.bgBase,
                border: `1px solid ${color.separator}`,
                borderRadius: radius[8],
                padding: `${space[8]}px ${space[16]}px`,
                fontSize: fontSize[12],
                fontWeight: fontWeight.semibold,
                textDecoration: 'none',
              }}
            >
              Back to the landing page
            </a>
          </div>
        </div>
      </main>
    </>
  );
}
