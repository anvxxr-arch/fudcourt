import Home from '../page';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

export default function CoinRoute() {
  return <Home initialPage="coin" />;
}
