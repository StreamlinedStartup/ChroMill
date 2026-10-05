import { vi } from "vitest"
export function area(initial: Record<string, unknown> = {}) {
  const state = structuredClone(initial)
  const api = {
    get: vi.fn(async (keys: string | string[] | null) => Object.fromEntries(Object.entries(state).filter(([key]) => keys === null || (Array.isArray(keys) ? keys.includes(key) : keys === key)))),
    set: vi.fn(async (values: Record<string, unknown>) => { Object.assign(state, structuredClone(values)) }),
    remove: vi.fn(async (keys: string | string[]) => { for (const key of Array.isArray(keys) ? keys : [keys]) delete state[key] }),
    clear: vi.fn(async () => { for (const key of Object.keys(state)) delete state[key] })
  }
  return { state, api: api as unknown as chrome.storage.StorageArea, mocks: api }
}
