// Client-side mutation headers (NFR-4, R-6).
// NEXT_PUBLIC_FUD_MUTATION_TOKEN is inlined at BUILD time:
// - local build (.env.local present) -> UI can mutate the local deployment
// - Vercel build (env absent)        -> header sends empty value -> server 401
//   (fail-closed: the public deployment is read-only by construction)
export const MUT_HEADERS: Record<string, string> = {
  'Content-Type': 'application/json',
  'x-fud-token': process.env.NEXT_PUBLIC_FUD_MUTATION_TOKEN || '',
};
