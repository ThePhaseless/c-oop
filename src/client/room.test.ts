import { expect, test } from 'bun:test'
import { SECRET_RE, TOPIC_RE } from '../shared/limits'
import { deriveRoom, newSecret, parseSecret } from './room'

test('newSecret gives 22 base64url chars and differs between calls', () => {
  const a = newSecret(), b = newSecret()
  expect(a).toMatch(SECRET_RE)
  expect(b).toMatch(SECRET_RE)
  expect(a).not.toBe(b)
})

test('parseSecret accepts a secret with or without the leading #', () => {
  const s = newSecret()
  expect(parseSecret('#' + s)).toBe(s)
  expect(parseSecret(s)).toBe(s)
})

test('parseSecret rejects wrong lengths and characters', () => {
  const s = newSecret()
  for (const bad of ['', '#', '#' + s.slice(1), '#' + s + 'A', '#' + s.slice(1) + '+', '#' + s.slice(1) + '/', '#' + s.slice(1) + ' ', '##' + s, '#' + s + '\n'])
    expect(parseSecret(bad)).toBeNull()
})

test('deriveRoom is deterministic and keeps the secret out of topic and password', async () => {
  const secret = 'AAAAAAAAAAAAAAAAAAAAAA'
  const keys = await deriveRoom(secret)
  const again = await deriveRoom(secret)
  expect([again.secret, again.topic, again.password]).toEqual([keys.secret, keys.topic, keys.password])
  expect(keys.secret).toBe(secret)
  expect(keys.topic).toMatch(TOPIC_RE)
  expect(keys.password).toMatch(/^[A-Za-z0-9_-]{43}$/)
  const all = [keys.secret, keys.topic, keys.password]
  for (const x of all) for (const y of all) if (x !== y) expect(x.includes(y)).toBe(false)
  expect(new Set(all).size).toBe(3)
  expect((await deriveRoom(newSecret())).topic).not.toBe(keys.topic)
})

test('the relay key of one secret decrypts what another derivation of it encrypted, and no other secret does', async () => {
  const secret = newSecret()
  const [a, b, other] = await Promise.all([deriveRoom(secret), deriveRoom(secret), deriveRoom(newSecret())])
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const sealed = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, a.relayKey, new TextEncoder().encode('hello'))
  expect(new TextDecoder().decode(await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, b.relayKey, sealed))).toBe('hello')
  await expect(crypto.subtle.decrypt({ name: 'AES-GCM', iv }, other.relayKey, sealed)).rejects.toThrow()
  expect(a.relayKey.extractable).toBe(false)
})
