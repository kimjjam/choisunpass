import { useState, useEffect } from 'react'
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

  // 오늘 출석 데이터 초기 로드
  async function fetchRecords() {
    const { data, error } = await supabase
      .from('attendances')
      .select('*, students(*)')
      .eq('date', today)
      .order('checked_in_at', { ascending: true })

    if (!error && data) {
      setRecords(data as AttendanceWithStudent[])
    }
    setLoading(false)
  }

  // Realtime: pending INSERT 감지
  useEffect(() => {
    fetchRecords()

    const channel = supabase
      .channel('dashboard-attendances')
      .on(
        'postgres_changes',
        {
          event: '*',
          schema: 'public',
          table: 'attendances',
          filter: `date=eq.${today}`,
        },
        () => {
          fetchRecords()
        }
      )
      .subscribe()

    return () => {
      supabase.removeChannel(channel)
    }
  }, [])

  async function handleApprove(id: string) {
    await supabase
      .from('attendances')
      .update({ status: 'approved', approved_at: new Date().toISOString() })
      .eq('id', id)
  }

  async function handleReject() {
    if (!rejectModal) return
    await supabase
      .from('attendances')
      .update({ status: 'rejected', reject_reason: rejectReason || null })
      .eq('id', rejectModal.id)
    setRejectModal(null)
    setRejectReason('')
  }

  async function handleCancelApprove(id: string) {
    await supabase
      .from('attendances')
      .update({ status: 'pending', approved_at: null, word_status: null, oral_status: null })
      .eq('id', id)
  }

  async function handleAllowRetry(id: string) {
    await supabase.from('attendances').delete().eq('id', id)
  }

  async function handleCheckOut(id: string) {
    await supabase
      .from('attendances')
      .update({ checked_out_at: new Date().toISOString() })
      .eq('id', id)
  }

  async function handleCancelCheckOut(id: string) {
    await supabase
      .from('attendances')
      .update({ checked_out_at: null })
      .eq('id', id)
  }

  async function handleMission(id: string, field: 'word_status' | 'oral_status' | 'homework', value: MissionStatus) {
    setRecords(prev => prev.map(r => r.id === id ? { ...r, [field]: value } : r))
    await supabase
      .from('attendances')
      .update({ [field]: value })
      .eq('id', id)
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
      <header className="bg-white border-b border-gray-200 px-4 py-4 flex items-center justify-between">
        <div>
          <div className="text-lg font-bold text-gray-900">조교 대시보드</div>
          <div className="text-xs text-gray-400 mt-0.5">
            {new Date().toLocaleDateString('ko-KR', { month: 'long', day: 'numeric', weekday: 'short' })}
          </div>
        </div>
        <div className="flex items-center gap-3">
          <div className="text-right">
            <div className="text-2xl font-bold text-blue-600">{stats.total}</div>
            <div className="text-xs text-gray-400">오늘 총 출석</div>
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={() => navigate('/admin')}
              className="text-xs text-blue-600 hover:text-blue-800 border border-blue-200 hover:border-blue-400 rounded-lg px-2.5 py-1 transition-colors"
            >
              관리자 페이지
            </button>
            <div className="flex flex-col items-end gap-1">
              <span className="text-xs text-gray-500 font-medium">{currentUser}</span>
              <button
                onClick={async () => { await supabase.auth.signOut(); navigate('/login') }}
                className="text-xs text-gray-400 hover:text-gray-600 border border-gray-200 rounded-lg px-2.5 py-1 transition-colors"
              >
                로그아웃
              </button>
            </div>
          </div>
        </div>
      </header>

      {/* 통계 */}
      <div className="grid grid-cols-3 gap-3 px-4 py-4">
        <StatCard label="승인 대기" value={stats.pending} color="yellow" />
        <StatCard label="등원 완료" value={stats.approved} color="green" />
        <StatCard label="거절" value={stats.rejected} color="red" />
      </div>

      {/* 검색 + 요일 필터 */}
      <div className="px-4 pt-1 pb-2 space-y-2">
        <input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="학생 이름 검색..."
          className="w-full border border-gray-200 rounded-xl px-4 py-2.5 text-sm focus:outline-none focus:border-blue-400"
        />
        <div className="flex gap-1.5">
          {['', '월', '화', '수', '목', '금'].map((d) => (
            <button
              key={d}
              onClick={() => setDayFilter(d)}
              className={`flex-1 py-1.5 rounded-lg text-xs font-medium transition-colors ${
                dayFilter === d
                  ? 'bg-blue-600 text-white'
                  : 'bg-white border border-gray-200 text-gray-500 hover:border-blue-300'
              }`}
            >
              {d || '전체'}
            </button>
          ))}
        </div>
      </div>

      {/* 탭 */}
      <div className="px-4 flex gap-2 mb-3">
        <TabButton active={tab === 'pending'} onClick={() => setTab('pending')}>
          대기 중 {stats.pending > 0 && <span className="ml-1 bg-yellow-500 text-white text-xs rounded-full px-1.5 py-0.5">{stats.pending}</span>}
        </TabButton>
        <TabButton active={tab === 'all'} onClick={() => setTab('all')}>
          전체 현황
        </TabButton>
      </div>

      {/* 목록 */}
      <div className="px-4 pb-8 space-y-3">
        {loading && (
          <div className="text-center py-12 text-gray-400 text-sm">불러오는 중...</div>
        )}
        {!loading && displayList.length === 0 && (
          <div className="text-center py-16 text-gray-400">
            <div className="text-4xl mb-2">{tab === 'pending' ? '🎉' : '📋'}</div>
            <div className="text-sm">
              {tab === 'pending' ? '대기 중인 학생이 없습니다' : '아직 출석 기록이 없습니다'}
            </div>
          </div>
        )}
        {displayList.map((record) => (
          <AttendanceCard
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
      </div>

      {/* 거절 사유 모달 */}
      {rejectModal && (
        <div className="fixed inset-0 bg-black/40 flex items-end justify-center z-50 p-4">
          <div className="bg-white rounded-2xl w-full max-w-sm p-5">
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
                className="flex-1 py-3 rounded-xl border border-gray-200 text-sm text-gray-600 font-medium"
              >
                취소
              </button>
              <button
                onClick={handleReject}
                className="flex-1 py-3 rounded-xl bg-red-500 hover:bg-red-600 text-white text-sm font-semibold transition-colors"
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

function StatCard({ label, value, color }: { label: string; value: number; color: 'yellow' | 'green' | 'red' }) {
  const colors = {
    yellow: 'bg-yellow-50 border-yellow-200 text-yellow-700',
    green: 'bg-green-50 border-green-200 text-green-700',
    red: 'bg-red-50 border-red-200 text-red-700',
  }
  return (
    <div className={`rounded-xl border p-3 text-center ${colors[color]}`}>
      <div className="text-xl font-bold">{value}</div>
      <div className="text-xs mt-0.5 opacity-80">{label}</div>
    </div>
  )
}

function TabButton({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      onClick={onClick}
      className={`flex items-center px-4 py-2 rounded-full text-sm font-medium transition-colors ${
        active ? 'bg-blue-600 text-white' : 'bg-white border border-gray-200 text-gray-600'
      }`}
    >
      {children}
    </button>
  )
}

function AttendanceCard({
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
  const [checkoutError, setCheckoutError] = useState(false)


  const validStatuses = ['pass', 'fail', 'delay']
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

  const statusBadge: Record<string, string> = {
    pending: 'bg-yellow-100 text-yellow-700',
    approved: 'bg-green-100 text-green-700',
    rejected: 'bg-red-100 text-red-700',
  }
  const statusLabel: Record<string, string> = {
    pending: '대기',
    approved: '승인',
    rejected: '거절',
  }

  async function saveField(field: 'notes', value: string) {
    await supabase.from('attendances').update({ [field]: value || null }).eq('id', record.id)
  }

  function handleCheckOutWithValidation() {
    if (!allDone) {
      setCheckoutError(true)
      setTimeout(() => setCheckoutError(false), 3000)
      return
    }
    onCheckOut()
  }

  return (
    <div className="bg-white rounded-2xl border border-gray-100 shadow-sm p-4">
      {/* 학생 정보 */}
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 bg-blue-100 rounded-full flex items-center justify-center text-blue-700 font-bold text-sm">
            {record.students.name[0]}
          </div>
          <div>
            <div className="font-semibold text-gray-900">{record.students.name}</div>
            <div className="text-xs text-gray-400">
              {record.students.school} · {record.students.class}
            </div>
            <div className="text-xs text-gray-400">
              {record.students.oral_type && <span className="text-blue-500">{record.students.oral_type}</span>}
              {record.students.clinic_day && <span className="text-gray-400"> · {record.students.clinic_day}요일</span>}
              <span> · 등원 {checkinTime}</span>
              {checkoutTime && <span className="text-indigo-400"> · 하원 {checkoutTime}</span>}
            </div>
          </div>
        </div>
        <span className={`text-xs font-semibold px-2.5 py-1 rounded-full ${statusBadge[record.status]}`}>
          {statusLabel[record.status]}
        </span>
      </div>

      {/* 승인/거절 버튼 (pending만) */}
      {record.status === 'pending' && (
        <div className="flex gap-2 mb-3">
          <button
            onClick={onApprove}
            className="flex-1 bg-green-500 hover:bg-green-600 text-white font-semibold py-2.5 rounded-xl text-sm transition-colors"
          >
            ✓ 승인
          </button>
          <button
            onClick={onReject}
            className="flex-1 bg-red-100 hover:bg-red-200 text-red-700 font-semibold py-2.5 rounded-xl text-sm transition-colors"
          >
            ✕ 거절
          </button>
        </div>
      )}

      {/* 미션 + 과제/기타 + 하원 + 승인취소 (approved만) */}
      {record.status === 'approved' && (
        <div className="border-t border-gray-100 pt-3 space-y-3">
          <div className="grid grid-cols-3 gap-3">
            <MissionRow
              label="단어"
              value={record.word_status}
              onChange={(v) => onMission(record.id, 'word_status', v)}
            />
            <MissionRow
              label="구두"
              value={record.oral_status}
              onChange={(v) => onMission(record.id, 'oral_status', v)}
            />
            <MissionRow
              label="과제"
              value={validStatuses.includes(record.homework as string) ? record.homework as MissionStatus : null}
              onChange={(v) => onMission(record.id, 'homework', v)}
            />
          </div>

          {/* 기타 */}
          <div>
            <div className="text-xs text-gray-400 mb-1">기타</div>
            <input
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              onBlur={(e) => saveField('notes', e.target.value)}
              placeholder="입력..."
              className="w-full text-xs border border-gray-200 rounded-lg px-2.5 py-1.5 focus:outline-none focus:border-blue-400"
            />
          </div>

          {/* 하원 버튼 */}
          {!record.checked_out_at ? (
            <div className="space-y-1.5">
              {!allDone && (
                <div className="text-center text-xs text-orange-500 font-medium bg-orange-50 rounded-xl py-2 px-3">
                  단어 · 구두 · 과제 모두 선택 후 하원 처리 가능
                </div>
              )}
              {checkoutError && (
                <div className="text-center text-xs text-red-500 font-medium bg-red-50 rounded-xl py-2 px-3">
                  아직 완료되지 않은 클리닉이 남았어요
                </div>
              )}
              <button
                onClick={handleCheckOutWithValidation}
                disabled={!allDone}
                className={`w-full py-2.5 rounded-xl text-sm font-semibold transition-colors ${
                  allDone
                    ? 'bg-indigo-500 hover:bg-indigo-600 text-white'
                    : 'bg-gray-200 text-gray-400 cursor-not-allowed'
                }`}
              >
                하원 처리
              </button>
            </div>
          ) : (
            <div className="flex items-center justify-between bg-indigo-50 rounded-xl px-3 py-2">
              <span className="text-xs text-indigo-600 font-medium">하원 완료 · {checkoutTime}</span>
              <button
                onClick={onCancelCheckOut}
                className="text-xs text-gray-400 hover:text-orange-500 transition-colors"
              >
                취소
              </button>
            </div>
          )}
          <button
            onClick={onCancelApprove}
            className="w-full py-2 rounded-xl border border-gray-200 text-xs text-gray-400 hover:border-orange-300 hover:text-orange-500 transition-colors"
          >
            승인 취소 (대기로 되돌리기)
          </button>
        </div>
      )}

      {/* 거절: 사유 + 재시도 허용 버튼 */}
      {record.status === 'rejected' && (
        <div className="space-y-2 mt-1">
          {record.reject_reason && (
            <div className="bg-red-50 rounded-xl px-3 py-2">
              <p className="text-xs text-red-600">{record.reject_reason}</p>
            </div>
          )}
          <button
            onClick={onAllowRetry}
            className="w-full py-2 rounded-xl border border-gray-200 text-xs text-gray-400 hover:border-blue-300 hover:text-blue-500 transition-colors"
          >
            재시도 허용 (학생이 다시 코드 입력 가능)
          </button>
        </div>
      )}
    </div>
  )
}

function MissionRow({
  label,
  value,
  onChange,
}: {
  label: string
  value: MissionStatus
  onChange: (v: MissionStatus) => void
}) {
  return (
    <div>
      <div className="text-xs text-gray-500 mb-1.5 font-medium">{label}</div>
      <div className="flex flex-col gap-1">
        <button
          onClick={() => onChange(value === 'pass' ? null : 'pass')}
          className={`w-full py-1.5 rounded-lg text-xs font-semibold transition-colors ${
            value === 'pass'
              ? 'bg-green-500 text-white'
              : 'bg-gray-100 text-gray-500 hover:bg-green-100 hover:text-green-700'
          }`}
        >
          Pass
        </button>
        <button
          onClick={() => onChange(value === 'fail' ? null : 'fail')}
          className={`w-full py-1.5 rounded-lg text-xs font-semibold transition-colors ${
            value === 'fail'
              ? 'bg-red-500 text-white'
              : 'bg-gray-100 text-gray-500 hover:bg-red-100 hover:text-red-700'
          }`}
        >
          Fail
        </button>
        <button
          onClick={() => onChange(value === 'delay' ? null : 'delay')}
          className={`w-full py-1.5 rounded-lg text-xs font-semibold transition-colors ${
            value === 'delay'
              ? 'bg-orange-400 text-white'
              : 'bg-gray-100 text-gray-500 hover:bg-orange-100 hover:text-orange-600'
          }`}
        >
          Delay
        </button>
      </div>
    </div>
  )
}
