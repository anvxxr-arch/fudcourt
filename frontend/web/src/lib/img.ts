/** Internal image proxy helper: routes data-driven image URLs through /api/img. */
export function imgSrc(u: string | null | undefined): string {
  if (!u) return '';
  return `/api/img?u=${encodeURIComponent(u)}`;
}
