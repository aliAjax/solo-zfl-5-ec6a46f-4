/**
 * 本地保险箱:窗景数据只以密文形式写入本地存储。
 *
 * 设计要点:
 * - 口令经 PBKDF2 派生两把独立密钥(不同盐):AES-GCM 数据密钥加密记录,
 *   HMAC 密钥给保险箱整体签名。密钥只存在于解锁后的内存里。
 * - 两层完整性:
 *   a) 每条记录独立 IV 加密,GCM 认证标签发现单条密文的内容改动,
 *      被改的记录被识别、计数、跳过,绝不当成正常记录读出;
 *   b) 清单签名(manifest)覆盖「记录 id 序列 + 删除墓碑 + 加密备份」,
 *      拿掉整条记录、调整顺序、塞入记录、改动墓碑都会被发现并拒绝解锁。
 * - 整个保险箱存在同一个 key 下,每次变更在内存构建完整新文件后,
 *   通过「读-合并-比对-写」的 CAS 循环一次性写入:写失败不留半加密状态,
 *   多标签页并发保存互不覆盖,其他页面换了口令则本页写入被拒绝。
 * - 口令正确性通过 canary 密文验证,错口令明确拒绝且不触碰已有数据。
 * - 旧版明文数据(包括非法内容)在设置口令/解锁时迁入保险箱:
 *   合法记录逐条加密,非法原文整体加密为备份字段,本地不留任何明文。
 */

import type { WindowScene } from '@/types'
import {
  deriveKey,
  deriveMacKey,
  hmacSign,
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
/** 上一版曾使用的明文备份 key,现在只用于清理,绝不再写入 */
export const LEGACY_BACKUP_KEY = 'bus_window_scenes.legacy-backup'

const CANARY = 'window-scene-vault:v1'
const DEFAULT_ITERATIONS = 250_000
/** 并发写冲突时的最大重试次数 */
const MAX_CAS_ATTEMPTS = 10

export type VaultStatus = 'uninitialized' | 'locked' | 'unlocked'

export type VaultErrorCode =
  | 'WRONG_PASSPHRASE'
  | 'VAULT_CORRUPTED'
  | 'VAULT_EXISTS'
  | 'NOT_INITIALIZED'
  | 'LOCKED'
  | 'WEAK_PASSPHRASE'
  | 'STORAGE_FULL'
  | 'VAULT_CHANGED'

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
  kdf: { name: 'PBKDF2'; hash: 'SHA-256'; iterations: number; salt: string; macSalt: string }
  verifier: CipherEnvelope
}

interface VaultRecord extends CipherEnvelope {
  id: string
}

interface VaultFile {
  v: 1
  meta: VaultMeta
  records: VaultRecord[]
  /** 已删除记录的 id(随机 UUID,不含敏感信息),防止其他页面的旧副本复活删除 */
  tombstones: string[]
  /** 无法解析的旧版明文,加密后收在这里,本地不留明文 */
  legacyBackup?: CipherEnvelope
  /** 整体完整性签名:HMAC(记录 id 序列 + 墓碑 + 备份) */
  manifest: string
}

interface ParsedVault {
  meta: VaultMeta
  goodRecords: VaultRecord[]
  /** 结构/长度就不合法的记录,保留在文件里作为篡改证据,但绝不参与读取 */
  badRecords: VaultRecord[]
  tombstones: string[]
  /** 文件中 records 数组的原始 id 序列(含非法条目),用于清单验签 */
  rawIds: string[]
  legacyBackup: CipherEnvelope | null
  manifest: string
}

export interface VaultOptions {
  iterations?: number
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

/**
 * 校验单条密文信封的结构与长度,不合法即视为被外部改动。
 * 只校验下限(IV 长度、GCM 标签最小长度):密文没有合法上限,
 * 长记录是正常数据;外部对密文内容的任何改动由 GCM 认证标签发现。
 */
function isValidEnvelope(rec: unknown): rec is VaultRecord {
  if (!isRecord(rec)) return false
  if (typeof rec.id !== 'string' || typeof rec.iv !== 'string' || typeof rec.ct !== 'string') {
    return false
  }
  const iv = base64ToBytes(rec.iv)
  if (!iv || iv.length !== IV_BYTES) return false
  const ct = base64ToBytes(rec.ct)
  if (!ct || ct.length < GCM_TAG_BYTES) return false
  return true
}

function isCipherEnvelope(value: unknown): value is CipherEnvelope {
  return isRecord(value) && typeof value.iv === 'string' && typeof value.ct === 'string'
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
    typeof kdf.salt !== 'string' ||
    typeof kdf.macSalt !== 'string'
  ) {
    throw new VaultError('VAULT_CORRUPTED', '保险箱密钥参数损坏')
  }
  const salt = base64ToBytes(kdf.salt)
  const macSalt = base64ToBytes(kdf.macSalt)
  if (!salt || salt.length !== SALT_BYTES || !macSalt || macSalt.length !== SALT_BYTES) {
    throw new VaultError('VAULT_CORRUPTED', '保险箱盐值损坏')
  }
  if (!isValidEnvelope({ id: 'verifier', ...(meta.verifier as object) })) {
    throw new VaultError('VAULT_CORRUPTED', '保险箱校验数据损坏')
  }
  return meta as unknown as VaultMeta
}

function dedupEnvelopes(...lists: VaultRecord[][]): VaultRecord[] {
  const seen = new Set<string>()
  const out: VaultRecord[] = []
  for (const list of lists) {
    for (const rec of list) {
      const key = rec.id + '|' + rec.ct
      if (!seen.has(key)) {
        seen.add(key)
        out.push(rec)
      }
    }
  }
  return out
}

export class Vault {
  private storage: VaultStorage
  private iterations: number

  private key: CryptoKey | null = null
  private macKey: CryptoKey | null = null
  private meta: VaultMeta | null = null
  private scenes: WindowScene[] = []
  private badRecords: VaultRecord[] = []
  /** 已删除记录 id(含磁盘上的墓碑):合并时防止旧副本复活删除 */
  private deletedIds = new Set<string>()
  private legacyBackup: CipherEnvelope | null = null
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

  /** 清单签名内容:记录 id 序列(保序)+ 墓碑(排序)+ 加密备份 */
  private static manifestInput(
    rawIds: string[],
    tombstones: string[],
    legacyBackup: CipherEnvelope | null,
  ): string {
    return [
      'WSP1',
      rawIds.join(','),
      [...tombstones].sort().join(','),
      JSON.stringify(legacyBackup ?? null),
    ].join('|')
  }

  private async signManifest(
    macKey: CryptoKey,
    records: VaultRecord[],
    tombstones: string[],
    legacyBackup: CipherEnvelope | null,
  ): Promise<string> {
    return hmacSign(
      macKey,
      Vault.manifestInput(
        records.map((r) => r.id),
        tombstones,
        legacyBackup,
      ),
    )
  }

  /** 解析并结构校验保险箱文件内容;文件本身损坏时抛 VAULT_CORRUPTED */
  private parseVaultRaw(raw: string): ParsedVault {
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
    if (typeof parsed.manifest !== 'string' || parsed.manifest.length === 0) {
      throw new VaultError('VAULT_CORRUPTED', '保险箱完整性签名缺失')
    }
    const goodRecords: VaultRecord[] = []
    const badRecords: VaultRecord[] = []
    const rawIds: string[] = []
    for (const rec of parsed.records) {
      rawIds.push(isRecord(rec) && typeof rec.id === 'string' ? rec.id : '?')
      ;(isValidEnvelope(rec) ? goodRecords : badRecords).push(rec as VaultRecord)
    }
    const tombstones = Array.isArray(parsed.tombstones)
      ? parsed.tombstones.filter((t): t is string => typeof t === 'string')
      : []
    const legacyBackup = isCipherEnvelope(parsed.legacyBackup) ? parsed.legacyBackup : null
    return { meta, goodRecords, badRecords, tombstones, rawIds, legacyBackup, manifest: parsed.manifest }
  }

  private readVaultFile(): ParsedVault {
    const raw = this.storage.getItem(VAULT_KEY)
    if (raw === null) throw new VaultError('NOT_INITIALIZED', '保险箱尚未创建')
    return this.parseVaultRaw(raw)
  }

  /** 用给定口令派生数据密钥并验证 canary,错口令抛 WRONG_PASSPHRASE */
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

  /** 单次 setItem 落盘;失败(如存储超限)抛错,磁盘保持原样 */
  private writeRaw(raw: string) {
    try {
      this.storage.setItem(VAULT_KEY, raw)
    } catch {
      throw new VaultError('STORAGE_FULL', '本地存储写入失败,数据未更改')
    }
  }

  private static sameMeta(a: VaultMeta, b: VaultMeta): boolean {
    return (
      a.kdf.salt === b.kdf.salt &&
      a.kdf.macSalt === b.kdf.macSalt &&
      a.kdf.iterations === b.kdf.iterations &&
      a.verifier.iv === b.verifier.iv &&
      a.verifier.ct === b.verifier.ct
    )
  }

  /**
   * 磁盘上的保险箱是否已被其他页面/标签重写(典型场景:另一个标签页换了口令)。
   * 是则本实例的写入必须停止,否则会把别人的口令变更覆盖回去。
   */
  hasExternalChanges(): boolean {
    if (this.status !== 'unlocked' || !this.meta) return false
    const raw = this.storage.getItem(VAULT_KEY)
    if (raw === null) return true
    try {
      const parsed = JSON.parse(raw)
      if (!isRecord(parsed)) return true
      return !Vault.sameMeta(parseMeta(parsed.meta), this.meta)
    } catch {
      return true
    }
  }

  /**
   * 把磁盘上其他页面写入的记录解入内存(尽力而为,不阻塞写路径)。
   * 调用前需确认磁盘元信息与本实例一致。
   */
  private async absorbDiskRecords(envelopes: VaultRecord[]) {
    const known = new Set(this.scenes.map((s) => s.id))
    for (const rec of envelopes) {
      if (known.has(rec.id)) continue
      try {
        const scene = JSON.parse(await decryptText(this.key!, rec)) as WindowScene
        if (!this.deletedIds.has(scene.id) && !known.has(scene.id)) {
          this.scenes.push(scene)
          known.add(scene.id)
        }
      } catch {
        // 解密失败的记录保留在文件里,下次解锁时计入损坏
      }
    }
  }

  /**
   * 全量重写保险箱,采用「读-合并-比对-写」CAS 循环:
   * - 元信息被外部改写(其他标签页换了口令)→ 拒绝,不覆盖别人的变更;
   * - 元信息一致 → 在密文信封层面按 id 合并(其他页面的记录原样保留,
   *   无需解密),签名后写盘;写之前比对磁盘内容,若签名期间被并发修改
   *   则重新合并重试——两个页面同时保存的记录都能保留。
   */
  private async persist() {
    this.assertUnlocked()
    for (let attempt = 0; ; attempt++) {
      const rawBefore = this.storage.getItem(VAULT_KEY)
      if (rawBefore === null) {
        throw new VaultError('VAULT_CHANGED', '保险箱已被其他窗口移除,本次写入被拒绝')
      }
      const disk = this.parseVaultRaw(rawBefore)
      if (!Vault.sameMeta(disk.meta, this.meta!)) {
        throw new VaultError('VAULT_CHANGED', '保险箱已在其他窗口更改(如换了口令),本次写入被拒绝')
      }

      const tombstones = new Set([...disk.tombstones, ...this.deletedIds])
      // 其他页面已删除的记录(磁盘墓碑)先从本页内存剔除,防止旧副本复活删除
      if (tombstones.size > 0) {
        this.scenes = this.scenes.filter((s) => !tombstones.has(s.id))
      }
      const ourRecords = await this.encryptRecords(this.key!, this.scenes)
      const ourIds = new Set(ourRecords.map((r) => r.id))
      const knownBad = new Set(this.badRecords.map((r) => r.id + '|' + r.ct))
      const kept = disk.goodRecords.filter(
        (r) => !ourIds.has(r.id) && !tombstones.has(r.id) && !knownBad.has(r.id + '|' + r.ct),
      )
      const bad = dedupEnvelopes(this.badRecords, disk.badRecords)
      const records = [...kept, ...ourRecords, ...bad]

      const manifest = await this.signManifest(this.macKey!, records, [...tombstones], this.legacyBackup)
      const file: VaultFile = {
        v: 1,
        meta: this.meta!,
        records,
        tombstones: [...tombstones],
        ...(this.legacyBackup ? { legacyBackup: this.legacyBackup } : {}),
        manifest,
      }

      // CAS:比对与写入之间没有 await,其他标签页无法插入;
      // 若加密/签名期间磁盘被并发修改,重试合并
      if (this.storage.getItem(VAULT_KEY) !== rawBefore) {
        if (attempt >= MAX_CAS_ATTEMPTS) {
          throw new VaultError('VAULT_CHANGED', '其他窗口正在频繁写入,请稍后重试')
        }
        continue
      }
      this.writeRaw(JSON.stringify(file))

      this.deletedIds = tombstones
      this.badRecords = bad
      await this.absorbDiskRecords(kept)
      return
    }
  }

  /** 吸收一段旧版明文:合法数组逐条导入;非法原文加密为备份字段,不留明文 */
  private async absorbPlaintext(raw: string, key: CryptoKey) {
    try {
      const parsed = JSON.parse(raw)
      if (Array.isArray(parsed)) {
        const known = new Set(this.scenes.map((s) => s.id))
        for (const scene of parsed as WindowScene[]) {
          if (scene && typeof scene.id === 'string' && !known.has(scene.id)) {
            this.scenes.push(scene)
            known.add(scene.id)
          }
        }
        return
      }
    } catch {
      /* 非 JSON:落入加密备份 */
    }
    if (raw.trim() !== '' && raw.trim() !== '[]' && this.legacyBackup === null) {
      this.legacyBackup = await encryptText(key, raw)
    }
  }

  /** 清理本地残留的明文 key(旧版数据、旧版明文备份),内容迁入保险箱 */
  private async sweepPlaintextKeys() {
    let dirty = false
    for (const key of [LEGACY_KEY, LEGACY_BACKUP_KEY]) {
      const raw = this.storage.getItem(key)
      if (raw === null) continue
      await this.absorbPlaintext(raw, this.key!)
      this.storage.removeItem(key)
      dirty = true
    }
    if (dirty) await this.persist()
  }

  /** 首次设置口令:创建保险箱并迁移已有明文数据 */
  async setup(passphrase: string): Promise<void> {
    if (this.isInitialized()) throw new VaultError('VAULT_EXISTS', '保险箱已存在')
    if (!passphrase || passphrase.length < 4) {
      throw new VaultError('WEAK_PASSPHRASE', '口令至少需要 4 个字符')
    }

    const salt = randomBytes(SALT_BYTES)
    const macSalt = randomBytes(SALT_BYTES)
    const key = await deriveKey(passphrase, salt, this.iterations)
    const macKey = await deriveMacKey(passphrase, macSalt, this.iterations)
    const meta: VaultMeta = {
      v: 1,
      kdf: {
        name: 'PBKDF2',
        hash: 'SHA-256',
        iterations: this.iterations,
        salt: bytesToBase64(salt),
        macSalt: bytesToBase64(macSalt),
      },
      verifier: await encryptText(key, CANARY),
    }

    // 先在内存里完成全部构建(含旧明文迁移),再一次写入;失败不产生半成品
    const scenes: WindowScene[] = []
    let legacyBackup: CipherEnvelope | null = null
    const absorb = async (raw: string) => {
      try {
        const parsed = JSON.parse(raw)
        if (Array.isArray(parsed)) {
          for (const scene of parsed as WindowScene[]) {
            if (scene && typeof scene.id === 'string') scenes.push(scene)
          }
          return
        }
      } catch {
        /* 非 JSON:落入加密备份 */
      }
      if (raw.trim() !== '' && raw.trim() !== '[]' && legacyBackup === null) {
        legacyBackup = await encryptText(key, raw)
      }
    }
    const rawLegacy = this.storage.getItem(LEGACY_KEY)
    if (rawLegacy !== null) await absorb(rawLegacy)
    const rawLegacyBackup = this.storage.getItem(LEGACY_BACKUP_KEY)
    if (rawLegacyBackup !== null) await absorb(rawLegacyBackup)

    const records = await this.encryptRecords(key, scenes)
    const manifest = await this.signManifest(macKey, records, [], legacyBackup)
    const file: VaultFile = {
      v: 1,
      meta,
      records,
      tombstones: [],
      ...(legacyBackup ? { legacyBackup } : {}),
      manifest,
    }
    this.writeRaw(JSON.stringify(file))

    // 写入成功后才清理明文与更新内存状态
    if (rawLegacy !== null) this.storage.removeItem(LEGACY_KEY)
    if (rawLegacyBackup !== null) this.storage.removeItem(LEGACY_BACKUP_KEY)
    this.key = key
    this.macKey = macKey
    this.meta = meta
    this.scenes = scenes
    this.legacyBackup = legacyBackup
    this.badRecords = []
    this.deletedIds = new Set()
    this.corruptedCount = 0
    this.status = 'unlocked'
  }

  /**
   * 解锁。重复解锁是幂等操作:已解锁时直接返回。
   * 错口令抛 WRONG_PASSPHRASE,已有数据不受任何影响。
   * 文件被整体改动(记录被拿掉/调序/签名缺失)抛 VAULT_CORRUPTED。
   */
  async unlock(passphrase: string): Promise<{ corrupted: number }> {
    if (this.status === 'unlocked') return { corrupted: this.corruptedCount }
    const parsed = this.readVaultFile()
    const { meta } = parsed
    const key = await this.deriveAndVerify(passphrase, meta)
    const macKey = await deriveMacKey(
      passphrase,
      base64ToBytes(meta.kdf.macSalt)!,
      meta.kdf.iterations,
    )

    // 整体完整性:记录被拿掉、调序、塞入或签名被剥离,都在这里被发现
    const expected = await hmacSign(
      macKey,
      Vault.manifestInput(parsed.rawIds, parsed.tombstones, parsed.legacyBackup),
    )
    if (expected !== parsed.manifest) {
      throw new VaultError('VAULT_CORRUPTED', '保险箱数据被整体改动(记录缺失、顺序异常或签名不匹配)')
    }

    const scenes: WindowScene[] = []
    const badRecords = [...parsed.badRecords]
    let corrupted = badRecords.length
    for (const rec of parsed.goodRecords) {
      try {
        scenes.push(JSON.parse(await decryptText(key, rec)) as WindowScene)
      } catch {
        // GCM 校验失败:记录内容被篡改,不计入正常数据
        corrupted++
        badRecords.push(rec)
      }
    }

    this.key = key
    this.macKey = macKey
    this.meta = meta
    this.scenes = scenes
    this.badRecords = badRecords
    this.deletedIds = new Set(parsed.tombstones)
    this.legacyBackup = parsed.legacyBackup
    this.corruptedCount = corrupted
    this.status = 'unlocked'

    await this.sweepPlaintextKeys()
    return { corrupted }
  }

  /** 锁定:清空内存中的密钥与全部明文缓存 */
  lock(): void {
    this.key = null
    this.macKey = null
    this.meta = null
    this.scenes = []
    this.badRecords = []
    this.deletedIds = new Set()
    this.legacyBackup = null
    this.corruptedCount = 0
    this.refreshStatus()
  }

  /**
   * 换口令:在内存里用新口令完整重加密全部数据后一次性重写。
   * 任一步失败(旧口令错、存储写失败、并发冲突)都抛异常,
   * 磁盘上的旧保险箱保持原样,不会留下半加密状态。
   * 已损坏的记录无法重加密,原样保留。
   */
  async changePassphrase(current: string, next: string): Promise<void> {
    this.assertUnlocked()
    if (!next || next.length < 4) {
      throw new VaultError('WEAK_PASSPHRASE', '新口令至少需要 4 个字符')
    }
    // 先验证当前口令,错了直接拒绝,不写任何东西
    await this.deriveAndVerify(current, this.meta!)

    for (let attempt = 0; ; attempt++) {
      // 把其他标签页刚写入的记录合并进来(元信息若已变会直接抛 VAULT_CHANGED)
      await this.mergeFromDisk()

      const salt = randomBytes(SALT_BYTES)
      const macSalt = randomBytes(SALT_BYTES)
      const newKey = await deriveKey(next, salt, this.iterations)
      const newMacKey = await deriveMacKey(next, macSalt, this.iterations)
      const newMeta: VaultMeta = {
        v: 1,
        kdf: {
          name: 'PBKDF2',
          hash: 'SHA-256',
          iterations: this.iterations,
          salt: bytesToBase64(salt),
          macSalt: bytesToBase64(macSalt),
        },
        verifier: await encryptText(newKey, CANARY),
      }
      const newRecords = await this.encryptRecords(newKey, this.scenes)

      const rawBefore = this.storage.getItem(VAULT_KEY)
      if (rawBefore === null) {
        throw new VaultError('VAULT_CHANGED', '保险箱已被其他窗口移除')
      }
      const disk = this.parseVaultRaw(rawBefore)
      if (!Vault.sameMeta(disk.meta, this.meta!)) {
        throw new VaultError('VAULT_CHANGED', '保险箱已在其他窗口更改,换口令被取消')
      }
      // 合并后磁盘上又出现了我们不认识、也不是已知损坏的记录:有并发写入,解入内存后重试
      const knownIds = new Set(this.scenes.map((s) => s.id))
      const knownBad = new Set(this.badRecords.map((r) => r.id + '|' + r.ct))
      const hasUnknown = disk.goodRecords.some(
        (r) =>
          !knownIds.has(r.id) &&
          !this.deletedIds.has(r.id) &&
          !knownBad.has(r.id + '|' + r.ct),
      )
      if (hasUnknown) {
        if (attempt >= MAX_CAS_ATTEMPTS) {
          throw new VaultError('VAULT_CHANGED', '其他窗口正在频繁写入,请稍后重试')
        }
        continue
      }

      const tombstones = new Set([...disk.tombstones, ...this.deletedIds])
      const bad = dedupEnvelopes(this.badRecords, disk.badRecords)
      const records = [...newRecords, ...bad]
      const manifest = await this.signManifest(newMacKey, records, [...tombstones], this.legacyBackup)
      const file: VaultFile = {
        v: 1,
        meta: newMeta,
        records,
        tombstones: [...tombstones],
        ...(this.legacyBackup ? { legacyBackup: this.legacyBackup } : {}),
        manifest,
      }

      // CAS:签名期间磁盘被并发修改则重试;比对与写入之间没有 await
      if (this.storage.getItem(VAULT_KEY) !== rawBefore) {
        if (attempt >= MAX_CAS_ATTEMPTS) {
          throw new VaultError('VAULT_CHANGED', '其他窗口正在频繁写入,请稍后重试')
        }
        continue
      }
      this.writeRaw(JSON.stringify(file))

      this.key = newKey
      this.macKey = newMacKey
      this.meta = newMeta
      this.deletedIds = tombstones
      this.badRecords = bad
      return
    }
  }

  /** 把磁盘上的记录与墓碑合并进内存:按 id 去重,内存优先,被删的一律排除 */
  private async mergeFromDisk() {
    const disk = this.readVaultFile()
    if (!Vault.sameMeta(disk.meta, this.meta!)) {
      throw new VaultError('VAULT_CHANGED', '保险箱已在其他窗口更改(如换了口令),本次写入被拒绝')
    }
    const tombstones = new Set([...disk.tombstones, ...this.deletedIds])
    const merged = new Map<string, WindowScene>()
    const badRecords = dedupEnvelopes(this.badRecords, disk.badRecords)
    for (const rec of disk.goodRecords) {
      try {
        const scene = JSON.parse(await decryptText(this.key!, rec)) as WindowScene
        if (!tombstones.has(scene.id)) merged.set(scene.id, scene)
      } catch {
        // 磁盘上解密失败的记录:保留为损坏证据,不丢也不读
        badRecords.push(rec)
      }
    }
    for (const scene of this.scenes) {
      // 其他页面已删除的记录(磁盘墓碑)不能留在内存里
      if (!tombstones.has(scene.id)) merged.set(scene.id, scene)
    }
    this.scenes = [...merged.values()]
    this.badRecords = dedupEnvelopes(badRecords)
    this.deletedIds = tombstones
  }

  getScenes(): WindowScene[] {
    this.assertUnlocked()
    return [...this.scenes]
  }

  async addScene(scene: WindowScene): Promise<void> {
    this.assertUnlocked()
    this.deletedIds.delete(scene.id)
    this.scenes.push(scene)
    try {
      await this.persist()
    } catch (err) {
      // persist 可能已合并过磁盘记录,按 id 回滚而不是弹栈
      this.scenes = this.scenes.filter((s) => s.id !== scene.id)
      throw err
    }
  }

  async deleteScene(id: string): Promise<void> {
    this.assertUnlocked()
    const index = this.scenes.findIndex((s) => s.id === id)
    if (index === -1) return
    const [removed] = this.scenes.splice(index, 1)
    this.deletedIds.add(id)
    try {
      await this.persist()
    } catch (err) {
      this.deletedIds.delete(id)
      this.scenes.splice(index, 0, removed)
      throw err
    }
  }
}

/** 应用内使用的单例 */
export const vault = new Vault()
