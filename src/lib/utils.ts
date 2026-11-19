import { clsx, type ClassValue } from 'clsx'
import { twMerge } from 'tailwind-merge'
import { getAuthToken } from 'deepspace'

export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs))
}

export type ActionResult<T> =
  | { success: true; data: T }
  | { success: false; error: string; code?: string; details?: Record<string, unknown> }

/** POST /api/actions/:name with the signed-in user's JWT. */
export async function callAction<T>(name: string, body: Record<string, unknown> = {}): Promise<ActionResult<T>> {
  const token = await getAuthToken()
  if (!token) return { success: false, error: 'Sign in to continue.', code: 'unauthorized' }
  try {
    const res = await fetch(`/api/actions/${name}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify(body),
    })
    return (await res.json()) as ActionResult<T>
  } catch {
    return { success: false, error: 'Network error. Check your connection and try again.' }
  }
}

/** GET a same-origin API route with the signed-in user's JWT; null on failure. */
export async function authedGet<T>(path: string): Promise<T | null> {
  const token = await getAuthToken()
  if (!token) return null
  try {
    const res = await fetch(path, { headers: { Authorization: `Bearer ${token}` } })
    return res.ok ? ((await res.json()) as T) : null
  } catch {
    return null
  }
}
