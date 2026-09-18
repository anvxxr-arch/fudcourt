import Home from '../page';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

export default function TrackerRoute() {
  return <Home initialPage="tracker" />;
}
