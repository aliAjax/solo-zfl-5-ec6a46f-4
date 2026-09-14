import { describe, it, expect, beforeEach } from 'vitest'
import {
  Vault,
  VaultError,
  VAULT_KEY,
  LEGACY_KEY,
  LEGACY_BACKUP_KEY,
  type VaultStorage,
} from '@/services/vault'
import type { WindowScene } from '@/types'

/** 内存存储后端,可注入故障模拟写入中断 */
class MemStorage implements VaultStorage {
  map = new Map<string, string>()
  failNextSet = false

  getItem(key: string): string | null {
    return this.map.has(key) ? this.map.get(key)! : null
  }
  setItem(key: string, value: string): void {
    if (this.failNextSet) {
      this.failNextSet = false
      throw new Error('QuotaExceededError')
    }
    this.map.set(key, value)
  }
  removeItem(key: string): void {
    this.map.delete(key)
  }
}

function makeScene(overrides: Partial<WindowScene> = {}): WindowScene {
  return {
    id: crypto.randomUUID(),
    routeName: '27路',
    segment: '鼓楼-西四',
    seatDirection: '左',
    timestamp: '2026-09-14T08:00:00.000Z',
    weather: '晴',
    signText: '豆浆油条',
    treeDensity: '适中',
    pedestrianStatus: '零星',
    note: '晨光穿过槐树,站台上有人看报',
    ...overrides,
  }
}

const PW = 'correct-horse-battery'
/** 测试用低迭代次数,不影响对真实行为的覆盖 */
const makeVault = (storage: MemStorage) => new Vault(storage, { iterations: 1000 })

function readVaultFile(storage: MemStorage) {
  const raw = storage.getItem(VAULT_KEY)
  expect(raw).not.toBeNull()
  return JSON.parse(raw!) as {
    v: number
    meta: { kdf: { salt: string }; verifier: { iv: string; ct: string } }
    records: Array<{ id: string; iv: string; ct: string }>
  }
}

let storage: MemStorage

beforeEach(() => {
  storage = new MemStorage()
})

describe('空库', () => {
  it('首次设置口令后即为解锁状态,记录为空', async () => {
    const vault = makeVault(storage)
    expect(vault.getStatus()).toBe('uninitialized')
    await vault.setup(PW)
    expect(vault.getStatus()).toBe('unlocked')
    expect(vault.getScenes()).toEqual([])
    expect(vault.getCorruptedCount()).toBe(0)
  })

  it('锁定再解锁后空库仍为空,且可正常写入', async () => {
    const vault = makeVault(storage)
    await vault.setup(PW)
    vault.lock()
    expect(vault.getStatus()).toBe('locked')

    const { corrupted } = await vault.unlock(PW)
    expect(corrupted).toBe(0)
    expect(vault.getScenes()).toEqual([])

    const scene = makeScene()
    await vault.addScene(scene)
    expect(vault.getScenes()).toHaveLength(1)
  })

  it('弱口令被拒绝且不会创建保险箱', async () => {
    const vault = makeVault(storage)
    await expect(vault.setup('abc')).rejects.toMatchObject({ code: 'WEAK_PASSPHRASE' })
    expect(vault.getStatus()).toBe('uninitialized')
    expect(storage.getItem(VAULT_KEY)).toBeNull()
  })
})

describe('错口令', () => {
  it('明确拒绝,且不损坏已有数据', async () => {
    const vault = makeVault(storage)
    await vault.setup(PW)
    await vault.addScene(makeScene())
    await vault.addScene(makeScene({ id: crypto.randomUUID(), note: '第二条' }))
    vault.lock()

    const before = storage.getItem(VAULT_KEY)
    await expect(vault.unlock('wrong-password')).rejects.toMatchObject({
      code: 'WRONG_PASSPHRASE',
    })
    // 拒绝后仍是锁定状态,磁盘上的密文一个字节都没变
    expect(vault.getStatus()).toBe('locked')
    expect(storage.getItem(VAULT_KEY)).toBe(before)

    // 正确口令仍能解锁,数据完整
    await vault.unlock(PW)
    expect(vault.getScenes()).toHaveLength(2)
  })

  it('换口令时当前口令错误也会被拒绝,旧口令继续有效', async () => {
    const vault = makeVault(storage)
    await vault.setup(PW)
    await vault.addScene(makeScene())

    await expect(vault.changePassphrase('not-the-password', 'new-pass')).rejects.toMatchObject({
      code: 'WRONG_PASSPHRASE',
    })
    vault.lock()
    await expect(vault.unlock('new-pass')).rejects.toMatchObject({ code: 'WRONG_PASSPHRASE' })
    await vault.unlock(PW)
    expect(vault.getScenes()).toHaveLength(1)
  })
})

describe('篡改与长度异常', () => {
  it('密文被改动:记录被识别为损坏,不会被当成正常记录读出', async () => {
    const vault = makeVault(storage)
    await vault.setup(PW)
    const good = makeScene()
    const victim = makeScene({ note: '将被篡改的记录' })
    await vault.addScene(good)
    await vault.addScene(victim)
    vault.lock()

    // 直接改存储里的密文:翻转 victim 密文的一个字符
    const file = readVaultFile(storage)
    const target = file.records.find((r) => r.id === victim.id)!
    target.ct = (target.ct[0] === 'A' ? 'B' : 'A') + target.ct.slice(1)
    storage.setItem(VAULT_KEY, JSON.stringify(file))

    const { corrupted } = await vault.unlock(PW)
    expect(corrupted).toBe(1)
    const scenes = vault.getScenes()
    expect(scenes).toHaveLength(1)
    expect(scenes[0].id).toBe(good.id)
    // 被篡改的明文绝不能出现
    expect(JSON.stringify(scenes)).not.toContain('将被篡改的记录')
  })

  it('密文被截断(长度异常):同样被识别并提示', async () => {
    const vault = makeVault(storage)
    await vault.setup(PW)
    const victim = makeScene()
    await vault.addScene(victim)
    vault.lock()

    const file = readVaultFile(storage)
    file.records[0].ct = file.records[0].ct.slice(0, 8) // 截断到不足 GCM 标签长度
    storage.setItem(VAULT_KEY, JSON.stringify(file))

    const { corrupted } = await vault.unlock(PW)
    expect(corrupted).toBe(1)
    expect(vault.getScenes()).toHaveLength(0)
  })

  it('保险箱元信息损坏:解锁直接报错而不是读出垃圾数据', async () => {
    const vault = makeVault(storage)
    await vault.setup(PW)
    await vault.addScene(makeScene())
    vault.lock()

    const file = readVaultFile(storage)
    file.meta.kdf.salt = 'not-valid-base64!!!'
    storage.setItem(VAULT_KEY, JSON.stringify(file))

    await expect(vault.unlock(PW)).rejects.toMatchObject({ code: 'VAULT_CORRUPTED' })
    expect(vault.getStatus()).toBe('locked')
  })

  it('整个文件不是合法 JSON 时也报损坏', async () => {
    const vault = makeVault(storage)
    await vault.setup(PW)
    vault.lock()
    storage.setItem(VAULT_KEY, '{"v":1,"meta":{')
    await expect(vault.unlock(PW)).rejects.toMatchObject({ code: 'VAULT_CORRUPTED' })
  })
})

describe('换口令', () => {
  it('一次性重写全部数据:新口令可用,旧口令失效,记录完整', async () => {
    const vault = makeVault(storage)
    await vault.setup(PW)
    await vault.addScene(makeScene())
    await vault.addScene(makeScene({ note: '换口令后仍要在' }))

    await vault.changePassphrase(PW, 'brand-new-pass')
    vault.lock()

    await expect(vault.unlock(PW)).rejects.toMatchObject({ code: 'WRONG_PASSPHRASE' })
    await vault.unlock('brand-new-pass')
    const scenes = vault.getScenes()
    expect(scenes).toHaveLength(2)
    expect(scenes.map((s) => s.note)).toContain('换口令后仍要在')
  })

  it('写入中途失败:不留半加密状态,旧口令与数据完好', async () => {
    const vault = makeVault(storage)
    await vault.setup(PW)
    await vault.addScene(makeScene({ note: '中断前的记录' }))
    const before = storage.getItem(VAULT_KEY)

    storage.failNextSet = true // 模拟换口令写盘时存储失败
    await expect(vault.changePassphrase(PW, 'brand-new-pass')).rejects.toMatchObject({
      code: 'STORAGE_FULL',
    })

    // 磁盘上的保险箱与之前逐字节一致
    expect(storage.getItem(VAULT_KEY)).toBe(before)

    // 旧口令仍能解锁,新口令无效,数据一条不少
    vault.lock()
    await expect(vault.unlock('brand-new-pass')).rejects.toMatchObject({
      code: 'WRONG_PASSPHRASE',
    })
    await vault.unlock(PW)
    expect(vault.getScenes()).toHaveLength(1)
    expect(vault.getScenes()[0].note).toBe('中断前的记录')
  })
})

describe('重复解锁', () => {
  it('已解锁时再次解锁是幂等操作,不报错也不重置数据', async () => {
    const vault = makeVault(storage)
    await vault.setup(PW)
    await vault.addScene(makeScene())

    const first = await vault.unlock(PW)
    const second = await vault.unlock(PW)
    expect(first).toEqual(second)
    expect(vault.getStatus()).toBe('unlocked')
    expect(vault.getScenes()).toHaveLength(1)
  })

  it('锁定后可用同一口令反复解锁', async () => {
    const vault = makeVault(storage)
    await vault.setup(PW)
    await vault.addScene(makeScene())
    for (let i = 0; i < 3; i++) {
      vault.lock()
      await vault.unlock(PW)
      expect(vault.getScenes()).toHaveLength(1)
    }
  })
})

describe('未解锁写入', () => {
  it('锁定状态下读写都被拒绝,本地不产生任何变化', async () => {
    const vault = makeVault(storage)
    await vault.setup(PW)
    await vault.addScene(makeScene())
    vault.lock()

    const before = storage.getItem(VAULT_KEY)
    expect(() => vault.getScenes()).toThrowError(VaultError)
    await expect(vault.addScene(makeScene())).rejects.toMatchObject({ code: 'LOCKED' })
    await expect(vault.deleteScene('whatever')).rejects.toMatchObject({ code: 'LOCKED' })
    await expect(vault.changePassphrase(PW, 'x'.repeat(8))).rejects.toMatchObject({
      code: 'LOCKED',
    })
    expect(storage.getItem(VAULT_KEY)).toBe(before)
  })

  it('锁定后内存中不留明文', async () => {
    const vault = makeVault(storage)
    await vault.setup(PW)
    await vault.addScene(makeScene({ note: '秘密笔记内容' }))
    vault.lock()

    expect(vault.getStatus()).toBe('locked')
    // 锁定时 vault 实例内部不再持有可读的记录
    expect(() => vault.getScenes()).toThrowError(VaultError)
    // 本地存储里也没有明文
    const allStored = Array.from(storage.map.values()).join('\n')
    expect(allStored).not.toContain('秘密笔记内容')
    expect(allStored).not.toContain('27路')
  })
})

describe('密文存储与明文迁移', () => {
  it('本地只存密文:口令验证值与记录都不含明文', async () => {
    const vault = makeVault(storage)
    await vault.setup(PW)
    await vault.addScene(makeScene({ note: '独特的秘密句子甲乙丙', signText: '秘密招牌' }))

    const raw = storage.getItem(VAULT_KEY)!
    expect(raw).not.toContain('独特的秘密句子甲乙丙')
    expect(raw).not.toContain('秘密招牌')
    expect(raw).not.toContain('27路')
    expect(raw).not.toContain(PW)
  })

  it('设置口令时把旧版明文数据迁入保险箱并删除明文', async () => {
    const legacy = [makeScene({ note: '旧时代的明文记录' })]
    storage.setItem(LEGACY_KEY, JSON.stringify(legacy))

    const vault = makeVault(storage)
    await vault.setup(PW)

    expect(storage.getItem(LEGACY_KEY)).toBeNull()
    expect(vault.getScenes()).toHaveLength(1)
    expect(vault.getScenes()[0].note).toBe('旧时代的明文记录')
    expect(storage.getItem(VAULT_KEY)).not.toContain('旧时代的明文记录')

    // 重新锁定解锁后依然在
    vault.lock()
    await vault.unlock(PW)
    expect(vault.getScenes()).toHaveLength(1)
  })

  it('解锁时发现残留的明文 key 也会一并迁移清理', async () => {
    const vault = makeVault(storage)
    await vault.setup(PW)
    await vault.addScene(makeScene())
    vault.lock()

    // 模拟保险箱之外又出现了一份明文数据
    storage.setItem(LEGACY_KEY, JSON.stringify([makeScene({ note: '残留明文' })]))
    await vault.unlock(PW)

    expect(storage.getItem(LEGACY_KEY)).toBeNull()
    expect(vault.getScenes()).toHaveLength(2)
    expect(vault.getScenes().map((s) => s.note)).toContain('残留明文')
  })
})

describe('增删记录', () => {
  it('删除记录后重开保险箱,被删记录不再出现', async () => {
    const vault = makeVault(storage)
    await vault.setup(PW)
    const a = makeScene()
    const b = makeScene()
    await vault.addScene(a)
    await vault.addScene(b)
    await vault.deleteScene(a.id)

    vault.lock()
    await vault.unlock(PW)
    const scenes = vault.getScenes()
    expect(scenes).toHaveLength(1)
    expect(scenes[0].id).toBe(b.id)
  })
})

describe('长记录', () => {
  it('很长的笔记保存后重新解锁仍完整,不会被误判为篡改', async () => {
    const vault = makeVault(storage)
    await vault.setup(PW)
    // 约 500KB 的笔记,密文超过 256KB(旧的错误上限)
    const longNote = '窗外形形色色的行人。'.repeat(50_000)
    const scene = makeScene({ note: longNote })
    await vault.addScene(scene)
    await vault.addScene(makeScene({ note: '普通长度' }))
    vault.lock()

    const { corrupted } = await vault.unlock(PW)
    expect(corrupted).toBe(0)
    const scenes = vault.getScenes()
    expect(scenes).toHaveLength(2)
    expect(scenes.find((s) => s.id === scene.id)?.note).toBe(longNote)
  })

  it('长笔记经换口令后依然完整', async () => {
    const vault = makeVault(storage)
    await vault.setup(PW)
    const longNote = '雨点打在玻璃上。'.repeat(40_000)
    await vault.addScene(makeScene({ note: longNote }))
    await vault.changePassphrase(PW, 'new-pass-for-long-note')
    vault.lock()

    const { corrupted } = await vault.unlock('new-pass-for-long-note')
    expect(corrupted).toBe(0)
    expect(vault.getScenes()[0].note).toBe(longNote)
  })
})

describe('多标签页并发', () => {
  /** 两个 Vault 实例共享同一存储,模拟同一浏览器里的两个标签页 */
  async function twoTabs() {
    const tabA = makeVault(storage)
    await tabA.setup(PW)
    await tabA.addScene(makeScene({ note: 'A 页写入的记录' }))
    const tabB = makeVault(storage)
    await tabB.unlock(PW)
    return { tabA, tabB }
  }

  it('A 页换口令后,B 页保存记录被拒绝,口令变更不被覆盖', async () => {
    const { tabA, tabB } = await twoTabs()
    await tabA.changePassphrase(PW, 'new-pass-from-A')

    // B 页(还持有旧密钥)写入必须被拒绝,不能落盘
    await expect(tabB.addScene(makeScene({ note: 'B 页迟到写入' }))).rejects.toMatchObject({
      code: 'VAULT_CHANGED',
    })
    const existingId = tabB.getScenes()[0].id
    await expect(tabB.deleteScene(existingId)).rejects.toMatchObject({ code: 'VAULT_CHANGED' })

    // 磁盘上以新口令为准:新口令能开,旧口令不能开
    const fresh = makeVault(storage)
    await expect(fresh.unlock(PW)).rejects.toMatchObject({ code: 'WRONG_PASSPHRASE' })
    await fresh.unlock('new-pass-from-A')
    const notes = fresh.getScenes().map((s) => s.note)
    expect(notes).toContain('A 页写入的记录')
    expect(notes).not.toContain('B 页迟到写入')
  })

  it('A 页换口令后,B 页再换口令同样被拒绝', async () => {
    const { tabA, tabB } = await twoTabs()
    await tabA.changePassphrase(PW, 'new-pass-from-A')
    await expect(tabB.changePassphrase(PW, 'pass-from-B')).rejects.toMatchObject({
      code: 'VAULT_CHANGED',
    })
    const fresh = makeVault(storage)
    await fresh.unlock('new-pass-from-A')
    expect(fresh.getScenes()).toHaveLength(1)
  })

  it('B 页能感知外部变更(hasExternalChanges)', async () => {
    const { tabA, tabB } = await twoTabs()
    expect(tabB.hasExternalChanges()).toBe(false)
    await tabA.changePassphrase(PW, 'new-pass-from-A')
    expect(tabB.hasExternalChanges()).toBe(true)
    // A 页自己的元信息是最新的,不算外部变更
    expect(tabA.hasExternalChanges()).toBe(false)
  })

  it('两页都未换口令时,各自的写入照常工作', async () => {
    const { tabA, tabB } = await twoTabs()
    await tabB.addScene(makeScene({ note: 'B 页的记录' }))
    // A 页在 B 之后、且元信息未变,写入不受影响
    await tabA.addScene(makeScene({ note: 'A 页的第二条' }))
    const fresh = makeVault(storage)
    await fresh.unlock(PW)
    const notes = fresh.getScenes().map((s) => s.note)
    expect(notes).toContain('B 页的记录')
    expect(notes).toContain('A 页的第二条')
  })

  it('A 页换口令时,B 页刚写入的记录一并保留', async () => {
    const { tabA, tabB } = await twoTabs()
    await tabB.addScene(makeScene({ note: 'B 页抢在换口令前写入' }))
    await tabA.changePassphrase(PW, 'new-pass-from-A')

    const fresh = makeVault(storage)
    await fresh.unlock('new-pass-from-A')
    expect(fresh.getScenes().map((s) => s.note)).toContain('B 页抢在换口令前写入')
  })

  it('B 页删除记录后,A 页的写入不会把删掉的记录复活', async () => {
    const { tabA, tabB } = await twoTabs()
    const doomed = tabB.getScenes()[0]
    await tabB.deleteScene(doomed.id)
    await tabA.addScene(makeScene({ note: 'A 页后写' }))

    const fresh = makeVault(storage)
    await fresh.unlock(PW)
    const ids = fresh.getScenes().map((s) => s.id)
    expect(ids).not.toContain(doomed.id)
  })

  it('两个页面几乎同时保存,两边的记录都保留', async () => {
    const { tabA, tabB } = await twoTabs()
    // 并发触发,让两次写在加密的 await 间隙中交错
    await Promise.all([
      tabA.addScene(makeScene({ note: 'A 页第一条' })),
      tabB.addScene(makeScene({ note: 'B 页第一条' })),
    ])
    await Promise.all([
      tabB.addScene(makeScene({ note: 'B 页第二条' })),
      tabA.addScene(makeScene({ note: 'A 页第二条' })),
    ])
    await Promise.all([
      tabA.addScene(makeScene({ note: 'A 页第三条' })),
      tabB.addScene(makeScene({ note: 'B 页第三条' })),
    ])

    const fresh = makeVault(storage)
    await fresh.unlock(PW)
    const notes = fresh.getScenes().map((s) => s.note)
    for (const note of [
      'A 页第一条',
      'B 页第一条',
      'A 页第二条',
      'B 页第二条',
      'A 页第三条',
      'B 页第三条',
    ]) {
      expect(notes).toContain(note)
    }
    // 加上 setup 时已有的一条,一共 7 条,一条不丢
    expect(fresh.getScenes()).toHaveLength(7)
  })

  it('同一页面连续快速保存也不丢记录', async () => {
    const vault = makeVault(storage)
    await vault.setup(PW)
    await Promise.all([
      vault.addScene(makeScene({ note: '快一' })),
      vault.addScene(makeScene({ note: '快二' })),
      vault.addScene(makeScene({ note: '快三' })),
    ])
    vault.lock()
    await vault.unlock(PW)
    const notes = vault.getScenes().map((s) => s.note)
    expect(notes).toContain('快一')
    expect(notes).toContain('快二')
    expect(notes).toContain('快三')
  })
})

describe('整体篡改', () => {
  async function vaultWithTwoScenes() {
    const vault = makeVault(storage)
    await vault.setup(PW)
    await vault.addScene(makeScene({ note: '第一条' }))
    await vault.addScene(makeScene({ note: '第二条' }))
    vault.lock()
    return vault
  }

  it('拿掉整条记录:重新解锁报错而不是悄悄少一条', async () => {
    const vault = await vaultWithTwoScenes()
    const file = readVaultFile(storage) as { records: unknown[] }
    file.records.splice(0, 1)
    storage.setItem(VAULT_KEY, JSON.stringify(file))

    await expect(vault.unlock(PW)).rejects.toMatchObject({ code: 'VAULT_CORRUPTED' })
    expect(vault.getStatus()).toBe('locked')
  })

  it('调整记录顺序:重新解锁报错', async () => {
    const vault = await vaultWithTwoScenes()
    const file = readVaultFile(storage) as { records: unknown[] }
    file.records.reverse()
    storage.setItem(VAULT_KEY, JSON.stringify(file))

    await expect(vault.unlock(PW)).rejects.toMatchObject({ code: 'VAULT_CORRUPTED' })
  })

  it('剥掉完整性签名:重新解锁报错', async () => {
    const vault = await vaultWithTwoScenes()
    const file = readVaultFile(storage) as Record<string, unknown>
    delete file.manifest
    storage.setItem(VAULT_KEY, JSON.stringify(file))

    await expect(vault.unlock(PW)).rejects.toMatchObject({ code: 'VAULT_CORRUPTED' })
  })

  it('改动删除墓碑:重新解锁报错', async () => {
    const vault = makeVault(storage)
    await vault.setup(PW)
    const doomed = makeScene()
    await vault.addScene(doomed)
    await vault.deleteScene(doomed.id)
    vault.lock()

    const file = readVaultFile(storage) as unknown as { tombstones: string[] }
    file.tombstones = [] // 抹掉墓碑,试图让被删记录复活
    storage.setItem(VAULT_KEY, JSON.stringify(file))

    await expect(vault.unlock(PW)).rejects.toMatchObject({ code: 'VAULT_CORRUPTED' })
  })

  it('塞入一条伪造记录:重新解锁报错', async () => {
    const vault = await vaultWithTwoScenes()
    const file = readVaultFile(storage) as { records: unknown[] }
    file.records.push({ id: 'forged', iv: 'AAAA', ct: 'BBBB' })
    storage.setItem(VAULT_KEY, JSON.stringify(file))

    await expect(vault.unlock(PW)).rejects.toMatchObject({ code: 'VAULT_CORRUPTED' })
  })
})

describe('非法旧明文', () => {
  it('旧明文不是合法数组:设置口令后本地只剩密文,不留明文备份', async () => {
    storage.setItem(LEGACY_KEY, '{{{这不是合法JSON,包含秘密碎片XYZZY')

    const vault = makeVault(storage)
    await vault.setup(PW)

    // 两个明文 key 都被清除,不存在任何备份 key
    expect(storage.getItem(LEGACY_KEY)).toBeNull()
    expect(storage.getItem(LEGACY_BACKUP_KEY)).toBeNull()
    // 本地所有存储内容里都没有明文碎片
    const allStored = Array.from(storage.map.values()).join('\n')
    expect(allStored).not.toContain('秘密碎片XYZZY')
    expect(allStored).not.toContain('这不是合法JSON')
    // 保险箱本身正常可用
    expect(vault.getStatus()).toBe('unlocked')
    expect(vault.getScenes()).toEqual([])
    vault.lock()
    await vault.unlock(PW)
    expect(vault.getScenes()).toEqual([])
  })

  it('旧明文是合法 JSON 但不是数组:同样加密收存,不留明文', async () => {
    storage.setItem(LEGACY_KEY, JSON.stringify({ secret: '对象里的秘密DATA' }))
    const vault = makeVault(storage)
    await vault.setup(PW)

    expect(storage.getItem(LEGACY_KEY)).toBeNull()
    expect(Array.from(storage.map.values()).join('\n')).not.toContain('对象里的秘密DATA')
    vault.lock()
    await vault.unlock(PW)
    expect(vault.getCorruptedCount()).toBe(0)
  })

  it('上一版留下的明文备份 key 也会被清理收存', async () => {
    const vault = makeVault(storage)
    await vault.setup(PW)
    vault.lock()

    // 模拟上一版遗留的明文备份
    storage.setItem(LEGACY_BACKUP_KEY, '旧版备份里的明文BACKUP')
    await vault.unlock(PW)

    expect(storage.getItem(LEGACY_BACKUP_KEY)).toBeNull()
    expect(Array.from(storage.map.values()).join('\n')).not.toContain('旧版备份里的明文BACKUP')
  })
})
