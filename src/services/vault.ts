/**
 * 本地保险箱:窗景数据只以密文形式写入本地存储。
 *
 * 设计要点:
 * - 口令经 PBKDF2 派生 AES-GCM 密钥,密钥只存在于解锁后的内存里。
 * - 整个保险箱(元信息 + 全部密文记录)存在同一个 key 下,
 *   每次变更(增删记录、换口令)都在内存里构建完整新文件后一次性写入,
 *   写失败(如存储超限)不会留下半加密状态。
 * - 每条记录独立 IV 加密;读取时逐条做结构校验(IV/密文长度)和
 *   GCM 完整性校验,被篡改或长度异常的记录会被识别出来并计数,
 *   绝不会被当成正常记录返回。
 * - 口令正确性通过 canary 密文验证,错口令明确拒绝且不触碰已有数据。
 */

import type { WindowScene } from '@/types'
import {
  deriveKey,
  encryptText,
  decryptText,
  randomBytes,
  base64ToBytes,
  bytesToBase64,
  SALT_BYTES,
  IV_BYTES,
  GCM_TAG_BYTES,
  type CipherEnvelope,
} from './crypto'

export const VAULT_KEY = 'bus_window_vault'
export const LEGACY_KEY = 'bus_window_scenes'
export const LEGACY_BACKUP_KEY = 'bus_window_scenes.legacy-backup'

const CANARY = 'window-scene-vault:v1'
const DEFAULT_ITERATIONS = 250_000
/** 单条密文的合理上限,超过视为长度异常 */
const MAX_CT_BYTES = 256 * 1024

export type VaultStatus = 'uninitialized' | 'locked' | 'unlocked'

export type VaultErrorCode =
  | 'WRONG_PASSPHRASE'
  | 'VAULT_CORRUPTED'
  | 'VAULT_EXISTS'
  | 'NOT_INITIALIZED'
  | 'LOCKED'
  | 'WEAK_PASSPHRASE'
  | 'STORAGE_FULL'

export class VaultError extends Error {
  constructor(
    public readonly code: VaultErrorCode,
    message: string,
  ) {
    super(message)
    this.name = 'VaultError'
  }
}

/** 可注入的存储后端,默认 localStorage,测试可换内存实现 */
export interface VaultStorage {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
  removeItem(key: string): void
}

function defaultStorage(): VaultStorage {
  if (typeof localStorage !== 'undefined') return localStorage as VaultStorage
  // 非浏览器环境(如单元测试)下的内存兜底
  const map = new Map<string, string>()
  return {
    getItem: (key) => (map.has(key) ? map.get(key)! : null),
    setItem: (key, value) => void map.set(key, value),
    removeItem: (key) => void map.delete(key),
  }
}

interface VaultMeta {
  v: 1
  kdf: { name: 'PBKDF2'; hash: 'SHA-256'; iterations: number; salt: string }
  verifier: CipherEnvelope
}

interface VaultRecord extends CipherEnvelope {
  id: string
}

interface VaultFile {
  v: 1
  meta: VaultMeta
  records: VaultRecord[]
}

interface ParsedVault {
  meta: VaultMeta
  goodRecords: VaultRecord[]
  /** 结构/长度就不合法的记录,保留在文件里作为篡改证据,但绝不参与读取 */
  badRecords: VaultRecord[]
}

export interface VaultOptions {
  iterations?: number
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

/** 校验单条密文信封的结构与长度,不合法即视为被篡改 */
function isValidEnvelope(rec: unknown): rec is VaultRecord {
  if (!isRecord(rec)) return false
  if (typeof rec.id !== 'string' || typeof rec.iv !== 'string' || typeof rec.ct !== 'string') {
    return false
  }
  const iv = base64ToBytes(rec.iv)
  if (!iv || iv.length !== IV_BYTES) return false
  const ct = base64ToBytes(rec.ct)
  if (!ct || ct.length < GCM_TAG_BYTES || ct.length > MAX_CT_BYTES) return false
  return true
}

function parseMeta(meta: unknown): VaultMeta {
  if (!isRecord(meta) || meta.v !== 1) throw new VaultError('VAULT_CORRUPTED', '保险箱元信息损坏')
  const kdf = meta.kdf
  if (
    !isRecord(kdf) ||
    kdf.name !== 'PBKDF2' ||
    kdf.hash !== 'SHA-256' ||
    typeof kdf.iterations !== 'number' ||
    kdf.iterations < 1 ||
    typeof kdf.salt !== 'string'
  ) {
    throw new VaultError('VAULT_CORRUPTED', '保险箱密钥参数损坏')
  }
  const salt = base64ToBytes(kdf.salt)
  if (!salt || salt.length !== SALT_BYTES) {
    throw new VaultError('VAULT_CORRUPTED', '保险箱盐值损坏')
  }
  if (!isValidEnvelope({ id: 'verifier', ...(meta.verifier as object) })) {
    throw new VaultError('VAULT_CORRUPTED', '保险箱校验数据损坏')
  }
  return meta as unknown as VaultMeta
}

export class Vault {
  private storage: VaultStorage
  private iterations: number

  private key: CryptoKey | null = null
  private meta: VaultMeta | null = null
  private scenes: WindowScene[] = []
  private badRecords: VaultRecord[] = []
  private corruptedCount = 0
  private status: VaultStatus = 'uninitialized'

  constructor(storage?: VaultStorage, options: VaultOptions = {}) {
    this.storage = storage ?? defaultStorage()
    this.iterations = options.iterations ?? DEFAULT_ITERATIONS
    this.refreshStatus()
  }

  private refreshStatus() {
    this.status = this.key
      ? 'unlocked'
      : this.storage.getItem(VAULT_KEY) !== null
        ? 'locked'
        : 'uninitialized'
  }

  getStatus(): VaultStatus {
    return this.status
  }

  isInitialized(): boolean {
    return this.storage.getItem(VAULT_KEY) !== null
  }

  getCorruptedCount(): number {
    return this.corruptedCount
  }

  private assertUnlocked() {
    if (this.status !== 'unlocked' || !this.key || !this.meta) {
      throw new VaultError('LOCKED', '保险箱未解锁')
    }
  }

  /** 读取并结构校验保险箱文件;文件本身损坏时抛 VAULT_CORRUPTED */
  private readVaultFile(): ParsedVault {
    const raw = this.storage.getItem(VAULT_KEY)
    if (raw === null) throw new VaultError('NOT_INITIALIZED', '保险箱尚未创建')
    let parsed: unknown
    try {
      parsed = JSON.parse(raw)
    } catch {
      throw new VaultError('VAULT_CORRUPTED', '保险箱数据已损坏,无法解析')
    }
    if (!isRecord(parsed) || parsed.v !== 1 || !Array.isArray(parsed.records)) {
      throw new VaultError('VAULT_CORRUPTED', '保险箱数据结构异常')
    }
    const meta = parseMeta(parsed.meta)
    const goodRecords: VaultRecord[] = []
    const badRecords: VaultRecord[] = []
    for (const rec of parsed.records) {
      ;(isValidEnvelope(rec) ? goodRecords : badRecords).push(rec as VaultRecord)
    }
    return { meta, goodRecords, badRecords }
  }

  /** 用给定口令派生密钥并验证 canary,错口令抛 WRONG_PASSPHRASE */
  private async deriveAndVerify(passphrase: string, meta: VaultMeta): Promise<CryptoKey> {
    const salt = base64ToBytes(meta.kdf.salt)!
    const key = await deriveKey(passphrase, salt, meta.kdf.iterations)
    let canary: string
    try {
      canary = await decryptText(key, meta.verifier)
    } catch {
      throw new VaultError('WRONG_PASSPHRASE', '口令不正确')
    }
    if (canary !== CANARY) throw new VaultError('WRONG_PASSPHRASE', '口令不正确')
    return key
  }

  private async encryptRecords(key: CryptoKey, scenes: WindowScene[]): Promise<VaultRecord[]> {
    const records: VaultRecord[] = []
    for (const scene of scenes) {
      const { iv, ct } = await encryptText(key, JSON.stringify(scene))
      records.push({ id: scene.id, iv, ct })
    }
    return records
  }

  /** 全量重写保险箱文件(单次 setItem,原子;失败则磁盘保持原样) */
  private writeVaultFile(meta: VaultMeta, records: VaultRecord[]) {
    const file: VaultFile = { v: 1, meta, records }
    try {
      this.storage.setItem(VAULT_KEY, JSON.stringify(file))
    } catch {
      throw new VaultError('STORAGE_FULL', '本地存储写入失败,数据未更改')
    }
  }

  private async persist() {
    this.assertUnlocked()
    const records = await this.encryptRecords(this.key!, this.scenes)
    // 已损坏的记录原样保留在文件里,不静默丢弃
    this.writeVaultFile(this.meta!, [...records, ...this.badRecords])
  }

  /** 迁移旧版明文数据:成功导入保险箱后删除明文 key */
  private async importLegacy() {
    const raw = this.storage.getItem(LEGACY_KEY)
    if (raw === null) return
    let legacy: WindowScene[] = []
    try {
      const parsed = JSON.parse(raw)
      if (Array.isArray(parsed)) legacy = parsed as WindowScene[]
    } catch {
      // 旧数据本身已损坏,备份后移除,避免明文残留
    }
    if (legacy.length > 0) {
      const known = new Set(this.scenes.map((s) => s.id))
      for (const scene of legacy) {
        if (scene && typeof scene.id === 'string' && !known.has(scene.id)) {
          this.scenes.push(scene)
        }
      }
      await this.persist()
    }
    this.storage.removeItem(LEGACY_KEY)
    if (legacy.length === 0 && raw !== '[]') {
      try {
        if (this.storage.getItem(LEGACY_BACKUP_KEY) === null) {
          this.storage.setItem(LEGACY_BACKUP_KEY, raw)
        }
      } catch {
        /* 备份失败不阻塞主流程 */
      }
    }
  }

  /** 首次设置口令:创建保险箱并迁移已有明文数据 */
  async setup(passphrase: string): Promise<void> {
    if (this.isInitialized()) throw new VaultError('VAULT_EXISTS', '保险箱已存在')
    if (!passphrase || passphrase.length < 4) {
      throw new VaultError('WEAK_PASSPHRASE', '口令至少需要 4 个字符')
    }

    const salt = randomBytes(SALT_BYTES)
    const key = await deriveKey(passphrase, salt, this.iterations)
    const meta: VaultMeta = {
      v: 1,
      kdf: { name: 'PBKDF2', hash: 'SHA-256', iterations: this.iterations, salt: bytesToBase64(salt) },
      verifier: await encryptText(key, CANARY),
    }

    // 先在内存里构建完整文件,再一次写入;任何一步失败都不会产生半成品
    let legacy: WindowScene[] = []
    const rawLegacy = this.storage.getItem(LEGACY_KEY)
    if (rawLegacy !== null) {
      try {
        const parsed = JSON.parse(rawLegacy)
        if (Array.isArray(parsed)) legacy = parsed as WindowScene[]
      } catch {
        legacy = []
      }
    }
    const records = await this.encryptRecords(key, legacy)
    this.writeVaultFile(meta, records)

    // 写入成功后才清理明文与更新内存状态
    if (rawLegacy !== null) {
      this.storage.removeItem(LEGACY_KEY)
      if (legacy.length === 0 && rawLegacy !== '[]') {
        try {
          this.storage.setItem(LEGACY_BACKUP_KEY, rawLegacy)
        } catch {
          /* 备份失败不阻塞 */
        }
      }
    }
    this.key = key
    this.meta = meta
    this.scenes = legacy
    this.badRecords = []
    this.corruptedCount = 0
    this.status = 'unlocked'
  }

  /**
   * 解锁。重复解锁是幂等操作:已解锁时直接返回。
   * 错口令抛 WRONG_PASSPHRASE,已有数据不受任何影响。
   */
  async unlock(passphrase: string): Promise<{ corrupted: number }> {
    if (this.status === 'unlocked') return { corrupted: this.corruptedCount }
    const { meta, goodRecords, badRecords } = this.readVaultFile()
    const key = await this.deriveAndVerify(passphrase, meta)

    const scenes: WindowScene[] = []
    let corrupted = badRecords.length
    for (const rec of goodRecords) {
      try {
        scenes.push(JSON.parse(await decryptText(key, rec)) as WindowScene)
      } catch {
        // GCM 校验失败:记录被篡改,不计入正常数据
        corrupted++
        badRecords.push(rec)
      }
    }

    this.key = key
    this.meta = meta
    this.scenes = scenes
    this.badRecords = badRecords
    this.corruptedCount = corrupted
    this.status = 'unlocked'

    await this.importLegacy()
    return { corrupted }
  }

  /** 锁定:清空内存中的密钥与全部明文缓存 */
  lock(): void {
    this.key = null
    this.meta = null
    this.scenes = []
    this.badRecords = []
    this.corruptedCount = 0
    this.refreshStatus()
  }

  /**
   * 换口令:在内存里用新口令完整重加密全部数据后一次性重写。
   * 任一步失败(旧口令错、存储写失败)都抛异常,磁盘上的旧保险箱保持原样,
   * 不会留下半加密状态。已损坏的记录无法重加密,原样保留。
   */
  async changePassphrase(current: string, next: string): Promise<void> {
    this.assertUnlocked()
    if (!next || next.length < 4) {
      throw new VaultError('WEAK_PASSPHRASE', '新口令至少需要 4 个字符')
    }
    // 先验证当前口令,错了直接拒绝,不写任何东西
    await this.deriveAndVerify(current, this.meta!)

    const salt = randomBytes(SALT_BYTES)
    const newKey = await deriveKey(next, salt, this.iterations)
    const newMeta: VaultMeta = {
      v: 1,
      kdf: { name: 'PBKDF2', hash: 'SHA-256', iterations: this.iterations, salt: bytesToBase64(salt) },
      verifier: await encryptText(newKey, CANARY),
    }
    const newRecords = await this.encryptRecords(newKey, this.scenes)
    // 唯一一次写盘;setItem 失败时旧文件原封不动
    this.writeVaultFile(newMeta, [...newRecords, ...this.badRecords])

    this.key = newKey
    this.meta = newMeta
  }

  getScenes(): WindowScene[] {
    this.assertUnlocked()
    return [...this.scenes]
  }

  async addScene(scene: WindowScene): Promise<void> {
    this.assertUnlocked()
    this.scenes.push(scene)
    try {
      await this.persist()
    } catch (err) {
      this.scenes.pop()
      throw err
    }
  }

  async deleteScene(id: string): Promise<void> {
    this.assertUnlocked()
    const index = this.scenes.findIndex((s) => s.id === id)
    if (index === -1) return
    const [removed] = this.scenes.splice(index, 1)
    try {
      await this.persist()
    } catch (err) {
      this.scenes.splice(index, 0, removed)
      throw err
    }
  }
}

/** 应用内使用的单例 */
export const vault = new Vault()
