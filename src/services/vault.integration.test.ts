// @vitest-environment happy-dom
/**
 * 集成测试:不注入存储后端,走浏览器真实的 localStorage,
 * 覆盖「设置口令 → 记录 → 锁定 → 解锁 → 篡改检测 → 换口令」完整流程。
 */
import { describe, it, expect, beforeEach } from 'vitest'
import { Vault, VAULT_KEY } from '@/services/vault'
import type { WindowScene } from '@/types'

function makeScene(note: string): WindowScene {
  return {
    id: crypto.randomUUID(),
    routeName: '44路',
    segment: '积水潭-新街口',
    seatDirection: '右',
    timestamp: new Date().toISOString(),
    weather: '多云',
    signText: '修车铺',
    treeDensity: '茂密',
    pedestrianStatus: '密集',
    note,
  }
}

beforeEach(() => {
  localStorage.clear()
})

describe('真实 localStorage 全流程', () => {
  it('设置口令 → 写入 → 锁定 → 解锁 → 篡改 → 换口令', async () => {
    // 首次打开:未初始化
    let vault = new Vault(undefined, { iterations: 1000 })
    expect(vault.getStatus()).toBe('uninitialized')

    // 设置口令并写入两条记录
    await vault.setup('my-secret')
    await vault.addScene(makeScene('傍晚的雨刷器'))
    await vault.addScene(makeScene('霓虹在积水里碎开'))
    expect(localStorage.getItem(VAULT_KEY)).not.toContain('霓虹在积水里碎开')

    // 模拟刷新/重开:新建实例,只剩 locked
    vault = new Vault(undefined, { iterations: 1000 })
    expect(vault.getStatus()).toBe('locked')
    expect(() => vault.getScenes()).toThrow()

    // 错口令拒绝
    await expect(vault.unlock('nope')).rejects.toMatchObject({ code: 'WRONG_PASSPHRASE' })

    // 正确口令解锁,数据完整
    await vault.unlock('my-secret')
    expect(vault.getScenes().map((s) => s.note)).toContain('傍晚的雨刷器')

    // 篡改存储中的密文
    const file = JSON.parse(localStorage.getItem(VAULT_KEY)!)
    file.records[0].ct = file.records[0].ct.slice(0, -4) + 'AAAA'
    localStorage.setItem(VAULT_KEY, JSON.stringify(file))
    vault.lock()
    const { corrupted } = await vault.unlock('my-secret')
    expect(corrupted).toBe(1)
    expect(vault.getScenes()).toHaveLength(1)

    // 换口令:旧口令失效,新口令可用
    await vault.changePassphrase('my-secret', 'new-secret')
    vault.lock()
    await expect(vault.unlock('my-secret')).rejects.toMatchObject({ code: 'WRONG_PASSPHRASE' })
    await vault.unlock('new-secret')
    expect(vault.getScenes()).toHaveLength(1)
  })

  it('真实 localStorage 上的双标签页:长笔记 + 换口令不被旧页回退', async () => {
    // 标签页 A:设置口令,写一条很长的笔记
    const tabA = new Vault(undefined, { iterations: 1000 })
    await tabA.setup('shared-pass')
    const longNote = '车窗外的故事。'.repeat(50_000)
    await tabA.addScene(makeScene(longNote))

    // 标签页 B:同一 localStorage,解锁同一保险箱
    const tabB = new Vault(undefined, { iterations: 1000 })
    await tabB.unlock('shared-pass')

    // A 换口令;B 随后的写入必须被拒绝,且不能回退口令
    await tabA.changePassphrase('shared-pass', 'rotated-pass')
    await expect(tabB.addScene(makeScene('B 的迟到写入'))).rejects.toMatchObject({
      code: 'VAULT_CHANGED',
    })

    // 模拟重开:新口令能开,长笔记完整,损坏计数为 0
    const fresh = new Vault(undefined, { iterations: 1000 })
    await expect(fresh.unlock('shared-pass')).rejects.toMatchObject({ code: 'WRONG_PASSPHRASE' })
    const { corrupted } = await fresh.unlock('rotated-pass')
    expect(corrupted).toBe(0)
    const notes = fresh.getScenes().map((s) => s.note)
    expect(notes).toContain(longNote)
    expect(notes).not.toContain('B 的迟到写入')
  })
})
