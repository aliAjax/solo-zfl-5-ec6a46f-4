import { BrowserRouter as Router, Routes, Route } from 'react-router-dom'
import Layout from '@/components/Layout'
import RecordPage from '@/pages/RecordPage'
import TimelinePage from '@/pages/TimelinePage'
import InspirePage from '@/pages/InspirePage'

export default function App() {
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
