import LoginPanel from '@/features/auth/login-panel';
import type { Metadata } from 'next';

export const metadata: Metadata = {
  title: 'Sign In with Discord to Open Your Terminal | FUDCOURT',
  description: 'Sign in with Discord to open your FudCourt member terminal. Browsing stays free — sign-in only unlocks private terminals.',
  alternates: { canonical: '/login' },
  openGraph: { title: 'Sign In with Discord to Open Your Terminal | FUDCOURT', url: '/login', siteName: 'FUDCOURT', type: 'website', images: ['/og-cover.png'] },
  twitter: { card: 'summary_large_image', title: 'Sign In with Discord to Open Your Terminal | FUDCOURT', images: ['/og-cover.png'] },
};
export const dynamic = 'force-dynamic';
export const revalidate = 0;
// Landing page for every 307 the middleware issues: middleware sends anonymous
// users of /team, /admin and the treasury API here with `?next=<path>`, and the
// OAuth callback returns failures here with `?error=<code>`.
export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string; next?: string }>;
}) {
  const { error, next } = await searchParams;
  return <LoginPanel error={error} next={next} />;
}
