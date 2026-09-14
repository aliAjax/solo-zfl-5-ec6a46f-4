import { describe, it, expect, beforeEach } from 'vitest'
import {
  Vault,
  VaultError,
  VAULT_KEY,
  LEGACY_KEY,
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
