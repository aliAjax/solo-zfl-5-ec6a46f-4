/**
 * WebCrypto 基础封装:PBKDF2 派生密钥 + AES-GCM 加密。
 * 只在内存中持有 CryptoKey,口令与明文不落盘。
 */

const encoder = new TextEncoder()
const decoder = new TextDecoder()

export const IV_BYTES = 12 // AES-GCM 推荐 96 位 IV
export const SALT_BYTES = 16
export const GCM_TAG_BYTES = 16 // 认证标签长度,密文至少要有这么长

export function randomBytes(length: number): Uint8Array {
  const bytes = new Uint8Array(length)
  crypto.getRandomValues(bytes)
  return bytes
}

const B64_RE = /^[A-Za-z0-9+/]*={0,2}$/

/** 严格的 base64 解码:格式非法时返回 null,而不是静默容错 */
export function base64ToBytes(b64: string): Uint8Array | null {
  if (typeof b64 !== 'string' || b64.length === 0 || b64.length % 4 !== 0 || !B64_RE.test(b64)) {
    return null
  }
  try {
    const bin = atob(b64)
    const bytes = new Uint8Array(bin.length)
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
    return bytes
  } catch {
    return null
  }
}

export function bytesToBase64(bytes: Uint8Array): string {
  let bin = ''
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i])
  return btoa(bin)
}

export async function deriveKey(
  passphrase: string,
  salt: Uint8Array,
  iterations: number,
): Promise<CryptoKey> {
  const material = await crypto.subtle.importKey(
    'raw',
    encoder.encode(passphrase) as BufferSource,
    'PBKDF2',
    false,
    ['deriveKey'],
  )
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt: salt as BufferSource, iterations, hash: 'SHA-256' },
    material,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  )
}

/** 派生独立的 HMAC 密钥(与数据加密密钥使用不同的盐),用于保险箱整体完整性签名 */
export async function deriveMacKey(
  passphrase: string,
  salt: Uint8Array,
  iterations: number,
): Promise<CryptoKey> {
  const material = await crypto.subtle.importKey(
    'raw',
    encoder.encode(passphrase) as BufferSource,
    'PBKDF2',
    false,
    ['deriveKey'],
  )
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt: salt as BufferSource, iterations, hash: 'SHA-256' },
    material,
    { name: 'HMAC', hash: 'SHA-256', length: 256 },
    false,
    ['sign'],
  )
}

export async function hmacSign(key: CryptoKey, text: string): Promise<string> {
  const sig = await crypto.subtle.sign('HMAC', key, encoder.encode(text) as BufferSource)
  return bytesToBase64(new Uint8Array(sig))
}

export interface CipherEnvelope {
  iv: string
  ct: string
}

export async function encryptText(key: CryptoKey, plaintext: string): Promise<CipherEnvelope> {
  const iv = randomBytes(IV_BYTES)
  const ct = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv: iv as BufferSource },
    key,
    encoder.encode(plaintext) as BufferSource,
  )
  return { iv: bytesToBase64(iv), ct: bytesToBase64(new Uint8Array(ct)) }
}

/** 解密失败(密钥错误 / 密文被篡改 / 长度异常)一律抛异常,绝不返回部分明文 */
export async function decryptText(key: CryptoKey, envelope: CipherEnvelope): Promise<string> {
  const iv = base64ToBytes(envelope.iv)
  const ct = base64ToBytes(envelope.ct)
  if (!iv || iv.length !== IV_BYTES) throw new Error('IV 长度异常')
  if (!ct || ct.length < GCM_TAG_BYTES) throw new Error('密文长度异常')
  const plain = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: iv as BufferSource },
    key,
    ct as BufferSource,
  )
  return decoder.decode(plain)
}
