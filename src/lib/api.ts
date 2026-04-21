/**
 * Thin fetch wrapper that talks to the serverless API layer.
 * All calls go through /api/... and return JSON.
 */

export type ApiError = Error & { status?: number; body?: unknown };

export async function apiFetch<T>(path: string, init?: RequestInit): Promise<T> {
  const apiKey = import.meta.env.VITE_DASHBOARD_API_KEY as string | undefined;

  const res = await fetch(path, {
    ...init,
    credentials: 'include',
    headers: {
      'Content-Type': 'application/json',
      ...(apiKey ? { 'x-dashboard-key': apiKey } : {}),
      ...(init?.headers || {}),
    },
  });

  if (!res.ok) {
    let body: unknown = null;
    try {
      body = await res.json();
    } catch {
      body = await res.text();
    }
    const err: ApiError = new Error(`API ${res.status}: ${path}`);
    err.status = res.status;
    err.body = body;
    throw err;
  }

  return res.json() as Promise<T>;
}
