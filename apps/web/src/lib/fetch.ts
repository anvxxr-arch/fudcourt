/** HttpError carries the api's own refusal text. The Go api answers a refusal with
 *  `{"detail": "..."}` — and for a panel that sentence is the only part a person can act
 *  on, so `HTTP 409` on its own would name nothing. `status` rides along so a caller can
 *  branch on it (the scheduler panel reports a 409 as an ownership conflict, not a bug). */
export class HttpError extends Error {
  readonly status: number;
  readonly detail: string;

  constructor(url: string, status: number, detail: string) {
    super(detail === "" ? url + " HTTP " + status : url + " HTTP " + status + ": " + detail);
    this.name = "HttpError";
    this.status = status;
    this.detail = detail;
  }
}

/** errorDetail pulls a human sentence out of a failed response body: `detail` (the Go
 *  api's own envelope) or `error` (the BFF proxy's, e.g. an unreachable api), else the raw
 *  body so a non-JSON failure is still readable. Never throws — a refusal must not turn
 *  into an unhandled parse error. */
async function errorDetail(res: Response): Promise<string> {
  let text = "";
  try {
    text = await res.text();
  } catch {
    return "";
  }
  const body = text.trim();
  if (body === "") return "";
  try {
    const parsed = JSON.parse(body) as { detail?: unknown; error?: unknown };
    for (const value of [parsed.detail, parsed.error]) {
      if (typeof value === "string" && value.trim() !== "") return value.trim();
    }
  } catch {
    // Not JSON — fall through to the raw body.
  }
  return body.slice(0, 300);
}

export async function getJSON<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, init);
  if (!res.ok) throw new HttpError(url, res.status, await errorDetail(res));
  return res.json() as Promise<T>;
}

export async function getText(url: string, init?: RequestInit): Promise<string> {
  const res = await fetch(url, init);
  if (!res.ok) throw new HttpError(url, res.status, await errorDetail(res));
  return res.text();
}
