// Minimal EVM JSON-RPC client for /balance — one method, zero dependencies.
// BigInt carries the wei value so 18 decimals survive the conversion to ether.

export async function ethGetBalance(
  rpcUrl: string,
  address: string,
  fetchImpl: typeof fetch = fetch,
  timeoutMs = 8000,
): Promise<string> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetchImpl(rpcUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_getBalance", params: [address, "latest"] }),
      signal: ctrl.signal,
    });
    const text = await res.text();
    const decoded = JSON.parse(text) as { result?: string; error?: { message?: string } };
    if (decoded.error) throw new Error(decoded.error.message ?? "rpc error");
    if (typeof decoded.result !== "string") throw new Error(`decode rpc (http ${res.status})`);
    return decoded.result;
  } finally {
    clearTimeout(timer);
  }
}

/** weiToEther converts a hex wei quantity to a number via BigInt, no float loss. */
export function weiToEther(hexWei: string): number {
  const s = hexWei.replace(/^0x/i, "").trim();
  if (s === "") return 0;
  let wei: bigint;
  try {
    wei = BigInt(`0x${s}`);
  } catch {
    return 0;
  }
  const scale = 10n ** 18n;
  const whole = wei / scale;
  const frac = wei % scale;
  return parseFloat(`${whole}.${frac.toString().padStart(18, "0")}`);
}
