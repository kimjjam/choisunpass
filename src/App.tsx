import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom'
import AttendPage from './pages/AttendPage'
import DashboardPage from './pages/DashboardPage'
import AdminPage from './pages/AdminPage'
import LoginPage from './pages/LoginPage'
import ParentsPage from './pages/ParentsPage'
import ProtectedRoute from './components/ProtectedRoute'

export default function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route path="/" element={<Navigate to="/attend" replace />} />
        <Route path="/attend" element={<AttendPage />} />
        <Route path="/login" element={<LoginPage />} />
        <Route path="/parents" element={<ParentsPage />} />
        <Route path="/dashboard" element={<ProtectedRoute><DashboardPage /></ProtectedRoute>} />
        <Route path="/admin" element={<ProtectedRoute requiredRole="admin"><AdminPage /></ProtectedRoute>} />
      </Routes>
    </BrowserRouter>
  )
}
