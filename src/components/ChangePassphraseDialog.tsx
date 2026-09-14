import { useState } from 'react'
import { X, KeyRound } from 'lucide-react'
import { useVaultStore } from '@/store/useVaultStore'

interface Props {
  onClose: () => void
}

/** 修改口令:验证当前口令后,用新口令一次性重加密全部数据 */
export default function ChangePassphraseDialog({ onClose }: Props) {
  const changePassphrase = useVaultStore((s) => s.changePassphrase)
  const busy = useVaultStore((s) => s.busy)
  const storeError = useVaultStore((s) => s.error)
  const clearError = useVaultStore((s) => s.clearError)

  const [current, setCurrent] = useState('')
  const [next, setNext] = useState('')
  const [confirm, setConfirm] = useState('')
  const [localError, setLocalError] = useState<string | null>(null)

  const shownError = localError ?? storeError

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    setLocalError(null)
    clearError()
    if (next.length < 4) {
      setLocalError('新口令至少需要 4 个字符')
      return
    }
    if (next !== confirm) {
      setLocalError('两次输入的新口令不一致')
      return
    }
    const ok = await changePassphrase(current, next)
    if (ok) onClose()
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm"
      onClick={onClose}
    >
      <div
        className="relative mx-4 w-full max-w-sm rounded-2xl border border-teal-700 bg-teal-900 p-6 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <button
          onClick={onClose}
          className="absolute right-4 top-4 text-mist-400 hover:text-mist-100 transition-colors"
        >
          <X className="w-5 h-5" />
        </button>

        <h2 className="font-serif text-mist-100 text-lg font-semibold mb-1 flex items-center gap-2">
          <KeyRound className="w-5 h-5 text-dusk-400" />
          修改口令
        </h2>
        <p className="text-mist-500 text-xs mb-5">全部数据将用新口令重新加密</p>

        <form onSubmit={handleSubmit} className="space-y-3">
          <input
            type="password"
            autoFocus
            value={current}
            onChange={(e) => {
              setCurrent(e.target.value)
              setLocalError(null)
              clearError()
            }}
            placeholder="当前口令"
            className="w-full bg-teal-850 text-mist-100 rounded-xl px-4 py-2.5 text-sm outline-none focus:ring-1 focus:ring-dusk-400 placeholder:text-mist-500"
          />
          <input
            type="password"
            value={next}
            onChange={(e) => {
              setNext(e.target.value)
              setLocalError(null)
            }}
            placeholder="新口令(至少 4 个字符)"
            className="w-full bg-teal-850 text-mist-100 rounded-xl px-4 py-2.5 text-sm outline-none focus:ring-1 focus:ring-dusk-400 placeholder:text-mist-500"
          />
          <input
            type="password"
            value={confirm}
            onChange={(e) => {
              setConfirm(e.target.value)
              setLocalError(null)
            }}
            placeholder="确认新口令"
            className="w-full bg-teal-850 text-mist-100 rounded-xl px-4 py-2.5 text-sm outline-none focus:ring-1 focus:ring-dusk-400 placeholder:text-mist-500"
          />

          {shownError && (
            <p className="text-red-300 text-xs bg-red-900/30 border border-red-800/50 rounded-lg px-3 py-2">
              {shownError}
            </p>
          )}

          <button
            type="submit"
            disabled={busy || !current || !next}
            className="w-full py-2.5 rounded-xl bg-dusk-400 text-teal-950 font-medium text-sm transition active:scale-[0.98] disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {busy ? '重新加密中…' : '确认修改'}
          </button>
        </form>
      </div>
    </div>
  )
}
