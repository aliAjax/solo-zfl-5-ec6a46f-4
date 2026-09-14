import { useEffect } from 'react'
import { BrowserRouter as Router, Routes, Route } from 'react-router-dom'
import Layout from '@/components/Layout'
import LockScreen from '@/components/LockScreen'
import RecordPage from '@/pages/RecordPage'
import TimelinePage from '@/pages/TimelinePage'
import InspirePage from '@/pages/InspirePage'
import { useVaultStore } from '@/store/useVaultStore'

export default function App() {
  const status = useVaultStore((s) => s.status)
  const init = useVaultStore((s) => s.init)

  useEffect(() => {
    init()
  }, [init])

  // 未解锁时不渲染任何数据页面,内存与本地都不留明文
  if (status !== 'unlocked') {
    return <LockScreen />
  }

  return (
    <Router>
      <Routes>
        <Route element={<Layout />}>
          <Route path="/" element={<RecordPage />} />
          <Route path="/timeline" element={<TimelinePage />} />
          <Route path="/inspire" element={<InspirePage />} />
        </Route>
      </Routes>
    </Router>
  )
}
