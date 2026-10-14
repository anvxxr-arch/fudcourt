// Package jupiter is the Jupiter provider adapter: Solana routing quotes and
// the Jupiter token list, normalized into DEX canonical rows.
//
// Endpoints (keyless tier; an optional key raises rate limits):
//
//	quote   GET https://lite-api.jup.ag/quote?inputMint={a}&outputMint={b}&amount={raw}&slippageBps={n}
//	tokens  GET https://lite-api.jup.ag/tokens
//
// The legacy v6 host (https://quote-api.jup.ag/v6) is documented only: the
// adapter never hops hosts at runtime (see FallbackBase).
//
// Auth is optional: JUPITER_API_KEY, when set, rides the x-api-key header.
// Jobs seed ENABLED with or without it; HasCredentials reports the key state
// for the record.
//
// The quote job subject spells inputMint:outputMint:rawAmount. The quote
// carries only raw integers, so per-mint decimals ride the job cursor
// (cursor[mint] = decimals, populated by the caller); unknown mints default
// to 0 (the raw integer stays exact, only the human rendering is unscaled).
// Quotes are stateless polls (30s); the token list is a daily full refresh.
//
// Numeric discipline: every body decodes with json.Decoder + UseNumber;
// prices build canon.Dec via canon.DecFromString and amounts build
// canon.TokenAmount via canon.NewTokenAmount. No binary floating point
// appears in this package.
//
// The freshest quote is also cached in the Valkey L2 under
// dex:quote:{chain}:{in}:{out}:{amount} with a short TTL (best-effort).
package jupiter
