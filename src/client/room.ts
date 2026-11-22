// Room keys. The secret lives only in location.hash; the server sees the topic and ciphertext.
import type { RoomKeys } from '../shared/contracts'
import { SECRET_RE } from '../shared/limits'

const base64url = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
const sha256 = async (text: string) => new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)))

export const newSecret = (): string => base64url(crypto.getRandomValues(new Uint8Array(16)))

/** `hash` is location.hash, with or without the leading '#'. */
export function parseSecret(hash: string): string | null {
  const s = hash.startsWith('#') ? hash.slice(1) : hash
  return SECRET_RE.test(s) ? s : null
}

// A protocol change bumps v1, which puts incompatible app versions in different rooms.
export async function deriveRoom(secret: string): Promise<RoomKeys> {
  const [topic, key] = await Promise.all([sha256('c-oop/v1/topic:' + secret), sha256('c-oop/v1/key:' + secret)])
  return { secret, topic: Array.from(topic.subarray(0, 16), b => b.toString(16).padStart(2, '0')).join(''), password: base64url(key) }
}
