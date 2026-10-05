// @vitest-environment node
import { describe, it, expect } from "vitest"
import { CREDENTIALS, UNLOCK, createCredentialStore, encryptCredentials, passwordUnlock, credentialRecord } from "../../src/credentials"

import { area } from "./credential-fixture"
const instance = "https://fixture.example", token = "synthetic-test-token", password = "synthetic-password-only"
describe("password credential records", () => {
  it("uses random authenticated ciphertext and stores unlock only in session", async () => {
    const local = area(), session = area(), store = createCredentialStore(local.api, session.api)
    await store.save(instance, token, password, false)
    expect(credentialRecord(local.state[CREDENTIALS])).toBe(true)
    expect(JSON.stringify(local.state)).not.toContain(token)
    expect(JSON.stringify(local.state)).not.toContain(password)
    expect(Object.keys(local.state)).toEqual([CREDENTIALS])
    expect(Object.keys(session.state)).toEqual([UNLOCK])
    expect(await store.read()).toEqual({ instance, apiKey: token })
    const other = await encryptCredentials(instance, token, password)
    expect(other.record).not.toEqual(local.state[CREDENTIALS])
  })
  it("rejects tampering, password errors, unbounded records, and unsafe origins", async () => {
    const { record } = await encryptCredentials(instance, token, password)
    await expect(passwordUnlock(record, "wrong-password-only")).rejects.toMatchObject({ code: "unlock_failed" })
    for (const tampered of [{ ...record, instance: "https://other.example" }, { ...record, ciphertext: (record.ciphertext[0] === "A" ? "B" : "A") + record.ciphertext.slice(1) }]) {
      await expect(passwordUnlock(tampered, password)).rejects.toMatchObject({ code: "unlock_failed" })
    }
    expect(credentialRecord({ ...record, ciphertext: "A".repeat(12001) })).toBe(false)
    for (const origin of ["http://remote.example", "https://user:pass@fixture.example", "https://fixture.example/path", "https://fixture.example?query", "file:///tmp/a"]) {
      await expect(encryptCredentials(origin, token, password)).rejects.toMatchObject({ code: "credentials_invalid" })
    }
  })
  it("survives worker suspension, locks on restart, replaces, removes, and never recovers an old unlock", async () => {
    const local = area(), session = area(), store = createCredentialStore(local.api, session.api)
    await store.save(instance, token, password, false)
    const oldUnlock = structuredClone(session.state[UNLOCK])
    expect(await createCredentialStore(local.api, session.api).read()).toEqual({ instance, apiKey: token })
    const restarted = createCredentialStore(local.api, area().api)
    expect(await restarted.status()).toMatchObject({ saved: true, locked: true })
    await expect(restarted.read()).rejects.toMatchObject({ code: "credentials_locked" })
    await store.lock()
    await store.unlock(password)
    await store.save("https://second.example", "synthetic-new-token", "another-password-only", true)
    session.state[UNLOCK] = oldUnlock
    await expect(store.read()).rejects.toMatchObject({ code: "credentials_locked" })
    await store.unlock("another-password-only")
    expect(await store.read()).toMatchObject({ instance: "https://second.example" })
    await store.remove()
    expect(await store.read()).toBeNull()
    expect(local.state).toEqual({}); expect(session.state).toEqual({})
  })
  it("exposes local and session failures and keeps failed replacement locked", async () => {
    const local = area(), session = area(), store = createCredentialStore(local.api, session.api)
    await store.save(instance, token, password, false)
    local.mocks.set.mockRejectedValueOnce(new Error("synthetic storage failure"))
    await expect(store.save(instance, token, password, true)).rejects.toThrow("synthetic storage failure")
    expect(await store.status()).toMatchObject({ saved: true, locked: true })
    session.mocks.set.mockRejectedValueOnce(new Error("synthetic session failure"))
    await expect(store.save(instance, token, password, true)).rejects.toThrow("synthetic session failure")
    expect(await store.status()).toMatchObject({ locked: true })
    local.mocks.remove.mockRejectedValueOnce(new Error("synthetic remove failure"))
    await expect(store.remove()).rejects.toThrow("synthetic remove failure")
    expect(await store.status()).toMatchObject({ locked: true })
    await expect(store.save(instance, token, password, false)).rejects.toMatchObject({ code: "credentials_conflict" })
    session.mocks.remove.mockRejectedValueOnce(new Error("synthetic lock failure"))
    await expect(store.lock()).rejects.toThrow("synthetic lock failure")
    local.mocks.get.mockRejectedValueOnce(new Error("synthetic read failure"))
    await expect(store.status()).rejects.toThrow("synthetic read failure")
  })
})
