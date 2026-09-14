import { create } from 'zustand'
import { vault, VaultError, type VaultStatus } from '@/services/vault'
import { useSceneStore } from './useSceneStore'

export type VaultViewStatus = VaultStatus

interface VaultState {
  status: VaultViewStatus
  /** 解锁时发现的损坏/被篡改记录数 */
  corruptedCount: number
  error: string | null
  busy: boolean

  init: () => void
  setup: (passphrase: string) => Promise<boolean>
  unlock: (passphrase: string) => Promise<boolean>
  lock: () => void
  changePassphrase: (current: string, next: string) => Promise<boolean>
  clearError: () => void
}

function errorMessage(err: unknown): string {
  if (err instanceof VaultError) {
    switch (err.code) {
      case 'WRONG_PASSPHRASE':
        return '口令不正确,请重试'
      case 'VAULT_CORRUPTED':
        return '保险箱数据已损坏或被篡改,无法解锁'
      case 'WEAK_PASSPHRASE':
        return '口令至少需要 4 个字符'
      case 'STORAGE_FULL':
        return '本地存储写入失败,已有数据未受影响'
      case 'LOCKED':
        return '保险箱未解锁'
      default:
        return '操作失败,请重试'
    }
  }
  return '操作失败,请重试'
}

export const useVaultStore = create<VaultState>((set) => ({
  status: vault.getStatus(),
  corruptedCount: 0,
  error: null,
  busy: false,

  init: () => {
    set({ status: vault.getStatus() })
  },

  setup: async (passphrase: string) => {
    set({ busy: true, error: null })
    try {
      await vault.setup(passphrase)
      set({ status: 'unlocked', corruptedCount: 0, busy: false })
      useSceneStore.getState().loadAll()
      return true
    } catch (err) {
      set({ error: errorMessage(err), busy: false })
      return false
    }
  },

  unlock: async (passphrase: string) => {
    set({ busy: true, error: null })
    try {
      const { corrupted } = await vault.unlock(passphrase)
      set({ status: 'unlocked', corruptedCount: corrupted, busy: false })
      useSceneStore.getState().loadAll()
      return true
    } catch (err) {
      set({ error: errorMessage(err), busy: false })
      return false
    }
  },

  lock: () => {
    vault.lock()
    useSceneStore.getState().clearAll()
    set({ status: 'locked', corruptedCount: 0, error: null })
  },

  changePassphrase: async (current: string, next: string) => {
    set({ busy: true, error: null })
    try {
      await vault.changePassphrase(current, next)
      set({ busy: false })
      return true
    } catch (err) {
      set({ error: errorMessage(err), busy: false })
      return false
    }
  },

  clearError: () => set({ error: null }),
}))
