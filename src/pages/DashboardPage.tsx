import { useState, useEffect, useRef } from 'react'
import { useNavigate } from 'react-router-dom'
import { supabase } from '../lib/supabase'
import { useCurrentUser } from '../hooks/useCurrentUser'
import type { AttendanceWithStudent, MissionStatus } from '../lib/database.types'

type Tab = 'pending' | 'all'

export default function DashboardPage() {
  const navigate = useNavigate()
  const currentUser = useCurrentUser()
  const [tab, setTab] = useState<Tab>('pending')
  const [records, setRecords] = useState<AttendanceWithStudent[]>([])
  const [loading, setLoading] = useState(true)
  const [rejectModal, setRejectModal] = useState<{ id: string; name: string } | null>(null)
  const [rejectReason, setRejectReason] = useState('')

  const today = new Date().toISOString().split('T')[0]

  async function fetchRecords() {
    const { data, error } = await supabase
      .from('attendances')
      .select('*, students(*)')
      .eq('date', today)
      .order('checked_in_at', { ascending: true })
    if (!error && data) setRecords(data as AttendanceWithStudent[])
    setLoading(false)
  }

  useEffect(() => {
    fetchRecords()
    const channel = supabase
      .channel('dashboard-attendances')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'attendances', filter: `date=eq.${today}` }, () => fetchRecords())
      .subscribe()
    return () => { supabase.removeChannel(channel) }
  }, [])

  async function handleApprove(id: string) {
    await supabase.from('attendances').update({ status: 'approved', approved_at: new Date().toISOString() }).eq('id', id)
  }

  async function handleReject() {
    if (!rejectModal) return
    await supabase.from('attendances').update({ status: 'rejected', reject_reason: rejectReason || null }).eq('id', rejectModal.id)
    setRejectModal(null)
    setRejectReason('')
  }

  async function handleCancelApprove(id: string) {
    await supabase.from('attendances').update({ status: 'pending', approved_at: null, word_status: null, oral_status: null }).eq('id', id)
  }

  async function handleAllowRetry(id: string) {
    await supabase.from('attendances').delete().eq('id', id)
  }

  async function handleCheckOut(id: string) {
    await supabase.from('attendances').update({ checked_out_at: new Date().toISOString() }).eq('id', id)
  }

  async function handleCancelCheckOut(id: string) {
    await supabase.from('attendances').update({ checked_out_at: null }).eq('id', id)
  }

  async function handleMission(id: string, field: 'word_status' | 'oral_status' | 'homework', value: MissionStatus) {
    setRecords(prev => prev.map(r => r.id === id ? { ...r, [field]: value } : r))
    await supabase.from('attendances').update({ [field]: value }).eq('id', id)
  }

  const [search, setSearch] = useState('')
  const [dayFilter, setDayFilter] = useState<string>('')

  const pendingList = records.filter((r) => r.status === 'pending')
  const displayList = (tab === 'pending' ? pendingList : records)
    .filter((r) => r.students.name.includes(search.trim()))
    .filter((r) => !dayFilter || r.students.clinic_day === dayFilter)

  const stats = {
    total: records.length,
    approved: records.filter((r) => r.status === 'approved').length,
    pending: pendingList.length,
    rejected: records.filter((r) => r.status === 'rejected').length,
  }

  return (
    <div className="min-h-screen bg-gray-50">
      {/* 헤더 */}
      <header className="bg-white border-b border-gray-200 px-6 py-3 flex items-center justify-between">
        <div className="flex items-center gap-6">
          <div>
            <div className="text-base font-bold text-gray-900">조교 대시보드</div>
            <div className="text-xs text-gray-400">
              {new Date().toLocaleDateString('ko-KR', { month: 'long', day: 'numeric', weekday: 'short' })}
            </div>
          </div>
          <div className="flex items-center gap-2">
            <StatPill label="전체" value={stats.total} color="blue" />
            <StatPill label="대기" value={stats.pending} color="yellow" />
            <StatPill label="승인" value={stats.approved} color="green" />
            <StatPill label="거절" value={stats.rejected} color="red" />
          </div>
        </div>
        <div className="flex items-center gap-3">
          <button
            onClick={() => navigate('/admin')}
            className="text-xs text-blue-600 hover:text-blue-800 border border-blue-200 hover:border-blue-400 rounded-lg px-3 py-1.5 transition-colors"
          >
            관리자 페이지
          </button>
          <span className="text-xs text-gray-500">{currentUser}</span>
          <button
            onClick={async () => { await supabase.auth.signOut(); navigate('/login') }}
            className="text-xs text-gray-400 hover:text-gray-600 border border-gray-200 rounded-lg px-3 py-1.5 transition-colors"
          >
            로그아웃
          </button>
        </div>
      </header>

      <div className="max-w-screen-2xl mx-auto px-6 py-4">
        {/* 필터 + 탭 */}
        <div className="flex items-center gap-3 mb-4 flex-wrap">
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="학생 이름 검색..."
            className="border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-blue-400 w-44"
          />
          <div className="flex gap-1">
            {['', '월', '화', '수', '목', '금'].map((d) => (
              <button
                key={d}
                onClick={() => setDayFilter(d)}
                className={`px-3 py-1.5 rounded-lg text-xs font-medium transition-colors ${
                  dayFilter === d ? 'bg-blue-600 text-white' : 'bg-white border border-gray-200 text-gray-500 hover:border-blue-300'
                }`}
              >
                {d || '전체'}
              </button>
            ))}
          </div>
          <div className="flex gap-1 ml-2">
            <button
              onClick={() => setTab('pending')}
              className={`flex items-center gap-1.5 px-4 py-1.5 rounded-lg text-sm font-medium transition-colors ${
                tab === 'pending' ? 'bg-blue-600 text-white' : 'bg-white border border-gray-200 text-gray-600'
              }`}
            >
              대기 중
              {stats.pending > 0 && (
                <span className={`text-xs rounded-full px-1.5 py-0.5 ${tab === 'pending' ? 'bg-white/20 text-white' : 'bg-yellow-100 text-yellow-700'}`}>
                  {stats.pending}
                </span>
              )}
            </button>
            <button
              onClick={() => setTab('all')}
              className={`px-4 py-1.5 rounded-lg text-sm font-medium transition-colors ${
                tab === 'all' ? 'bg-blue-600 text-white' : 'bg-white border border-gray-200 text-gray-600'
              }`}
            >
              전체 현황
            </button>
          </div>
        </div>

        {/* 테이블 */}
        <div className="bg-white rounded-2xl border border-gray-100 shadow-sm overflow-hidden">
          {loading ? (
            <div className="py-16 text-center text-gray-400 text-sm">불러오는 중...</div>
          ) : displayList.length === 0 ? (
            <div className="py-16 text-center text-gray-400 text-sm">
              {tab === 'pending' ? '대기 중인 학생이 없습니다 🎉' : '아직 출석 기록이 없습니다'}
            </div>
          ) : (
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-gray-100 bg-gray-50">
                  <th className="px-4 py-3 text-left text-xs font-semibold text-gray-500">이름</th>
                  <th className="px-3 py-3 text-left text-xs font-semibold text-gray-500">학교 · 반</th>
                  <th className="px-3 py-3 text-center text-xs font-semibold text-gray-500">등원</th>
                  <th className="px-3 py-3 text-center text-xs font-semibold text-gray-500">단어</th>
                  <th className="px-3 py-3 text-center text-xs font-semibold text-gray-500">구두</th>
                  <th className="px-3 py-3 text-center text-xs font-semibold text-gray-500">과제</th>
                  <th className="px-3 py-3 text-left text-xs font-semibold text-gray-500">기타</th>
                  <th className="px-3 py-3 text-center text-xs font-semibold text-gray-500">하원</th>
                  <th className="px-3 py-3 text-center text-xs font-semibold text-gray-500">액션</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-50">
                {displayList.map((record) => (
                  <AttendanceRow
                    key={record.id}
                    record={record}
                    onApprove={() => handleApprove(record.id)}
                    onReject={() => setRejectModal({ id: record.id, name: record.students.name })}
                    onCancelApprove={() => handleCancelApprove(record.id)}
                    onAllowRetry={() => handleAllowRetry(record.id)}
                    onCheckOut={() => handleCheckOut(record.id)}
                    onCancelCheckOut={() => handleCancelCheckOut(record.id)}
                    onMission={handleMission}
                  />
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>

      {/* 거절 사유 모달 */}
      {rejectModal && (
        <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 p-4">
          <div className="bg-white rounded-2xl w-full max-w-sm p-5 shadow-xl">
            <h3 className="font-semibold text-gray-800 mb-1">{rejectModal.name} 학생 거절</h3>
            <p className="text-sm text-gray-500 mb-3">사유를 입력하면 학생 화면에 표시됩니다. (선택)</p>
            <textarea
              value={rejectReason}
              onChange={(e) => setRejectReason(e.target.value)}
              placeholder="예: 지각, 본인 확인 불가..."
              rows={3}
              className="w-full border border-gray-200 rounded-xl p-3 text-sm resize-none focus:outline-none focus:border-red-400"
            />
            <div className="flex gap-2 mt-3">
              <button
                onClick={() => { setRejectModal(null); setRejectReason('') }}
                className="flex-1 py-2.5 rounded-xl border border-gray-200 text-sm text-gray-600 font-medium"
              >
                취소
              </button>
              <button
                onClick={handleReject}
                className="flex-1 py-2.5 rounded-xl bg-red-500 hover:bg-red-600 text-white text-sm font-semibold transition-colors"
              >
                거절 확정
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

// ─── 서브 컴포넌트 ────────────────────────────────────────

function StatPill({ label, value, color }: { label: string; value: number; color: 'blue' | 'yellow' | 'green' | 'red' }) {
  const colors = {
    blue: 'bg-blue-50 text-blue-700',
    yellow: 'bg-yellow-50 text-yellow-700',
    green: 'bg-green-50 text-green-700',
    red: 'bg-red-50 text-red-700',
  }
  return (
    <div className={`flex items-center gap-1.5 px-3 py-1 rounded-full text-sm ${colors[color]}`}>
      <span className="font-bold">{value}</span>
      <span className="text-xs opacity-70">{label}</span>
    </div>
  )
}

function AttendanceRow({
  record,
  onApprove,
  onReject,
  onCancelApprove,
  onAllowRetry,
  onCheckOut,
  onCancelCheckOut,
  onMission,
}: {
  record: AttendanceWithStudent
  onApprove: () => void
  onReject: () => void
  onCancelApprove: () => void
  onAllowRetry: () => void
  onCheckOut: () => void
  onCancelCheckOut: () => void
  onMission: (id: string, field: 'word_status' | 'oral_status' | 'homework', value: MissionStatus) => void
}) {
  const [notes, setNotes] = useState(record.notes ?? '')

  const validStatuses = ['pass', 'fail', 'delay']
  const homeworkVal = validStatuses.includes(record.homework as string) ? record.homework as MissionStatus : null
  const allDone =
    validStatuses.includes(record.word_status as string) &&
    validStatuses.includes(record.oral_status as string) &&
    validStatuses.includes(record.homework as string)

  const checkinTime = record.checked_in_at
    ? new Date(record.checked_in_at).toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit' })
    : '-'
  const checkoutTime = record.checked_out_at
    ? new Date(record.checked_out_at).toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit' })
    : null

  const rowBg: Record<string, string> = {
    pending: '',
    approved: '',
    rejected: 'opacity-60',
  }

  async function saveNotes(value: string) {
    await supabase.from('attendances').update({ notes: value || null }).eq('id', record.id)
  }

  return (
    <tr className={`hover:bg-blue-50/30 transition-colors ${rowBg[record.status]}`}>
      {/* 이름 */}
      <td className="px-4 py-3">
        <div className="font-medium text-gray-900">{record.students.name}</div>
        {record.students.oral_type && <div className="text-xs text-blue-500">{record.students.oral_type}</div>}
      </td>
      {/* 학교·반 */}
      <td className="px-3 py-3">
        <div className="text-xs text-gray-700">{record.students.school}</div>
        <div className="text-xs text-gray-400">{record.students.class}</div>
      </td>
      {/* 등원 */}
      <td className="px-3 py-3 text-center text-xs text-gray-600 whitespace-nowrap">{checkinTime}</td>
      {/* 단어 */}
      <td className="px-3 py-3 text-center">
        {record.status === 'approved'
          ? <MissionCycleButton value={record.word_status} onChange={(v) => onMission(record.id, 'word_status', v)} />
          : <span className="text-gray-200 text-xs">—</span>}
      </td>
      {/* 구두 */}
      <td className="px-3 py-3 text-center">
        {record.status === 'approved'
          ? <MissionCycleButton value={record.oral_status} onChange={(v) => onMission(record.id, 'oral_status', v)} />
          : <span className="text-gray-200 text-xs">—</span>}
      </td>
      {/* 과제 */}
      <td className="px-3 py-3 text-center">
        {record.status === 'approved'
          ? <MissionCycleButton value={homeworkVal} onChange={(v) => onMission(record.id, 'homework', v)} />
          : <span className="text-gray-200 text-xs">—</span>}
      </td>
      {/* 기타 */}
      <td className="px-3 py-3">
        {record.status === 'approved' && (
          <input
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            onBlur={(e) => saveNotes(e.target.value)}
            placeholder="메모..."
            className="w-full min-w-[80px] text-xs border-0 border-b border-dashed border-gray-200 focus:border-blue-400 focus:outline-none py-0.5 bg-transparent"
          />
        )}
      </td>
      {/* 하원 */}
      <td className="px-3 py-3 text-center whitespace-nowrap">
        {record.status === 'approved' && (
          !record.checked_out_at ? (
            <button
              onClick={onCheckOut}
              disabled={!allDone}
              title={!allDone ? '단어·구두·과제 완료 후 하원 가능' : ''}
              className={`px-3 py-1.5 rounded-lg text-xs font-semibold transition-colors ${
                allDone
                  ? 'bg-indigo-500 hover:bg-indigo-600 text-white'
                  : 'bg-gray-100 text-gray-300 cursor-not-allowed'
              }`}
            >
              하원 처리
            </button>
          ) : (
            <div className="flex flex-col items-center gap-0.5">
              <span className="text-xs text-indigo-600 font-medium">{checkoutTime}</span>
              <button onClick={onCancelCheckOut} className="text-xs text-gray-300 hover:text-orange-400 transition-colors">취소</button>
            </div>
          )
        )}
      </td>
      {/* 액션 */}
      <td className="px-3 py-3 text-center">
        {record.status === 'pending' && (
          <div className="flex gap-1.5 justify-center">
            <button onClick={onApprove} className="bg-green-500 hover:bg-green-600 text-white text-xs font-semibold px-3 py-1.5 rounded-lg transition-colors">
              승인
            </button>
            <button onClick={onReject} className="bg-red-100 hover:bg-red-200 text-red-700 text-xs font-semibold px-3 py-1.5 rounded-lg transition-colors">
              거절
            </button>
          </div>
        )}
        {record.status === 'approved' && (
          <button onClick={onCancelApprove} className="text-xs text-gray-400 hover:text-orange-500 transition-colors whitespace-nowrap">
            승인 취소
          </button>
        )}
        {record.status === 'rejected' && (
          <div className="space-y-1">
            {record.reject_reason && <div className="text-xs text-red-400">{record.reject_reason}</div>}
            <button onClick={onAllowRetry} className="text-xs text-gray-400 hover:text-blue-500 transition-colors">
              재시도 허용
            </button>
          </div>
        )}
      </td>
    </tr>
  )
}

function MissionCycleButton({ value, onChange }: { value: MissionStatus; onChange: (v: MissionStatus) => void }) {
  const [open, setOpen] = useState(false)
  const [pos, setPos] = useState({ top: 0, left: 0 })
  const btnRef = useRef<HTMLButtonElement>(null)
  const dropdownRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    function handleClick(e: MouseEvent) {
      const target = e.target as Node
      if (
        btnRef.current && !btnRef.current.contains(target) &&
        dropdownRef.current && !dropdownRef.current.contains(target)
      ) {
        setOpen(false)
      }
    }
    document.addEventListener('mousedown', handleClick)
    return () => document.removeEventListener('mousedown', handleClick)
  }, [open])

  function handleOpen() {
    if (btnRef.current) {
      const rect = btnRef.current.getBoundingClientRect()
      setPos({ top: rect.bottom + 4, left: rect.left + rect.width / 2 })
    }
    setOpen((o) => !o)
  }

  const key = value ?? 'null'
  const badgeStyles: Record<string, string> = {
    'null': 'bg-gray-100 text-gray-400',
    'pass': 'bg-green-100 text-green-700',
    'fail': 'bg-red-100 text-red-700',
    'delay': 'bg-orange-100 text-orange-600',
  }
  const labels: Record<string, string> = { 'null': '—', 'pass': 'Pass', 'fail': 'Fail', 'delay': 'Delay' }

  const options: { value: MissionStatus; label: string; style: string }[] = [
    { value: 'pass', label: 'Pass', style: 'hover:bg-green-50 text-green-700' },
    { value: 'fail', label: 'Fail', style: 'hover:bg-red-50 text-red-700' },
    { value: 'delay', label: 'Delay', style: 'hover:bg-orange-50 text-orange-600' },
    { value: null, label: '초기화', style: 'hover:bg-gray-50 text-gray-400' },
  ]

  return (
    <div className="inline-block">
      <button
        ref={btnRef}
        onClick={handleOpen}
        className={`px-2.5 py-1 rounded-lg text-xs font-semibold transition-colors min-w-[52px] ${badgeStyles[key]}`}
      >
        {labels[key]}
      </button>
      {open && (
        <div
          ref={dropdownRef}
          style={{ position: 'fixed', top: pos.top, left: pos.left, transform: 'translateX(-50%)' }}
          className="z-50 bg-white border border-gray-200 rounded-xl shadow-lg py-1 min-w-[80px]"
        >
          {options.map((opt) => (
            <button
              key={String(opt.value)}
              onClick={() => { onChange(opt.value); setOpen(false) }}
              className={`w-full text-left px-3 py-1.5 text-xs font-semibold transition-colors ${opt.style} ${value === opt.value ? 'opacity-40' : ''}`}
            >
              {opt.label}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
