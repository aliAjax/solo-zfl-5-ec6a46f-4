import { useState } from 'react'
import { Lock, KeyRound, ShieldCheck, Bus } from 'lucide-react'
import { useVaultStore } from '@/store/useVaultStore'

/**
 * 锁屏:未设置口令时引导创建,已设置时要求解锁。
 * 解锁前任何页面都不可见,本地与内存中都没有明文。
 */
export default function LockScreen() {
  const status = useVaultStore((s) => s.status)
  const error = useVaultStore((s) => s.error)
  const busy = useVaultStore((s) => s.busy)
  const setup = useVaultStore((s) => s.setup)
  const unlock = useVaultStore((s) => s.unlock)
  const clearError = useVaultStore((s) => s.clearError)

  const isSetup = status === 'uninitialized'
  const [passphrase, setPassphrase] = useState('')
  const [confirm, setConfirm] = useState('')
  const [localError, setLocalError] = useState<string | null>(null)

  const shownError = localError ?? error

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    setLocalError(null)
    clearError()
    if (isSetup) {
      if (passphrase.length < 4) {
        setLocalError('口令至少需要 4 个字符')
        return
      }
      if (passphrase !== confirm) {
        setLocalError('两次输入的口令不一致')
        return
      }
      await setup(passphrase)
    } else {
      const ok = await unlock(passphrase)
      if (!ok) setPassphrase('')
    }
  }

  return (
    <div className="min-h-screen bg-teal-950 flex flex-col items-center justify-center px-6">
      <div className="w-full max-w-sm">
        <div className="flex flex-col items-center mb-8">
          <div className="w-16 h-16 rounded-2xl bg-dusk-400/15 flex items-center justify-center mb-4">
            {isSetup ? (
              <ShieldCheck className="w-8 h-8 text-dusk-400" />
            ) : (
              <Lock className="w-8 h-8 text-dusk-400" />
            )}
          </div>
          <h1 className="font-serif text-mist-100 text-2xl font-semibold flex items-center gap-2">
            <Bus className="w-5 h-5 text-dusk-400" />
            窗景采样器
          </h1>
          <p className="text-mist-400 text-sm mt-2 text-center leading-relaxed">
            {isSetup
              ? '设置一个口令,窗景数据将只以密文保存在本地'
              : '保险箱已锁定,输入口令解锁'}
          </p>
        </div>

        <form onSubmit={handleSubmit} className="space-y-4">
          <div className="relative">
            <KeyRound className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-mist-500" />
            <input
              type="password"
              autoFocus
              value={passphrase}
              onChange={(e) => {
                setPassphrase(e.target.value)
                setLocalError(null)
                clearError()
              }}
              placeholder={isSetup ? '设置口令(至少 4 个字符)' : '输入口令'}
              className="w-full bg-teal-850 text-mist-100 rounded-xl pl-10 pr-4 py-3 text-sm outline-none focus:ring-1 focus:ring-dusk-400 placeholder:text-mist-500"
            />
          </div>

          {isSetup && (
            <div className="relative">
              <KeyRound className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-mist-500" />
              <input
                type="password"
                value={confirm}
                onChange={(e) => {
                  setConfirm(e.target.value)
                  setLocalError(null)
                }}
                placeholder="再输入一次确认"
                className="w-full bg-teal-850 text-mist-100 rounded-xl pl-10 pr-4 py-3 text-sm outline-none focus:ring-1 focus:ring-dusk-400 placeholder:text-mist-500"
              />
            </div>
          )}

          {shownError && (
            <p className="text-red-300 text-xs bg-red-900/30 border border-red-800/50 rounded-lg px-3 py-2">
              {shownError}
            </p>
          )}

          <button
            type="submit"
            disabled={busy || !passphrase}
            className="w-full py-3 rounded-xl bg-dusk-400 text-teal-950 font-medium text-sm flex items-center justify-center gap-2 active:scale-[0.98] transition disabled:opacity-50 disabled:cursor-not-allowed"
          >
            <Lock className="w-4 h-4" />
            {busy ? '处理中…' : isSetup ? '创建保险箱' : '解锁'}
          </button>
        </form>

        <p className="text-mist-500 text-xs text-center mt-6 leading-relaxed">
          数据加密保存在本设备,口令不会上传;
          <br />
          忘记口令将无法恢复数据。
        </p>
      </div>
    </div>
  )
}
