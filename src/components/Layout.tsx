import { useState } from 'react'
import { NavLink, Outlet } from 'react-router-dom'
import { PenLine, Clock, Lightbulb, Bus, Lock, KeyRound, AlertTriangle } from 'lucide-react'
import { useVaultStore } from '@/store/useVaultStore'
import ChangePassphraseDialog from '@/components/ChangePassphraseDialog'

const navItems = [
  { to: '/', icon: PenLine, label: '记录' },
  { to: '/timeline', icon: Clock, label: '时间线' },
  { to: '/inspire', icon: Lightbulb, label: '灵感' },
]

export default function Layout() {
  const lock = useVaultStore((s) => s.lock)
  const corruptedCount = useVaultStore((s) => s.corruptedCount)
  const [showChangePassphrase, setShowChangePassphrase] = useState(false)

  return (
    <div className="min-h-screen bg-teal-950 flex">
      <aside className="hidden md:flex flex-col w-64 bg-teal-950 border-r border-teal-850/60 p-6">
        <div className="flex items-center gap-3 mb-10">
          <div className="w-10 h-10 rounded-xl bg-dusk-400/20 flex items-center justify-center">
            <Bus className="w-5 h-5 text-dusk-400" />
          </div>
          <div>
            <h1 className="font-serif text-mist-100 text-lg font-semibold leading-tight">窗景采样器</h1>
            <p className="text-mist-500 text-xs">公交车窗的观察笔记</p>
          </div>
        </div>

        <nav className="flex flex-col gap-1 flex-1">
          {navItems.map((item) => (
            <NavLink
              key={item.to}
              to={item.to}
              end={item.to === '/'}
              className={({ isActive }) =>
                `flex items-center gap-3 px-4 py-3 rounded-xl text-sm font-medium transition-all duration-200 ${
                  isActive
                    ? 'bg-dusk-400/15 text-dusk-300'
                    : 'text-mist-400 hover:text-mist-200 hover:bg-white/5'
                }`
              }
            >
              <item.icon className="w-5 h-5" />
              {item.label}
            </NavLink>
          ))}
        </nav>

        <div className="pt-6 border-t border-teal-850/60 space-y-1">
          <button
            onClick={() => setShowChangePassphrase(true)}
            className="w-full flex items-center gap-3 px-4 py-2.5 rounded-xl text-sm text-mist-400 hover:text-mist-200 hover:bg-white/5 transition-all duration-200"
          >
            <KeyRound className="w-4 h-4" />
            修改口令
          </button>
          <button
            onClick={lock}
            className="w-full flex items-center gap-3 px-4 py-2.5 rounded-xl text-sm text-mist-400 hover:text-mist-200 hover:bg-white/5 transition-all duration-200"
          >
            <Lock className="w-4 h-4" />
            锁定保险箱
          </button>
          <p className="text-mist-500 text-xs leading-relaxed px-4 pt-2">
            记录车窗外转瞬即逝的<br />城市片段
          </p>
        </div>
      </aside>

      <main className="flex-1 overflow-auto">
        {corruptedCount > 0 && (
          <div className="sticky top-0 z-40 flex items-center gap-2 bg-amber-900/80 backdrop-blur-sm border-b border-amber-700/50 text-amber-200 text-xs px-4 py-2.5">
            <AlertTriangle className="w-4 h-4 shrink-0" />
            检测到 {corruptedCount} 条记录已损坏或被篡改,未能读取;其余记录不受影响。
          </div>
        )}

        <button
          onClick={lock}
          title="锁定保险箱"
          className="md:hidden fixed top-3 right-3 z-50 w-9 h-9 rounded-full bg-teal-900/80 backdrop-blur-sm border border-teal-800 flex items-center justify-center text-mist-400 hover:text-mist-200 transition-colors"
        >
          <Lock className="w-4 h-4" />
        </button>

        <div className="md:hidden fixed bottom-0 left-0 right-0 z-50 bg-teal-950/95 backdrop-blur-md border-t border-teal-850/60">
          <nav className="flex justify-around py-2">
            {navItems.map((item) => (
              <NavLink
                key={item.to}
                to={item.to}
                end={item.to === '/'}
                className={({ isActive }) =>
                  `flex flex-col items-center gap-1 px-4 py-2 rounded-lg text-xs transition-all duration-200 ${
                    isActive
                      ? 'text-dusk-400'
                      : 'text-mist-500'
                  }`
                }
              >
                <item.icon className="w-5 h-5" />
                {item.label}
              </NavLink>
            ))}
          </nav>
        </div>
        <div className="pb-20 md:pb-0">
          <Outlet />
        </div>
      </main>

      {showChangePassphrase && (
        <ChangePassphraseDialog onClose={() => setShowChangePassphrase(false)} />
      )}
    </div>
  )
}
