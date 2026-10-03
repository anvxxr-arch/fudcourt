import StoreShell from '@/components/layout/store-shell';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

export default function SignalsRoute() {
  return <StoreShell initialPage="signals" />;
}
