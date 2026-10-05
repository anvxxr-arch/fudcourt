import StoreShell from '@/features/overview/store-shell';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

export default function NewsRoute() {
  return <StoreShell initialPage="news" />;
}
