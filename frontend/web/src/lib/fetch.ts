export async function getJSON<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, init);
  if (!res.ok) throw new Error(url + " HTTP " + res.status);
  return res.json() as Promise<T>;
}

export async function getText(url: string, init?: RequestInit): Promise<string> {
  const res = await fetch(url, init);
  if (!res.ok) throw new Error(url + " HTTP " + res.status);
  return res.text();
}
