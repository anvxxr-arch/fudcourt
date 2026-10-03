import LoginPanel from '@/features/auth/login-panel';
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
