import Home from '../page';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

export default function NewsRoute() {
  return <Home initialPage="news" />;
}
