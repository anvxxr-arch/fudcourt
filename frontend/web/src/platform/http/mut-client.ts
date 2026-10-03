// Client-side mutation headers.
//
// There is deliberately no auth header here any more. The retired
// `x-fud-token` was sent from NEXT_PUBLIC_FUD_MUTATION_TOKEN, which Next
// inlines at BUILD time — the value shipped verbatim in a public JS chunk,
// so any visitor could read it and write to wallets/transactions.
//
// Writes are now authorised server-side from the httpOnly `fud_session`
// cookie (lib/mutation-auth.ts), which never enters the client bundle. The
// browser only needs to send the cookie it already has, so these headers are
// just content negotiation.
export const MUT_HEADERS: Record<string, string> = {
  'Content-Type': 'application/json',
};
