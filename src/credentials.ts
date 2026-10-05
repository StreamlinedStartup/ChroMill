import { publicOrigin } from "./connection"

export const CREDENTIALS = "encryptedCredentials"
export const UNLOCK = "credentialUnlock"
const iterations = 600000
const encoder = new TextEncoder()
const aad = (instance: string) => encoder.encode("Run Radar credentials v1:" + instance)
export class CredentialError extends Error {
  constructor(public code: string) { super(code) }
}
export type CredentialRecord = { version: 1; instance: string; salt: string; iv: string; ciphertext: string }
export type Credentials = { instance: string; apiKey: string }
const encode = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes))
function decode(value: string) {
  return Uint8Array.from(atob(value), character => character.charCodeAt(0))
}
export function credentialInput(instance: unknown, apiKey: unknown, password: unknown): instance is string {
  return publicOrigin(instance) && typeof apiKey === "string" && /^[\x21-\x7e]{8,4096}$/.test(apiKey) &&
    typeof password === "string" && password.length >= 12 && password.length <= 1024
}
export function credentialRecord(value: unknown): value is CredentialRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false
  const item = value as CredentialRecord
  return Object.keys(item).sort().join(",") === "ciphertext,instance,iv,salt,version" && item.version === 1 && publicOrigin(item.instance) &&
    typeof item.salt === "string" && /^[A-Za-z0-9+/]{22}==$/.test(item.salt) &&
    typeof item.iv === "string" && /^[A-Za-z0-9+/]{16}$/.test(item.iv) &&
    typeof item.ciphertext === "string" && item.ciphertext.length >= 24 && item.ciphertext.length <= 12000 &&
    /^[A-Za-z0-9+/]+={0,2}$/.test(item.ciphertext)
}
async function derive(password: string, salt: Uint8Array) {
  const material = await crypto.subtle.importKey("raw", encoder.encode(password), "PBKDF2", false, ["deriveKey"])
  return crypto.subtle.deriveKey({ name: "PBKDF2", hash: "SHA-256", salt, iterations }, material,
    { name: "AES-GCM", length: 256 }, true, ["encrypt", "decrypt"])
}
export async function encryptCredentials(instance: string, apiKey: string, password: string) {
  if (!credentialInput(instance, apiKey, password)) throw new CredentialError("credentials_invalid")
  const salt = crypto.getRandomValues(new Uint8Array(16)), iv = crypto.getRandomValues(new Uint8Array(12))
  const key = await derive(password, salt)
  const ciphertext = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: aad(instance) }, key,
    encoder.encode(JSON.stringify({ instance, apiKey }))))
  const record: CredentialRecord = { version: 1, instance, salt: encode(salt), iv: encode(iv), ciphertext: encode(ciphertext) }
  return { record, unlock: { ciphertext: record.ciphertext, key: encode(new Uint8Array(await crypto.subtle.exportKey("raw", key))) } }
}
export async function decryptCredentials(record: CredentialRecord, key: CryptoKey): Promise<Credentials> {
  try {
    const value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: decode(record.iv), additionalData: aad(record.instance) }, key, decode(record.ciphertext))))
    if (!value || Object.keys(value).sort().join(",") !== "apiKey,instance" || value.instance !== record.instance ||
      !credentialInput(value.instance, value.apiKey, "validation-only")) throw new Error("Invalid record")
    return value
  } catch { throw new CredentialError("unlock_failed") }
}
export async function passwordUnlock(record: CredentialRecord, password: unknown) {
  if (typeof password !== "string" || password.length < 12 || password.length > 1024) throw new CredentialError("unlock_failed")
  const key = await derive(password, decode(record.salt))
  await decryptCredentials(record, key)
  return { ciphertext: record.ciphertext, key: encode(new Uint8Array(await crypto.subtle.exportKey("raw", key))) }
}
export function createCredentialStore(local: chrome.storage.StorageArea, session: chrome.storage.StorageArea) {
  async function record(): Promise<CredentialRecord | null> {
    const saved = (await local.get(CREDENTIALS))[CREDENTIALS]
    if (saved === undefined) return null
    if (!credentialRecord(saved)) throw new CredentialError("credentials_invalid")
    return saved
  }
  async function read(): Promise<Credentials | null> {
    const saved = await record()
    if (!saved) return null
    const unlock = (await session.get(UNLOCK))[UNLOCK] as Record<string, unknown> | undefined
    if (!unlock || Object.keys(unlock).sort().join(",") !== "ciphertext,key" || unlock.ciphertext !== saved.ciphertext ||
      typeof unlock.key !== "string" || !/^[A-Za-z0-9+/]{43}=$/.test(unlock.key)) throw new CredentialError("credentials_locked")
    const key = await crypto.subtle.importKey("raw", decode(unlock.key), "AES-GCM", false, ["decrypt"])
    return decryptCredentials(saved, key)
  }
  return { record, read, lock: () => session.remove(UNLOCK),
    async status() {
      const saved = await record()
      if (!saved) return { ok: true as const, saved: false, locked: false, instance: null }
      try { await read(); return { ok: true as const, saved: true, locked: false, instance: saved.instance } }
      catch (error) {
        if (error instanceof CredentialError && ["credentials_locked", "unlock_failed"].includes(error.code)) {
          return { ok: true as const, saved: true, locked: true, instance: saved.instance }
        }
        throw error
      }
    },
    async save(instance: string, apiKey: string, password: string, replace: boolean) {
      const previous = await record()
      if (!!previous !== replace) throw new CredentialError("credentials_conflict")
      const encrypted = await encryptCredentials(instance, apiKey, password)
      // Clear the old unlock first. Any later write failure leaves a locked record.
      await session.remove(UNLOCK)
      await local.set({ [CREDENTIALS]: encrypted.record })
      await session.set({ [UNLOCK]: encrypted.unlock })
    },
    async unlock(password: unknown) {
      const saved = await record()
      if (!saved) throw new CredentialError("credentials_invalid")
      const unlock = await passwordUnlock(saved, password)
      await session.set({ [UNLOCK]: unlock })
    },
    async remove() { await session.remove(UNLOCK); await local.remove(CREDENTIALS) }
  }
}
export function isCredentialStatus(value: unknown): value is { ok: true; saved: boolean; locked: boolean; instance: string | null } {
  if (!value || typeof value !== "object") return false
  const item = value as Record<string, unknown>
  return Object.keys(item).sort().join(",") === "instance,locked,ok,saved" && item.ok === true && typeof item.saved === "boolean" &&
    typeof item.locked === "boolean" && (item.saved ? publicOrigin(item.instance) : item.instance === null && !item.locked)
}
