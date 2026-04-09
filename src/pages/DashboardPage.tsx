import { useState, useEffect, useRef } from 'react'
import { createPortal } from 'react-dom'
import { useNavigate } from 'react-router-dom'
import { supabase } from '../lib/supabase'
import { useCurrentUser } from '../hooks/useCurrentUser'
import type { AttendanceWithStudent, MissionStatus, OralQueueWithStudent, Student } from '../lib/database.types'
import StudentHistoryModal from '../components/StudentHistoryModal'

type Tab = 'pending' | 'clinic' | 'class_clinic' | 'checked_out' | 'overview' | 'oral' | 'rejected'

export default function DashboardPage() {
  const navigate = useNavigate()
  const currentUser = useCurrentUser()
  const [tab, setTab] = useState<Tab>('pending')
  const [records, setRecords] = useState<AttendanceWithStudent[]>([])
  const [loading, setLoading] = useState(true)
  const [approveModal, setApproveModal] = useState<{ id: string; name: string } | null>(null)
  const [rejectModal, setRejectModal] = useState<{ id: string; name: string } | null>(null)
  const [cancelApproveModal, setCancelApproveModal] = useState<{ id: string; name: string } | null>(null)
  const [forceCheckoutModal, setForceCheckoutModal] = useState<{ id: string; name: string; record: AttendanceWithStudent } | null>(null)
  const [forceCheckoutDate, setForceCheckoutDate] = useState('')
  const [checkoutConfirmModal, setCheckoutConfirmModal] = useState<{ id: string; name: string } | null>(null)
  const [cancelCheckoutModal, setCancelCheckoutModal] = useState<{ id: string; name: string } | null>(null)
  const [cancelNextClinicModal, setCancelNextClinicModal] = useState<{ id: string; name: string } | null>(null)
  const [nextClinicSetModal, setNextClinicSetModal] = useState<{ id: string; name: string; currentDate: string | null } | null>(null)
  const [nextClinicDateInput, setNextClinicDateInput] = useState('')
  const [historyTarget, setHistoryTarget] = useState<Student | null>(null)
  const [historyRecords, setHistoryRecords] = useState<AttendanceWithStudent[]>([])
  const [rejectReason, setRejectReason] = useState('')
  const [showBulkConfirm, setShowBulkConfirm] = useState(false)
  const [weekValuesMap, setWeekValuesMap] = useState<Map<string, Record<string, string | null>>>(new Map())

  // 한국 로컬 날짜 기준 — 매 조회 시점에 계산 (자정 넘어가도 갱신됨)
  function getToday() {
    const d = new Date()
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
  }

  function getThisWeekMonday() {
    const d = new Date()
    const day = d.getDay()
    const diff = day === 0 ? -6 : 1 - day
    d.setDate(d.getDate() + diff)
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
  }

  async function fetchRecords() {
    const today = getToday()
    const { data, error } = await supabase
      .from('attendances')
      .select('*, students(*)')
      .eq('date', today)
      .order('checked_in_at', { ascending: true })
    if (!error && data) {
      setRecords(data as AttendanceWithStudent[])

      // 이번 주 월~어제 데이터 조회 → 상속값 Map 생성
      const weekMonday = getThisWeekMonday()
      if (weekMonday < today && data.length > 0) {
        const studentIds = (data as AttendanceWithStudent[]).map(r => r.student_id)
        const { data: weekData } = await supabase
          .from('attendances')
          .select('student_id, word_score, clinic_score, oral_status, homework, oral_memo, homework_memo, notes, next_clinic_date')
          .in('student_id', studentIds)
          .gte('date', weekMonday)
          .lt('date', today)
          .eq('status', 'approved')
        const map = new Map<string, Record<string, string | null>>()
        for (const r of (weekData || []) as Record<string, string | null>[]) {
          const sid = r.student_id as string
          const acc = map.get(sid) || {}
          const pick = (f: string) => { if (!acc[f] && (r[f] as string)?.trim()) acc[f] = r[f] }
          pick('word_score'); pick('clinic_score'); pick('oral_memo'); pick('homework_memo'); pick('notes')
          if (!acc.oral_status && r.oral_status) acc.oral_status = r.oral_status
          if (!acc.homework && r.homework) acc.homework = r.homework
          map.set(sid, acc)
        }
        setWeekValuesMap(map)
      } else {
        setWeekValuesMap(new Map())
      }
    }
    setLoading(false)
  }

  useEffect(() => {
    fetchRecords()
    const channel = supabase
      .channel('dashboard-attendances')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'attendances', filter: `date=eq.${getToday()}` }, (payload) => {
        if (payload.eventType === 'UPDATE' && payload.new) {
          // UPDATE는 payload.new로 해당 레코드만 직접 머지 (fetchRecords 하면 DB 커밋 전 stale 데이터가 올 수 있음)
          setRecords(prev => prev.map(r => r.id === payload.new.id ? { ...r, ...payload.new } : r))
        } else {
          // INSERT / DELETE는 전체 재조회 (students 관계 데이터 필요)
          fetchRecords()
        }
      })
      .subscribe()

    // 리얼타임이 이벤트를 놓칠 경우를 대비한 10초 폴링 백업
    const pollInterval = setInterval(fetchRecords, 10000)

    return () => {
      supabase.removeChannel(channel)
      clearInterval(pollInterval)
    }
  }, [])

  async function handleApprove() {
    if (!approveModal) return
    const { id } = approveModal
    const now = new Date().toISOString()
    const prev = records
    setRecords(prev => prev.map(r => r.id === id ? { ...r, status: 'approved', approved_at: now } : r))
    const { error } = await supabase.from('attendances').update({ status: 'approved', approved_at: now }).eq('id', id)
    if (error) { console.error('승인 실패:', error); setRecords(prev); return }
    setApproveModal(null)
  }

  async function handleReject() {
    if (!rejectModal) return
    const { id } = rejectModal
    const prev = records
    setRecords(p => p.map(r => r.id === id ? { ...r, status: 'rejected', reject_reason: rejectReason || null } : r))
    const { error } = await supabase.from('attendances').update({ status: 'rejected', reject_reason: rejectReason || null }).eq('id', id)
    if (error) { console.error('거절 실패:', error); setRecords(prev); return }
    setRejectModal(null)
    setRejectReason('')
  }

  async function handleCancelApprove(id: string) {
    const prev = records
    setRecords(p => p.map(r => r.id === id ? { ...r, status: 'pending', approved_at: null } : r))
    const { error } = await supabase.from('attendances').update({ status: 'pending', approved_at: null }).eq('id', id)
    if (error) { console.error('승인취소 실패:', error); setRecords(prev); return }
    setCancelApproveModal(null)
  }

  async function handleAllowRetry(id: string) {
    const prev = records
    setRecords(p => p.filter(r => r.id !== id))
    const { error } = await supabase.from('attendances').delete().eq('id', id)
    if (error) { console.error('삭제 실패:', error); setRecords(prev) }
  }

  async function handleCheckOut(id: string) {
    const now = new Date().toISOString()
    const prev = records
    setRecords(p => p.map(r => r.id === id ? { ...r, checked_out_at: now } : r))
    const { error } = await supabase.from('attendances').update({ checked_out_at: now }).eq('id', id)
    if (error) { console.error('하원 실패:', error); setRecords(prev) }
  }

  async function handleCancelCheckOut(id: string) {
    const prev = records
    setRecords(p => p.map(r => r.id === id ? { ...r, checked_out_at: null } : r))
    const { error } = await supabase.from('attendances').update({ checked_out_at: null }).eq('id', id)
    if (error) { console.error('하원취소 실패:', error); setRecords(prev) }
  }

  async function handleMission(id: string, field: 'word_status' | 'oral_status' | 'homework', value: MissionStatus) {
    const prev = records
    setRecords(p => p.map(r => r.id === id ? { ...r, [field]: value } : r))
    const { error } = await supabase.from('attendances').update({ [field]: value }).eq('id', id)
    if (error) { console.error('미션 업데이트 실패:', error); setRecords(prev) }
  }

  const [oralQueue, setOralQueue] = useState<OralQueueWithStudent[]>([])
  const [callerModal, setCallerModal] = useState<string | null>(null) // queueId 저장
  const [oralDoneModal, setOralDoneModal] = useState<{ queueId: string; attendanceId: string; studentName: string } | null>(null)
  const [oralDoneForm, setOralDoneForm] = useState<{ wordScore: string; clinicScore: string; oralStatus: MissionStatus; homework: MissionStatus; oralMemo: string; homeworkMemo: string; notes: string }>({ wordScore: '', clinicScore: '', oralStatus: null, homework: null, oralMemo: '', homeworkMemo: '', notes: '' })
  const CALLERS = ['김재민조교', '조은채조교', '신수현조교', '이채연조교', '박성우조교']

  async function fetchOralQueue() {
    const { data } = await supabase
      .from('oral_queue')
      .select('*, students(*)')
      .in('status', ['waiting', 'called'])
      .order('created_at', { ascending: true })
    if (data) setOralQueue(data as OralQueueWithStudent[])
  }

  useEffect(() => {
    fetchOralQueue()
    const ch = supabase
      .channel('dashboard-oral-queue')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'oral_queue' }, fetchOralQueue)
      .subscribe()
    return () => { supabase.removeChannel(ch) }
  }, [])

  async function handleCallStudent(queueId: string, caller: string) {
    await supabase.from('oral_queue').update({ status: 'called', caller }).eq('id', queueId)
    setCallerModal(null)
    fetchOralQueue()
  }

  async function openOralDoneModal(q: OralQueueWithStudent) {
    // 기존 성적 pre-fill
    const { data } = await supabase.from('attendances').select('word_score, clinic_score, oral_status, homework, oral_memo, homework_memo, notes').eq('id', q.attendance_id).maybeSingle()
    setOralDoneForm({
      wordScore: data?.word_score ?? '',
      clinicScore: data?.clinic_score ?? '',
      oralStatus: (data?.oral_status as MissionStatus) ?? null,
      homework: (data?.homework as MissionStatus) ?? null,
      oralMemo: data?.oral_memo ?? '',
      homeworkMemo: data?.homework_memo ?? '',
      notes: data?.notes ?? '',
    })
    setOralDoneModal({ queueId: q.id, attendanceId: q.attendance_id, studentName: q.students.name })
  }

  async function handleOralDoneSubmit() {
    if (!oralDoneModal) return
    const { attendanceId, queueId } = oralDoneModal
    const { error: attError } = await supabase.from('attendances').update({
      word_score: oralDoneForm.wordScore.trim() || null,
      clinic_score: oralDoneForm.clinicScore.trim() || null,
      oral_status: oralDoneForm.oralStatus,
      homework: oralDoneForm.homework,
      oral_memo: oralDoneForm.oralMemo.trim() || null,
      homework_memo: oralDoneForm.homeworkMemo.trim() || null,
      notes: oralDoneForm.notes.trim() || null,
    }).eq('id', attendanceId)
    if (attError) {
      console.error('구두 성적 저장 실패:', attError)
      alert('성적 저장에 실패했습니다. 다시 시도해주세요.')
      return
    }
    const { error: queueError } = await supabase.from('oral_queue').delete().eq('id', queueId)
    if (queueError) {
      console.error('구두 대기열 삭제 실패:', queueError)
      alert('대기열 삭제에 실패했습니다. 성적은 저장됐으니 대기열을 수동으로 제거해주세요.')
    }
    setOralDoneModal(null)
    fetchOralQueue()
    fetchRecords()
  }

  async function handleRemoveFromQueue(queueId: string) {
    await supabase.from('oral_queue').delete().eq('id', queueId)
    fetchOralQueue()
  }

  async function openHistory(student: Student) {
    setHistoryTarget(student)
    const { data } = await supabase
      .from('attendances')
      .select('*, students(*)')
      .eq('student_id', student.id)
      .order('date', { ascending: false })
    if (data) setHistoryRecords(data as AttendanceWithStudent[])
  }

  async function handleSetNextClinicDate(id: string, date: string) {
    const prev = records
    setRecords(p => p.map(r => r.id === id ? { ...r, next_clinic_date: date } : r))
    const { error } = await supabase.from('attendances').update({ next_clinic_date: date }).eq('id', id)
    if (error) { console.error('재등원 날짜 설정 실패:', error); setRecords(prev); return }
    setNextClinicSetModal(null)
    setNextClinicDateInput('')
  }

  async function handleCancelNextClinic(id: string) {
    const prev = records
    setRecords(p => p.map(r => r.id === id ? { ...r, next_clinic_date: null, checkout_requested: false } : r))
    const { error } = await supabase.from('attendances').update({ next_clinic_date: null, checkout_requested: false }).eq('id', id)
    if (error) { console.error('재등원취소 실패:', error); setRecords(prev) }
    setCancelNextClinicModal(null)
  }

  async function handleForceCheckOut(id: string) {
    const now = new Date().toISOString()
    const prev = records
    setRecords(p => p.map(r => r.id === id ? { ...r, checked_out_at: now, checkout_requested: false } : r))
    const { error } = await supabase.from('attendances').update({ checked_out_at: now, checkout_requested: false }).eq('id', id)
    if (error) { console.error('강제하원 실패:', error); setRecords(prev) }
  }

  async function handleAdminForceCheckout() {
    if (!forceCheckoutModal || !forceCheckoutDate) return
    const { id, record } = forceCheckoutModal
    const now = new Date().toISOString()
    const validStatuses = ['pass', 'fail', 'delay', 'word_pass', 'sentence_pass', 'partial_pass', 'exempt']
    const updates: Record<string, unknown> = {
      checked_out_at: now,
      next_clinic_date: forceCheckoutDate,
      word_score: record.word_score?.trim() ? record.word_score : '00',
      clinic_score: record.clinic_score?.trim() ? record.clinic_score : '00',
      oral_status: validStatuses.includes(record.oral_status as string) ? record.oral_status : 'delay',
      homework: validStatuses.includes(record.homework as string) ? record.homework : 'delay',
    }
    const prev = records
    setRecords(p => p.map(r => r.id === id ? { ...r, ...updates } : r))
    const { error } = await supabase.from('attendances').update(updates).eq('id', id)
    if (error) { console.error('강제하원(관리자) 실패:', error); setRecords(prev); return }
    setForceCheckoutModal(null)
    setForceCheckoutDate('')
  }

  const VALID = ['pass', 'fail', 'delay', 'word_pass', 'sentence_pass', 'partial_pass', 'exempt']
  function isAllDone(r: AttendanceWithStudent) {
    return !!r.word_score?.trim() && !!r.clinic_score?.trim() &&
      VALID.includes(r.oral_status as string) && VALID.includes(r.homework as string)
  }

  async function handleBulkCheckOut() {
    const now = new Date().toISOString()
    const targets = classClinicList.filter(r => !r.checked_out_at)
    const failed: string[] = []

    for (const r of targets) {
      if (isAllDone(r)) {
        const { error } = await supabase.from('attendances').update({ checked_out_at: now }).eq('id', r.id)
        if (error) { console.error(`하원 실패 (${r.students.name}):`, error); failed.push(r.students.name) }
      } else {
        const { error } = await supabase.from('attendances').update({ force_next_clinic: true }).eq('id', r.id)
        if (error) { console.error(`강제하원 플래그 실패 (${r.students.name}):`, error); failed.push(r.students.name) }
      }
    }

    if (failed.length > 0) {
      alert(`일부 학생 처리 실패:\n${failed.join(', ')}\n\n해당 학생은 수동으로 하원 처리해주세요.`)
    }

    fetchRecords()
  }

  const [search, setSearch] = useState('')
  const [schoolFilter, setSchoolFilter] = useState<string[]>([])
  const [schoolDropdownOpen, setSchoolDropdownOpen] = useState(false)

  const schools = [...new Set(records.map(r => r.students.school).filter(Boolean))].sort()

  const pendingList = records
    .filter(r => r.status === 'pending')
    .filter(r => !search || r.students.name.includes(search.trim()))
    .filter(r => !schoolFilter.length || schoolFilter.includes(r.students.school))

  const clinicList = records
    .filter(r => r.visit_type === 'clinic' && r.status === 'approved')
    .filter(r => !search || r.students.name.includes(search.trim()))
    .filter(r => !schoolFilter.length || schoolFilter.includes(r.students.school))
    .sort((a, b) => a.students.name.localeCompare(b.students.name, 'ko'))

  const classClinicList = records
    .filter(r => r.visit_type === 'class_clinic' && r.status === 'approved')
    .filter(r => !search || r.students.name.includes(search.trim()))
    .filter(r => !schoolFilter.length || schoolFilter.includes(r.students.school))
    .sort((a, b) => a.students.name.localeCompare(b.students.name, 'ko'))

  // 학생이 직접 "다음에 올게요" 요청한 경우만 (조교가 날짜만 입력한 경우 제외)
  const forceCheckOutList = records.filter(
    r => r.visit_type === 'clinic' && r.checkout_requested && !r.checked_out_at && r.status === 'approved'
  )

  const checkedOutList = records
    .filter(r => r.status === 'approved' && !!r.checked_out_at)
    .filter(r => !search || r.students.name.includes(search.trim()))
    .filter(r => !schoolFilter.length || schoolFilter.includes(r.students.school))
    .sort((a, b) => (b.checked_out_at ?? '').localeCompare(a.checked_out_at ?? ''))

  const overviewList = [
    ...records.filter(r => r.status === 'approved'),
  ]
    .filter(r => !search || r.students.name.includes(search.trim()))
    .filter(r => !schoolFilter.length || schoolFilter.includes(r.students.school))
    .sort((a, b) => (a.checked_in_at ?? '').localeCompare(b.checked_in_at ?? ''))

  const rejectedList = records
    .filter(r => r.status === 'rejected')
    .filter(r => !search || r.students.name.includes(search.trim()))
    .filter(r => !schoolFilter.length || schoolFilter.includes(r.students.school))
    .sort((a, b) => a.students.name.localeCompare(b.students.name, 'ko'))

  const stats = {
    total: records.length,
    approved: records.filter((r) => r.status === 'approved').length,
    pending: records.filter(r => r.status === 'pending').length,
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
            <button
              onClick={() => setTab('oral')}
              className={`flex items-center gap-1.5 px-3 py-1 rounded-lg text-xs font-medium transition-colors ml-1 ${
                tab === 'oral' ? 'bg-purple-600 text-white' : 'bg-purple-50 border border-purple-200 text-purple-600 hover:bg-purple-100'
              }`}
            >
              구두 대기
              {oralQueue.length > 0 && (
                <span className={`text-xs rounded-full px-1.5 py-0.5 ${tab === 'oral' ? 'bg-white/20 text-white' : 'bg-purple-100 text-purple-700'}`}>
                  {oralQueue.length}
                </span>
              )}
            </button>
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
          <div className="relative">
            <button
              onClick={() => setSchoolDropdownOpen(o => !o)}
              className={`border rounded-lg px-3 py-2 text-sm text-left min-w-[120px] flex items-center gap-2 transition-colors ${
                schoolFilter.length ? 'border-blue-400 bg-blue-50 text-blue-700' : 'border-gray-200 text-gray-600 hover:border-gray-300'
              }`}
            >
              <span className="flex-1 truncate">
                {schoolFilter.length === 0 ? '전체 학교' : schoolFilter.length === 1 ? schoolFilter[0] : `${schoolFilter[0]} 외 ${schoolFilter.length - 1}개`}
              </span>
              <svg className={`w-3.5 h-3.5 flex-shrink-0 transition-transform ${schoolDropdownOpen ? 'rotate-180' : ''}`} fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
              </svg>
            </button>
            {schoolDropdownOpen && (
              <div className="absolute top-full left-0 mt-1 bg-white border border-gray-200 rounded-xl shadow-lg z-30 min-w-[160px] py-1">
                <button
                  onClick={() => { setSchoolFilter([]); setSchoolDropdownOpen(false) }}
                  className={`w-full text-left px-3 py-2 text-sm hover:bg-gray-50 transition-colors ${schoolFilter.length === 0 ? 'text-blue-600 font-semibold' : 'text-gray-600'}`}
                >
                  전체 학교
                </button>
                <div className="border-t border-gray-100 my-1" />
                {schools.map(s => (
                  <label key={s} className="flex items-center gap-2.5 px-3 py-2 hover:bg-gray-50 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={schoolFilter.includes(s)}
                      onChange={() => setSchoolFilter(prev =>
                        prev.includes(s) ? prev.filter(x => x !== s) : [...prev, s]
                      )}
                      className="w-3.5 h-3.5 accent-blue-500"
                    />
                    <span className="text-sm text-gray-700">{s}</span>
                  </label>
                ))}
              </div>
            )}
            {schoolDropdownOpen && (
              <div className="fixed inset-0 z-20" onClick={() => setSchoolDropdownOpen(false)} />
            )}
          </div>
          <div className="flex gap-1 ml-2">
            <button
              onClick={() => setTab('pending')}
              className={`flex items-center gap-1.5 px-4 py-1.5 rounded-lg text-sm font-medium transition-colors ${
                tab === 'pending' ? 'bg-yellow-500 text-white' : 'bg-white border border-gray-200 text-gray-600'
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
              onClick={() => setTab('clinic')}
              className={`flex items-center gap-1.5 px-4 py-1.5 rounded-lg text-sm font-medium transition-colors ${
                tab === 'clinic' ? 'bg-blue-600 text-white' : 'bg-white border border-gray-200 text-gray-600'
              }`}
            >
              클리닉
              <span className={`text-xs rounded-full px-1.5 py-0.5 ${tab === 'clinic' ? 'bg-white/20 text-white' : 'bg-blue-100 text-blue-700'}`}>
                {forceCheckOutList.length > 0 ? `!${forceCheckOutList.length}` : clinicList.length}
              </span>
            </button>
            <button
              onClick={() => setTab('class_clinic')}
              className={`flex items-center gap-1.5 px-4 py-1.5 rounded-lg text-sm font-medium transition-colors ${
                tab === 'class_clinic' ? 'bg-green-600 text-white' : 'bg-white border border-gray-200 text-gray-600'
              }`}
            >
              수업+클리닉
              <span className={`text-xs rounded-full px-1.5 py-0.5 ${tab === 'class_clinic' ? 'bg-white/20 text-white' : 'bg-green-100 text-green-700'}`}>
                {classClinicList.length}
              </span>
            </button>
            <button
              onClick={() => setTab('checked_out')}
              className={`flex items-center gap-1.5 px-4 py-1.5 rounded-lg text-sm font-medium transition-colors ${
                tab === 'checked_out' ? 'bg-orange-500 text-white' : 'bg-white border border-gray-200 text-gray-600'
              }`}
            >
              하원
              <span className={`text-xs rounded-full px-1.5 py-0.5 ${tab === 'checked_out' ? 'bg-white/20 text-white' : 'bg-orange-100 text-orange-600'}`}>
                {checkedOutList.length}
              </span>
            </button>
            <button
              onClick={() => setTab('overview')}
              className={`flex items-center gap-1.5 px-4 py-1.5 rounded-lg text-sm font-medium transition-colors ${
                tab === 'overview' ? 'bg-slate-600 text-white' : 'bg-white border border-gray-200 text-gray-600'
              }`}
            >
              전체현황
              <span className={`text-xs rounded-full px-1.5 py-0.5 ${tab === 'overview' ? 'bg-white/20 text-white' : 'bg-slate-100 text-slate-600'}`}>
                {overviewList.length}
              </span>
            </button>
            <button
              onClick={() => setTab('rejected')}
              className={`flex items-center gap-1.5 px-4 py-1.5 rounded-lg text-sm font-medium transition-colors ${
                tab === 'rejected' ? 'bg-red-500 text-white' : 'bg-white border border-gray-200 text-gray-600'
              }`}
            >
              거절
              {stats.rejected > 0 && (
                <span className={`text-xs rounded-full px-1.5 py-0.5 ${tab === 'rejected' ? 'bg-white/20 text-white' : 'bg-red-100 text-red-600'}`}>
                  {stats.rejected}
                </span>
              )}
            </button>
          </div>
        </div>

        {/* 하원 탭 */}
        {tab === 'checked_out' && (
          <div className="bg-white rounded-2xl border border-gray-100 shadow-sm overflow-hidden">
            {loading ? (
              <div className="py-16 text-center text-gray-400 text-sm">불러오는 중...</div>
            ) : checkedOutList.length === 0 ? (
              <div className="py-16 text-center text-gray-400 text-sm">하원한 학생이 없습니다</div>
            ) : (
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-gray-100 bg-gray-50">
                    <th className="px-4 py-3 text-left text-xs font-semibold text-gray-500">#</th>
                    <th className="px-4 py-3 text-left text-xs font-semibold text-gray-500">이름</th>
                    <th className="px-3 py-3 text-left text-xs font-semibold text-gray-500">학교 · 반</th>
                    <th className="px-3 py-3 text-center text-xs font-semibold text-gray-500">유형</th>
                    <th className="px-3 py-3 text-center text-xs font-semibold text-gray-500">등원</th>
                    <th className="px-3 py-3 text-center text-xs font-semibold text-gray-500">단어</th>
                    <th className="px-3 py-3 text-center text-xs font-semibold text-gray-500">클리닉</th>
                    <th className="px-3 py-3 text-center text-xs font-semibold text-gray-500">구두</th>
                    <th className="px-3 py-3 text-center text-xs font-semibold text-gray-500">과제</th>
                    <th className="px-3 py-3 text-center text-xs font-semibold text-gray-500">하원</th>
                    <th className="px-3 py-3 text-center text-xs font-semibold text-gray-500">재등원 예정</th>
                    <th className="px-3 py-3 text-center text-xs font-semibold text-gray-500">액션</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-50">
                  {checkedOutList.map((r, idx) => {
                    const missionBadge = (v: string | null) => {
                      if (!v) return <span className="text-gray-300">-</span>
                      const map: Record<string, string> = { pass: 'bg-green-100 text-green-700', fail: 'bg-red-100 text-red-600', delay: 'bg-yellow-100 text-yellow-700', word_pass: 'bg-orange-100 text-orange-600', sentence_pass: 'bg-orange-100 text-orange-600', partial_pass: 'bg-orange-100 text-orange-600', exempt: 'bg-teal-100 text-teal-700' }
                      const label: Record<string, string> = { pass: 'Pass', fail: 'Fail', delay: 'Delay', word_pass: '단어P', sentence_pass: '문장P', partial_pass: '일부P', exempt: '면제' }
                      return <span className={`text-xs px-1.5 py-0.5 rounded-full font-medium ${map[v] ?? 'bg-gray-100 text-gray-500'}`}>{label[v] ?? v}</span>
                    }
                    return (
                      <tr key={r.id} className="hover:bg-orange-50 transition-colors">
                        <td className="px-4 py-3 text-xs text-gray-400">{idx + 1}</td>
                        <td className="px-4 py-3 font-medium text-gray-800">{r.students.name}</td>
                        <td className="px-3 py-3 text-xs text-gray-500">
                          {r.students.school}<br />
                          <span className="text-blue-400">{r.students.class}</span>
                        </td>
                        <td className="px-3 py-3 text-center">
                          {r.visit_type === 'class_clinic'
                            ? <span className="text-xs bg-green-100 text-green-700 px-2 py-0.5 rounded-full font-medium">수업+클리닉</span>
                            : <span className="text-xs bg-blue-100 text-blue-700 px-2 py-0.5 rounded-full font-medium">클리닉</span>
                          }
                        </td>
                        <td className="px-3 py-3 text-center text-xs text-gray-500">
                          {r.checked_in_at ? new Date(r.checked_in_at).toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit' }) : '-'}
                        </td>
                        <td className="px-3 py-3 text-center text-xs text-gray-700">{r.word_score || <span className="text-gray-300">-</span>}</td>
                        <td className="px-3 py-3 text-center text-xs text-gray-700">{r.clinic_score || <span className="text-gray-300">-</span>}</td>
                        <td className="px-3 py-3 text-center">{missionBadge(r.oral_status)}</td>
                        <td className="px-3 py-3 text-center">{missionBadge(r.homework)}</td>
                        <td className="px-3 py-3 text-center text-xs font-semibold text-orange-500">
                          {r.checked_out_at ? new Date(r.checked_out_at).toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit' }) : '-'}
                        </td>
                        <td className="px-3 py-3 text-center text-xs">
                          {r.next_clinic_date
                            ? <span className="text-blue-600 font-medium">{r.next_clinic_date}</span>
                            : <span className="text-gray-300">-</span>
                          }
                        </td>
                        <td className="px-3 py-3 text-center">
                          <button
                            onClick={() => setCancelCheckoutModal({ id: r.id, name: r.students.name })}
                            className="text-xs text-red-500 hover:text-red-700 border border-red-200 hover:border-red-400 px-2 py-1 rounded-lg transition-colors"
                          >
                            하원 취소
                          </button>
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            )}
          </div>
        )}

        {/* 전체현황 탭 */}
        {tab === 'overview' && (
          <div className="bg-white rounded-2xl border border-gray-100 shadow-sm overflow-hidden">
            {loading ? (
              <div className="py-16 text-center text-gray-400 text-sm">불러오는 중...</div>
            ) : overviewList.length === 0 ? (
              <div className="py-16 text-center text-gray-400 text-sm">승인된 학생이 없습니다</div>
            ) : (
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-gray-100 bg-gray-50">
                    <th className="px-4 py-3 text-left text-xs font-semibold text-gray-500">이름</th>
                    <th className="px-3 py-3 text-left text-xs font-semibold text-gray-500">학교 · 반</th>
                    <th className="px-3 py-3 text-center text-xs font-semibold text-gray-500">유형</th>
                    <th className="px-3 py-3 text-center text-xs font-semibold text-gray-500">등원</th>
                    <th className="px-3 py-3 text-center text-xs font-semibold text-gray-500">단어</th>
                    <th className="px-3 py-3 text-center text-xs font-semibold text-gray-500">클리닉</th>
                    <th className="px-3 py-3 text-center text-xs font-semibold text-gray-500">구두</th>
                    <th className="px-3 py-3 text-center text-xs font-semibold text-gray-500">과제</th>
                    <th className="px-3 py-3 text-center text-xs font-semibold text-gray-500">하원</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-50">
                  {overviewList.map(r => {
                    const missionBadge = (v: string | null) => {
                      if (!v) return <span className="text-gray-300">-</span>
                      const map: Record<string, string> = { pass: 'bg-green-100 text-green-700', fail: 'bg-red-100 text-red-600', delay: 'bg-yellow-100 text-yellow-700', word_pass: 'bg-orange-100 text-orange-600', sentence_pass: 'bg-orange-100 text-orange-600', partial_pass: 'bg-orange-100 text-orange-600', exempt: 'bg-teal-100 text-teal-700' }
                      const label: Record<string, string> = { pass: 'Pass', fail: 'Fail', delay: 'Delay', word_pass: '단어P', sentence_pass: '문장P', partial_pass: '일부P', exempt: '면제' }
                      return <span className={`text-xs px-1.5 py-0.5 rounded-full font-medium ${map[v] ?? 'bg-gray-100 text-gray-500'}`}>{label[v] ?? v}</span>
                    }
                    return (
                      <tr key={r.id} className={r.checked_out_at ? 'bg-gray-50 opacity-60' : ''}>
                        <td className="px-4 py-3 font-medium text-gray-800">{r.students.name}</td>
                        <td className="px-3 py-3 text-xs text-gray-500">
                          {r.students.school}<br />
                          <span className="text-blue-400">{r.students.class}</span>
                        </td>
                        <td className="px-3 py-3 text-center">
                          {r.visit_type === 'class_clinic'
                            ? <span className="text-xs bg-green-100 text-green-700 px-2 py-0.5 rounded-full font-medium">수업+클리닉</span>
                            : <span className="text-xs bg-blue-100 text-blue-700 px-2 py-0.5 rounded-full font-medium">클리닉</span>
                          }
                        </td>
                        <td className="px-3 py-3 text-center text-xs text-gray-500">
                          {r.checked_in_at ? new Date(r.checked_in_at).toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit' }) : '-'}
                        </td>
                        <td className="px-3 py-3 text-center text-xs text-gray-700">{r.word_score || <span className="text-gray-300">-</span>}</td>
                        <td className="px-3 py-3 text-center text-xs text-gray-700">{r.clinic_score || <span className="text-gray-300">-</span>}</td>
                        <td className="px-3 py-3 text-center">{missionBadge(r.oral_status)}</td>
                        <td className="px-3 py-3 text-center">{missionBadge(r.homework)}</td>
                        <td className="px-3 py-3 text-center text-xs">
                          {r.checked_out_at
                            ? <span className="text-gray-400">{new Date(r.checked_out_at).toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit' })}</span>
                            : <span className="text-green-600 font-medium">재원 중</span>
                          }
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            )}
          </div>
        )}

        {/* 구두 대기 탭 */}
        {tab === 'oral' && (
          <div className="bg-white rounded-2xl border border-gray-100 shadow-sm overflow-hidden">
            {oralQueue.length === 0 ? (
              <div className="py-16 text-center text-gray-400 text-sm">구두 대기 중인 학생이 없습니다</div>
            ) : (
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-gray-100 bg-gray-50">
                    <th className="px-4 py-3 text-left text-xs font-semibold text-gray-500">순번</th>
                    <th className="px-4 py-3 text-left text-xs font-semibold text-gray-500">이름</th>
                    <th className="px-3 py-3 text-left text-xs font-semibold text-gray-500">학교 · 반</th>
                    <th className="px-3 py-3 text-center text-xs font-semibold text-gray-500">상태</th>
                    <th className="px-3 py-3 text-center text-xs font-semibold text-gray-500">액션</th>
                  </tr>
                </thead>
                <tbody>
                  {oralQueue.map((q, idx) => {
                    const isHomework = q.type === 'homework_check'
                    return (
                    <tr key={q.id} className={`border-b border-gray-50 ${q.status === 'called' ? (isHomework ? 'bg-pink-50' : 'bg-purple-50') : ''}`}>
                      <td className="px-4 py-3 font-bold text-gray-500">{idx + 1}</td>
                      <td className="px-4 py-3">
                        <div className="font-medium text-gray-800">{q.students.name}</div>
                        <span className={`text-xs px-1.5 py-0.5 rounded-full font-medium ${isHomework ? 'bg-pink-100 text-pink-600' : 'bg-purple-100 text-purple-600'}`}>
                          {isHomework ? '숙제검사' : '구두'}
                        </span>
                      </td>
                      <td className="px-3 py-3 text-gray-500 text-xs">{q.students.school}<br /><span className="text-blue-400">{q.students.class}</span></td>
                      <td className="px-3 py-3 text-center">
                        {q.status === 'waiting' ? (
                          <span className="text-xs bg-yellow-100 text-yellow-700 px-2 py-0.5 rounded-full">대기 중</span>
                        ) : (
                          <div className="flex flex-col items-center gap-0.5">
                            <span className={`text-xs px-2 py-0.5 rounded-full animate-pulse ${isHomework ? 'bg-pink-100 text-pink-700' : 'bg-purple-100 text-purple-700'}`}>호출됨</span>
                            {q.caller && <span className={`text-xs font-medium ${isHomework ? 'text-pink-500' : 'text-purple-500'}`}>{q.caller}</span>}
                          </div>
                        )}
                      </td>
                      <td className="px-3 py-3 text-center">
                        <div className="flex justify-center gap-1">
                          {q.status === 'waiting' && (
                            <button
                              onClick={() => setCallerModal(q.id)}
                              className={`text-xs text-white px-2.5 py-1 rounded-lg transition-colors ${isHomework ? 'bg-pink-500 hover:bg-pink-600' : 'bg-purple-600 hover:bg-purple-700'}`}
                            >
                              호출
                            </button>
                          )}
                          {q.status === 'called' && (
                            <button
                              onClick={() => openOralDoneModal(q)}
                              className="text-xs bg-green-600 hover:bg-green-700 text-white px-2.5 py-1 rounded-lg transition-colors"
                            >
                              완료
                            </button>
                          )}
                          <button
                            onClick={() => handleRemoveFromQueue(q.id)}
                            className="text-xs text-gray-300 hover:text-red-400 px-1.5 py-1 transition-colors"
                          >
                            ✕
                          </button>
                        </div>
                      </td>
                    </tr>
                  )})}
                </tbody>
              </table>
            )}
          </div>
        )}

        {/* 대기 중 탭 */}
        {tab === 'pending' && (
          <AttendanceTable
            list={pendingList}
            loading={loading}
            emptyText="대기 중인 학생이 없습니다 🎉"
            onApprove={(r) => setApproveModal({ id: r.id, name: r.students.name })}
            onReject={(r) => setRejectModal({ id: r.id, name: r.students.name })}
            onCancelApprove={(r) => setCancelApproveModal({ id: r.id, name: r.students.name })}
            onCheckOut={(r) => handleCheckOut(r.id)}
            onCancelCheckOut={(r) => setCancelCheckoutModal({ id: r.id, name: r.students.name })}
            onMission={handleMission}
            onNameClick={(r) => openHistory(r.students)}
          />
        )}

        {/* 클리닉 탭 */}
        {tab === 'clinic' && (
          <div className="space-y-3">
            {/* 강제하원 요청 */}
            {forceCheckOutList.length > 0 && (
              <div className="bg-orange-50 border border-orange-200 rounded-2xl overflow-hidden">
                <div className="px-4 py-2 bg-orange-100 border-b border-orange-200">
                  <span className="text-xs font-semibold text-orange-700">다음에 올게요 요청 ({forceCheckOutList.length}명)</span>
                </div>
                <table className="w-full text-sm">
                  <tbody>
                    {forceCheckOutList.map(r => (
                      <tr key={r.id} className="border-b border-orange-100 last:border-0">
                        <td className="px-4 py-3 font-medium text-gray-800">{r.students.name}</td>
                        <td className="px-3 py-3 text-xs text-gray-500">{r.students.school} · {r.students.class}</td>
                        <td className="px-3 py-3 text-xs text-blue-600 font-medium">다음 클리닉: {r.next_clinic_date}</td>
                        <td className="px-3 py-3 text-center">
                          <div className="flex gap-2 justify-center">
                            <button
                              onClick={() => handleForceCheckOut(r.id)}
                              className="text-xs bg-orange-500 hover:bg-orange-600 text-white px-3 py-1 rounded-lg transition-colors"
                            >
                              하원 확인
                            </button>
                            <button
                              onClick={() => setCancelNextClinicModal({ id: r.id, name: r.students.name })}
                              className="text-xs border border-gray-300 hover:border-red-400 text-gray-500 hover:text-red-500 px-3 py-1 rounded-lg transition-colors"
                            >
                              요청 취소
                            </button>
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            <AttendanceTable
              list={clinicList}
              loading={loading}
              emptyText="클리닉 학생이 없습니다"
              onApprove={(r) => setApproveModal({ id: r.id, name: r.students.name })}
              onReject={(r) => setRejectModal({ id: r.id, name: r.students.name })}
              onCancelApprove={(r) => setCancelApproveModal({ id: r.id, name: r.students.name })}
              onCheckOut={(r) => setCheckoutConfirmModal({ id: r.id, name: r.students.name })}
              onCancelCheckOut={(r) => setCancelCheckoutModal({ id: r.id, name: r.students.name })}
              onMission={handleMission}
              onAdminForceCheckout={(r) => { setForceCheckoutDate(''); setForceCheckoutModal({ id: r.id, name: r.students.name, record: r }) }}
              onNameClick={(r) => openHistory(r.students)}
              onSetNextClinic={(r) => { setNextClinicDateInput(r.next_clinic_date ?? ''); setNextClinicSetModal({ id: r.id, name: r.students.name, currentDate: r.next_clinic_date ?? null }) }}
              weekValuesMap={weekValuesMap}
            />
          </div>
        )}

        {/* 수업+클리닉 탭 */}
        {tab === 'class_clinic' && (
          <div className="space-y-3">
            {classClinicList.filter(r => !r.checked_out_at).length > 0 && (
              <div className="flex justify-end">
                <button
                  onClick={() => setShowBulkConfirm(true)}
                  className="bg-green-600 hover:bg-green-700 text-white text-sm font-semibold px-4 py-2 rounded-xl transition-colors"
                >
                  일괄 하원 처리 ({classClinicList.filter(r => !r.checked_out_at).length}명)
                </button>
              </div>
            )}
          <AttendanceTable
            list={classClinicList}
            loading={loading}
            emptyText="수업+클리닉 학생이 없습니다"
            onApprove={(r) => setApproveModal({ id: r.id, name: r.students.name })}
            onReject={(r) => setRejectModal({ id: r.id, name: r.students.name })}
            onCancelApprove={(r) => setCancelApproveModal({ id: r.id, name: r.students.name })}
            onCheckOut={(r) => handleCheckOut(r.id)}
            onCancelCheckOut={(r) => setCancelCheckoutModal({ id: r.id, name: r.students.name })}
            onMission={handleMission}
            onNameClick={(r) => openHistory(r.students)}
            weekValuesMap={weekValuesMap}
          />
          </div>
        )}

        {/* 거절 탭 */}
        {tab === 'rejected' && (
          <div className="bg-white rounded-2xl border border-gray-100 shadow-sm overflow-hidden">
            {rejectedList.length === 0 ? (
              <div className="py-16 text-center text-gray-400 text-sm">거절된 학생이 없습니다</div>
            ) : (
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-gray-100 bg-gray-50">
                    <th className="px-4 py-3 text-left text-xs font-semibold text-gray-500">이름</th>
                    <th className="px-3 py-3 text-left text-xs font-semibold text-gray-500">학교 · 반</th>
                    <th className="px-3 py-3 text-left text-xs font-semibold text-gray-500">사유</th>
                    <th className="px-3 py-3 text-center text-xs font-semibold text-gray-500">시간</th>
                    <th className="px-3 py-3 text-center text-xs font-semibold text-gray-500">재시도</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-50">
                  {rejectedList.map(r => (
                    <tr key={r.id}>
                      <td className="px-4 py-3 font-medium text-gray-800">{r.students.name}</td>
                      <td className="px-3 py-3 text-xs text-gray-500">{r.students.school}<br /><span className="text-blue-400">{r.students.class}</span></td>
                      <td className="px-3 py-3 text-xs text-red-500">{r.reject_reason || '-'}</td>
                      <td className="px-3 py-3 text-center text-xs text-gray-400">
                        {r.checked_in_at ? new Date(r.checked_in_at).toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit' }) : '-'}
                      </td>
                      <td className="px-3 py-3 text-center">
                        <button
                          onClick={() => handleAllowRetry(r.id)}
                          className="text-xs text-blue-500 hover:text-blue-700 border border-blue-200 hover:border-blue-400 px-2.5 py-1 rounded-lg transition-colors"
                        >
                          재시도 허용
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        )}
      </div>

      {/* 승인 확인 모달 */}
      {approveModal && (
        <div
          className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 p-4"
          onKeyDown={(e) => { if (e.key === 'Enter') handleApprove() }}
          tabIndex={-1}
          ref={(el) => el?.focus()}
        >
          <div className="bg-white rounded-2xl w-full max-w-sm p-5 shadow-xl">
            <h3 className="font-semibold text-gray-800 mb-1">{approveModal.name} 학생 승인</h3>
            <p className="text-sm text-gray-500 mb-5">정말 학생이 등원하였습니까?</p>
            <div className="flex gap-2">
              <button
                onClick={() => setApproveModal(null)}
                className="flex-1 py-2.5 rounded-xl border border-gray-200 text-sm text-gray-600 font-medium"
              >
                취소
              </button>
              <button
                onClick={handleApprove}
                className="flex-1 py-2.5 rounded-xl bg-green-500 hover:bg-green-600 text-white text-sm font-semibold transition-colors"
              >
                승인
              </button>
            </div>
          </div>
        </div>
      )}

      {/* 하원 확인 모달 */}
      {checkoutConfirmModal && (
        <div
          className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 p-4"
          onKeyDown={(e) => { if (e.key === 'Enter') { handleCheckOut(checkoutConfirmModal.id); setCheckoutConfirmModal(null) } }}
          tabIndex={-1}
          ref={(el) => el?.focus()}
        >
          <div className="bg-white rounded-2xl w-full max-w-xs p-6 shadow-xl">
            <h3 className="font-semibold text-gray-800 mb-2 text-center text-base">하원 처리</h3>
            <p className="text-sm text-gray-500 text-center mb-1">
              <span className="font-semibold text-gray-700">{checkoutConfirmModal.name}</span> 학생을
            </p>
            <p className="text-sm text-gray-500 text-center mb-6">하원 처리하시겠습니까?</p>
            <div className="flex gap-2">
              <button
                onClick={() => setCheckoutConfirmModal(null)}
                className="flex-1 py-2.5 rounded-xl border border-gray-200 text-sm text-gray-600 hover:bg-gray-50 transition-colors"
              >
                취소
              </button>
              <button
                onClick={() => { handleCheckOut(checkoutConfirmModal.id); setCheckoutConfirmModal(null) }}
                className="flex-1 py-2.5 rounded-xl bg-indigo-500 hover:bg-indigo-600 text-white text-sm font-semibold transition-colors"
              >
                확인
              </button>
            </div>
          </div>
        </div>
      )}

      {/* 다음에 올게요 요청 취소 모달 */}
      {cancelNextClinicModal && (
        <div
          className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 p-4"
          onKeyDown={(e) => { if (e.key === 'Enter') { handleCancelNextClinic(cancelNextClinicModal.id); setCancelNextClinicModal(null) } }}
          tabIndex={-1}
          ref={(el) => el?.focus()}
        >
          <div className="bg-white rounded-2xl w-full max-w-xs p-6 shadow-xl">
            <h3 className="font-semibold text-gray-800 mb-2 text-center text-base">요청 취소</h3>
            <p className="text-sm text-gray-500 text-center mb-1">
              <span className="font-semibold text-gray-700">{cancelNextClinicModal.name}</span> 학생의
            </p>
            <p className="text-sm text-gray-500 text-center mb-6">다음에 올게요 요청을 취소하시겠습니까?</p>
            <div className="flex gap-2">
              <button
                onClick={() => setCancelNextClinicModal(null)}
                className="flex-1 py-2.5 rounded-xl border border-gray-200 text-sm text-gray-600 hover:bg-gray-50 transition-colors"
              >
                취소
              </button>
              <button
                onClick={() => { handleCancelNextClinic(cancelNextClinicModal.id); setCancelNextClinicModal(null) }}
                className="flex-1 py-2.5 rounded-xl bg-red-500 hover:bg-red-600 text-white text-sm font-semibold transition-colors"
              >
                확인
              </button>
            </div>
          </div>
        </div>
      )}

      {/* 하원 취소 확인 모달 */}
      {cancelCheckoutModal && (
        <div
          className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 p-4"
          onKeyDown={(e) => { if (e.key === 'Enter') { handleCancelCheckOut(cancelCheckoutModal.id); setCancelCheckoutModal(null) } }}
          tabIndex={-1}
          ref={(el) => el?.focus()}
        >
          <div className="bg-white rounded-2xl w-full max-w-xs p-6 shadow-xl">
            <h3 className="font-semibold text-gray-800 mb-2 text-center text-base">하원 취소</h3>
            <p className="text-sm text-gray-500 text-center mb-1">
              <span className="font-semibold text-gray-700">{cancelCheckoutModal.name}</span> 학생의
            </p>
            <p className="text-sm text-gray-500 text-center mb-6">하원을 취소하시겠습니까?</p>
            <div className="flex gap-2">
              <button
                onClick={() => setCancelCheckoutModal(null)}
                className="flex-1 py-2.5 rounded-xl border border-gray-200 text-sm text-gray-600 hover:bg-gray-50 transition-colors"
              >
                취소
              </button>
              <button
                onClick={() => { handleCancelCheckOut(cancelCheckoutModal.id); setCancelCheckoutModal(null) }}
                className="flex-1 py-2.5 rounded-xl bg-red-500 hover:bg-red-600 text-white text-sm font-semibold transition-colors"
              >
                확인
              </button>
            </div>
          </div>
        </div>
      )}

      {/* 재등원 날짜 설정 모달 */}
      {nextClinicSetModal && (
        <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 p-4">
          <div className="bg-white rounded-2xl w-full max-w-xs p-6 shadow-xl">
            <h3 className="font-semibold text-gray-800 mb-1 text-center">{nextClinicSetModal.name} 학생</h3>
            <p className="text-sm text-gray-500 text-center mb-4">재등원 예정일을 설정하세요</p>
            <input
              type="date"
              value={nextClinicDateInput}
              onChange={(e) => setNextClinicDateInput(e.target.value)}
              className="w-full border border-gray-200 rounded-xl px-3 py-2.5 text-sm focus:outline-none focus:border-blue-400 mb-4"
            />
            <div className="flex gap-2">
              <button
                onClick={() => { setNextClinicSetModal(null); setNextClinicDateInput('') }}
                className="flex-1 py-2.5 rounded-xl border border-gray-200 text-sm text-gray-600 hover:bg-gray-50 transition-colors"
              >
                취소
              </button>
              <button
                onClick={() => handleSetNextClinicDate(nextClinicSetModal.id, nextClinicDateInput)}
                disabled={!nextClinicDateInput}
                className={`flex-1 py-2.5 rounded-xl text-sm font-semibold transition-colors ${
                  nextClinicDateInput
                    ? 'bg-blue-500 hover:bg-blue-600 text-white'
                    : 'bg-gray-100 text-gray-300 cursor-not-allowed'
                }`}
              >
                저장
              </button>
            </div>
          </div>
        </div>
      )}

      {/* 강제하원 모달 */}
      {forceCheckoutModal && (
        <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 p-4">
          <div className="bg-white rounded-2xl w-full max-w-xs shadow-xl">
            <div className="px-6 py-4 border-b border-gray-100 flex items-center justify-between">
              <h3 className="font-bold text-gray-800">강제 하원</h3>
              <button onClick={() => setForceCheckoutModal(null)} className="text-gray-400 hover:text-gray-600 text-xl">✕</button>
            </div>
            <div className="px-6 py-5 space-y-4">
              <p className="text-sm text-gray-600">
                <span className="font-semibold text-gray-800">{forceCheckoutModal.name}</span> 학생을 강제 하원 처리합니다.
              </p>
              <div className="bg-orange-50 rounded-xl p-3 text-xs text-orange-700 space-y-0.5">
                <p>• 단어 / 클리닉 점수 미입력 → <span className="font-semibold">00</span> 자동 입력</p>
                <p>• 구두 / 과제 미입력 → <span className="font-semibold">Delay</span> 자동 설정</p>
              </div>
              <div>
                <label className="block text-xs font-medium text-gray-500 mb-1">다음 클리닉 날짜 <span className="text-red-400">*</span></label>
                <input
                  type="date"
                  value={forceCheckoutDate}
                  onChange={(e) => setForceCheckoutDate(e.target.value)}
                  className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-red-400"
                />
              </div>
              <div className="flex gap-2 pt-1">
                <button
                  onClick={() => setForceCheckoutModal(null)}
                  className="flex-1 py-2 rounded-xl border border-gray-200 text-sm text-gray-600 hover:bg-gray-50 transition-colors"
                >
                  취소
                </button>
                <button
                  onClick={handleAdminForceCheckout}
                  disabled={!forceCheckoutDate}
                  className={`flex-1 py-2 rounded-xl text-sm font-semibold transition-colors ${
                    forceCheckoutDate
                      ? 'bg-red-500 hover:bg-red-600 text-white'
                      : 'bg-gray-100 text-gray-300 cursor-not-allowed'
                  }`}
                >
                  강제 하원
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* 승인 취소 확인 모달 */}
      {cancelApproveModal && (
        <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 p-4">
          <div className="bg-white rounded-2xl w-full max-w-xs p-6 shadow-xl">
            <h3 className="font-semibold text-gray-800 mb-2 text-center text-base">승인 취소</h3>
            <p className="text-sm text-gray-500 text-center mb-1">
              <span className="font-semibold text-gray-700">{cancelApproveModal.name}</span> 학생의
            </p>
            <p className="text-sm text-gray-500 text-center mb-6">승인을 취소하시겠습니까?</p>
            <div className="flex gap-2">
              <button
                onClick={() => setCancelApproveModal(null)}
                className="flex-1 py-2.5 rounded-xl border border-gray-200 text-sm text-gray-600 font-medium hover:bg-gray-50 transition-colors"
              >
                취소
              </button>
              <button
                onClick={() => handleCancelApprove(cancelApproveModal.id)}
                className="flex-1 py-2.5 rounded-xl bg-yellow-500 hover:bg-yellow-600 text-white text-sm font-semibold transition-colors"
              >
                승인 취소
              </button>
            </div>
          </div>
        </div>
      )}

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

      {/* 일괄 하원 확인 모달 */}
      {showBulkConfirm && (
        <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 p-4">
          <div className="bg-white rounded-2xl w-full max-w-xs p-6 shadow-xl">
            <h3 className="font-semibold text-gray-800 mb-2 text-center text-base">일괄 하원 처리</h3>
            <p className="text-sm text-gray-500 text-center mb-6">정말 일괄처리 하시겠습니까?</p>
            <div className="flex gap-2">
              <button
                onClick={() => setShowBulkConfirm(false)}
                className="flex-1 py-2.5 rounded-xl border border-gray-200 text-sm text-gray-500 hover:bg-gray-50 transition-colors"
              >
                취소
              </button>
              <button
                onClick={() => { setShowBulkConfirm(false); handleBulkCheckOut() }}
                className="flex-1 py-2.5 rounded-xl bg-blue-500 hover:bg-blue-600 text-white font-semibold text-sm transition-colors"
              >
                확인
              </button>
            </div>
          </div>
        </div>
      )}

      {/* 조교 선택 모달 */}
      {callerModal && (
        <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 p-4">
          <div className="bg-white rounded-2xl w-full max-w-xs p-5 shadow-xl">
            <h3 className="font-semibold text-gray-800 mb-4 text-center">호출하는 조교 선택</h3>
            <div className="flex flex-col gap-2">
              {CALLERS.map((t) => (
                <button
                  key={t}
                  onClick={() => handleCallStudent(callerModal, t)}
                  className="py-3 rounded-xl bg-purple-50 hover:bg-purple-100 text-purple-700 font-semibold text-sm transition-colors"
                >
                  {t}
                </button>
              ))}
            </div>
            <button
              onClick={() => setCallerModal(null)}
              className="w-full mt-3 py-2.5 rounded-xl border border-gray-200 text-sm text-gray-500 hover:bg-gray-50 transition-colors"
            >
              취소
            </button>
          </div>
        </div>
      )}

      {/* 구두 완료 성적 입력 모달 */}
      {oralDoneModal && (
        <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 p-4">
          <div className="bg-white rounded-2xl w-full max-w-sm shadow-xl">
            <div className="px-6 py-4 border-b border-gray-100 flex items-center justify-between">
              <div>
                <h3 className="font-bold text-gray-800">{oralDoneModal.studentName} 학생</h3>
                <p className="text-xs text-gray-400 mt-0.5">구두 완료 처리</p>
              </div>
              <button onClick={() => setOralDoneModal(null)} className="text-gray-400 hover:text-gray-600 text-xl">✕</button>
            </div>
            <div className="px-6 py-5 space-y-4">
              {/* 점수 */}
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs font-medium text-gray-500 mb-1">단어 점수</label>
                  <input
                    value={oralDoneForm.wordScore}
                    onChange={(e) => setOralDoneForm(f => ({ ...f, wordScore: e.target.value }))}
                    placeholder="예: 85"
                    className="w-full border border-gray-200 rounded-xl px-3 py-2 text-sm text-center focus:outline-none focus:border-blue-400"
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium text-gray-500 mb-1">클리닉 점수</label>
                  <input
                    value={oralDoneForm.clinicScore}
                    onChange={(e) => setOralDoneForm(f => ({ ...f, clinicScore: e.target.value }))}
                    placeholder="예: 90"
                    className="w-full border border-gray-200 rounded-xl px-3 py-2 text-sm text-center focus:outline-none focus:border-blue-400"
                  />
                </div>
              </div>
              {/* 구두 */}
              <div>
                <label className="block text-xs font-medium text-gray-500 mb-1.5">구두</label>
                <div className="flex flex-wrap gap-2">
                  {([
                    { v: 'pass' as MissionStatus, label: 'Pass', active: 'bg-green-500 text-white' },
                    { v: 'word_pass' as MissionStatus, label: '단어Pass', active: 'bg-orange-400 text-white' },
                    { v: 'sentence_pass' as MissionStatus, label: '문장Pass', active: 'bg-orange-400 text-white' },
                    { v: 'exempt' as MissionStatus, label: '면제', active: 'bg-teal-500 text-white' },
                    { v: 'fail' as MissionStatus, label: 'Fail', active: 'bg-red-400 text-white' },
                    { v: 'delay' as MissionStatus, label: 'Delay', active: 'bg-yellow-400 text-white' },
                  ]).map(({ v, label, active }) => (
                    <button
                      key={String(v)}
                      onClick={() => setOralDoneForm(f => ({ ...f, oralStatus: f.oralStatus === v ? null : v }))}
                      className={`flex-1 min-w-[60px] py-2 rounded-xl text-xs font-semibold transition-colors ${
                        oralDoneForm.oralStatus === v ? active : 'bg-gray-100 text-gray-500 hover:bg-gray-200'
                      }`}
                    >
                      {label}
                    </button>
                  ))}
                </div>
              </div>
              {/* 과제 */}
              <div>
                <label className="block text-xs font-medium text-gray-500 mb-1.5">과제</label>
                <div className="flex flex-wrap gap-2">
                  {([
                    { v: 'pass' as MissionStatus, label: 'Pass', active: 'bg-green-500 text-white' },
                    { v: 'partial_pass' as MissionStatus, label: '일부Pass', active: 'bg-orange-400 text-white' },
                    { v: 'fail' as MissionStatus, label: 'Fail', active: 'bg-red-400 text-white' },
                    { v: 'delay' as MissionStatus, label: 'Delay', active: 'bg-yellow-400 text-white' },
                  ]).map(({ v, label, active }) => (
                    <button
                      key={String(v)}
                      onClick={() => setOralDoneForm(f => ({ ...f, homework: f.homework === v ? null : v }))}
                      className={`flex-1 min-w-[60px] py-2 rounded-xl text-xs font-semibold transition-colors ${
                        oralDoneForm.homework === v ? active : 'bg-gray-100 text-gray-500 hover:bg-gray-200'
                      }`}
                    >
                      {label}
                    </button>
                  ))}
                </div>
              </div>
              {/* 기타 */}
              <div className="grid grid-cols-3 gap-2">
                <div>
                  <label className="block text-xs font-medium text-blue-500 mb-1">구두 메모</label>
                  <textarea
                    value={oralDoneForm.oralMemo}
                    onChange={(e) => setOralDoneForm(f => ({ ...f, oralMemo: e.target.value }))}
                    placeholder="구두 관련..."
                    rows={2}
                    className="w-full border border-blue-200 rounded-xl px-3 py-2 text-sm resize-none focus:outline-none focus:border-blue-400"
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium text-purple-500 mb-1">과제 메모</label>
                  <textarea
                    value={oralDoneForm.homeworkMemo}
                    onChange={(e) => setOralDoneForm(f => ({ ...f, homeworkMemo: e.target.value }))}
                    placeholder="과제 관련..."
                    rows={2}
                    className="w-full border border-purple-200 rounded-xl px-3 py-2 text-sm resize-none focus:outline-none focus:border-purple-400"
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium text-gray-400 mb-1">기타 메모</label>
                  <textarea
                    value={oralDoneForm.notes}
                    onChange={(e) => setOralDoneForm(f => ({ ...f, notes: e.target.value }))}
                    placeholder="기타..."
                    rows={2}
                    className="w-full border border-gray-200 rounded-xl px-3 py-2 text-sm resize-none focus:outline-none focus:border-gray-400"
                  />
                </div>
              </div>
            </div>
            <div className="px-6 pb-5 flex gap-2">
              <button
                onClick={() => setOralDoneModal(null)}
                className="flex-1 py-2.5 rounded-xl border border-gray-200 text-sm text-gray-600 hover:bg-gray-50 transition-colors"
              >
                취소
              </button>
              <button
                onClick={handleOralDoneSubmit}
                className="flex-1 py-2.5 rounded-xl bg-green-500 hover:bg-green-600 text-white text-sm font-semibold transition-colors"
              >
                저장 & 완료
              </button>
            </div>
          </div>
        </div>
      )}

      {/* 학생 히스토리 모달 */}
      {historyTarget && (
        <StudentHistoryModal
          student={historyTarget}
          records={historyRecords}
          onClose={() => setHistoryTarget(null)}
        />
      )}
    </div>
  )
}

// ─── 서브 컴포넌트 ────────────────────────────────────────

function AttendanceTable({
  list, loading, emptyText, onApprove, onReject, onCancelApprove, onAllowRetry, onCheckOut, onCancelCheckOut, onMission, onAdminForceCheckout, onNameClick, onSetNextClinic, weekValuesMap,
}: {
  list: AttendanceWithStudent[]
  loading: boolean
  emptyText: string
  onApprove: (r: AttendanceWithStudent) => void
  onReject: (r: AttendanceWithStudent) => void
  onCancelApprove: (r: AttendanceWithStudent) => void
  onAllowRetry?: (r: AttendanceWithStudent) => void
  onCheckOut: (r: AttendanceWithStudent) => void
  onCancelCheckOut: (r: AttendanceWithStudent) => void
  onMission: (id: string, field: 'word_status' | 'oral_status' | 'homework', value: MissionStatus) => void
  onAdminForceCheckout?: (r: AttendanceWithStudent) => void
  onNameClick?: (r: AttendanceWithStudent) => void
  onSetNextClinic?: (r: AttendanceWithStudent) => void
  weekValuesMap?: Map<string, Record<string, string | null>>
}) {
  return (
    <div className="bg-white rounded-2xl border border-gray-100 shadow-sm overflow-hidden">
      {loading ? (
        <div className="py-16 text-center text-gray-400 text-sm">불러오는 중...</div>
      ) : list.length === 0 ? (
        <div className="py-16 text-center text-gray-400 text-sm">{emptyText}</div>
      ) : (
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-gray-100 bg-gray-50">
              <th className="px-4 py-3 text-left text-xs font-semibold text-gray-500">이름</th>
              <th className="px-3 py-3 text-left text-xs font-semibold text-gray-500">학교 · 반</th>
              <th className="px-3 py-3 text-center text-xs font-semibold text-gray-500">등원</th>
              <th className="px-3 py-3 text-center text-xs font-semibold text-gray-500">단어</th>
              <th className="px-3 py-3 text-center text-xs font-semibold text-gray-500">클리닉</th>
              <th className="px-3 py-3 text-center text-xs font-semibold text-gray-500">구두</th>
              <th className="px-3 py-3 text-center text-xs font-semibold text-gray-500">과제</th>
              <th className="px-3 py-3 text-left text-xs font-semibold text-gray-500">기타</th>
              <th className="px-3 py-3 text-center text-xs font-semibold text-gray-500">하원</th>
              <th className="px-3 py-3 text-center text-xs font-semibold text-gray-500">액션</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-50">
            {list.map((record) => (
              <AttendanceRow
                key={record.id}
                record={record}
                onApprove={() => onApprove(record)}
                onReject={() => onReject(record)}
                onCancelApprove={() => onCancelApprove(record)}
                onAllowRetry={onAllowRetry ? () => onAllowRetry(record) : undefined}
                onCheckOut={() => onCheckOut(record)}
                onCancelCheckOut={() => onCancelCheckOut(record)}
                onMission={onMission}
                onAdminForceCheckout={onAdminForceCheckout ? () => onAdminForceCheckout(record) : undefined}
                onNameClick={onNameClick ? () => onNameClick(record) : undefined}
                onSetNextClinic={onSetNextClinic ? () => onSetNextClinic(record) : undefined}
                inheritedValues={weekValuesMap?.get(record.student_id)}
              />
            ))}
          </tbody>
        </table>
      )}
    </div>
  )
}

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
  onAdminForceCheckout,
  onNameClick,
  onSetNextClinic,
  inheritedValues,
}: {
  record: AttendanceWithStudent
  onApprove: () => void
  onReject: () => void
  onCancelApprove: () => void
  onAllowRetry?: () => void
  onCheckOut: () => void
  onCancelCheckOut: () => void
  onMission: (id: string, field: 'word_status' | 'oral_status' | 'homework', value: MissionStatus) => void
  onAdminForceCheckout?: () => void
  onNameClick?: () => void
  onSetNextClinic?: () => void
  inheritedValues?: Record<string, string | null>
}) {
  const [notes, setNotes] = useState(record.notes ?? '')
  const [oralMemo, setOralMemo] = useState(record.oral_memo ?? '')
  const [homeworkMemo, setHomeworkMemo] = useState(record.homework_memo ?? '')
  const [wordScore, setWordScore] = useState(record.word_score ?? '')
  const [clinicScore, setClinicScore] = useState(record.clinic_score ?? '')
  const notesTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const [showNotesModal, setShowNotesModal] = useState(false)
  const [modalNotes, setModalNotes] = useState('')
  const [modalOralMemo, setModalOralMemo] = useState('')
  const [modalHomeworkMemo, setModalHomeworkMemo] = useState('')
  const [confirmEdit, setConfirmEdit] = useState<{ field: string; editValue: string } | null>(null)
  const wordInputRef = useRef<HTMLInputElement>(null)
  const clinicInputRef = useRef<HTMLInputElement>(null)

  const validStatuses = ['pass', 'fail', 'delay', 'word_pass', 'sentence_pass', 'partial_pass', 'exempt']
  const homeworkVal = validStatuses.includes(record.homework as string) ? record.homework as MissionStatus : null
  const oralVal = validStatuses.includes(record.oral_status as string) ? record.oral_status as MissionStatus : null

  // 이번 주 상속값 (오늘 값 없을 때만, 로컬 state도 체크)
  const iWordInherited = !record.word_score?.trim() && wordScore === '' && !!inheritedValues?.word_score
  const iClinicInherited = !record.clinic_score?.trim() && clinicScore === '' && !!inheritedValues?.clinic_score
  const iOralInherited = !oralVal && !!inheritedValues?.oral_status
  const iHomeworkInherited = !homeworkVal && !!inheritedValues?.homework
  const wordDisplay = wordScore !== '' ? wordScore : (inheritedValues?.word_score ?? '')
  const clinicDisplay = clinicScore !== '' ? clinicScore : (inheritedValues?.clinic_score ?? '')
  const oralDisplay = oralVal ?? (inheritedValues?.oral_status as MissionStatus ?? null)
  const homeworkDisplay = homeworkVal ?? (inheritedValues?.homework as MissionStatus ?? null)

  const allDone =
    wordDisplay.trim() !== '' &&
    clinicDisplay.trim() !== '' &&
    validStatuses.includes((oralDisplay ?? '') as string) &&
    validStatuses.includes((homeworkDisplay ?? '') as string)

  async function saveScore(field: 'word_score' | 'clinic_score', value: string) {
    await supabase.from('attendances').update({ [field]: value || null }).eq('id', record.id)
  }

  async function handleCheckOutClick() {
    // 상속값 중 오늘 미저장 값 자동 저장 후 하원 처리
    const updates: Record<string, unknown> = {}
    if (iWordInherited && inheritedValues?.word_score) updates.word_score = inheritedValues.word_score
    if (iClinicInherited && inheritedValues?.clinic_score) updates.clinic_score = inheritedValues.clinic_score
    if (iOralInherited && inheritedValues?.oral_status) updates.oral_status = inheritedValues.oral_status
    if (iHomeworkInherited && inheritedValues?.homework) updates.homework = inheritedValues.homework
    if (Object.keys(updates).length > 0) {
      await supabase.from('attendances').update(updates).eq('id', record.id)
    }
    onCheckOut()
  }

  async function handleConfirmEdit() {
    if (!confirmEdit) return
    const { field, editValue } = confirmEdit
    if (field === 'word_score') {
      setWordScore(editValue)
      await saveScore('word_score', editValue)
    } else if (field === 'clinic_score') {
      setClinicScore(editValue)
      await saveScore('clinic_score', editValue)
    } else if (field === 'oral_status') {
      onMission(record.id, 'oral_status', editValue as MissionStatus)
    } else if (field === 'homework') {
      onMission(record.id, 'homework', editValue as MissionStatus)
    }
    setConfirmEdit(null)
  }

  function formatTimeWithDay(isoStr: string) {
    const d = new Date(isoStr)
    const day = d.toLocaleDateString('ko-KR', { weekday: 'narrow' })
    const time = d.toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit' })
    return `${day} ${time}`
  }

  const checkinTime = record.checked_in_at ? formatTimeWithDay(record.checked_in_at) : '-'
  const checkoutTime = record.checked_out_at ? formatTimeWithDay(record.checked_out_at) : null
  const recheckInTime = record.rechecked_in_at ? formatTimeWithDay(record.rechecked_in_at) : null

  const rowBg: Record<string, string> = {
    pending: '',
    approved: '',
    rejected: 'opacity-60',
  }

  async function saveNotes(n: string, om: string, hm: string) {
    await supabase.from('attendances').update({
      notes: n || null,
      oral_memo: om || null,
      homework_memo: hm || null,
    }).eq('id', record.id)
  }

  function openNotesModal() {
    setModalNotes(notes)
    setModalOralMemo(oralMemo)
    setModalHomeworkMemo(homeworkMemo)
    setShowNotesModal(true)
  }

  async function handleSaveModal() {
    setNotes(modalNotes)
    setOralMemo(modalOralMemo)
    setHomeworkMemo(modalHomeworkMemo)
    if (notesTimerRef.current) clearTimeout(notesTimerRef.current)
    await saveNotes(modalNotes, modalOralMemo, modalHomeworkMemo)
    setShowNotesModal(false)
  }

  function scoreStyle(val: string) {
    const v = val.trim()
    if (!v) return 'border-gray-200'
    if (v === '00' || v === '--' || v === '-') return 'border-orange-300 bg-orange-50 text-orange-600'
    if (v === '.' || v === '..') return 'border-teal-300 bg-teal-50 text-teal-600'
    return 'border-green-300 bg-green-50'
  }

  return (
    <tr className={`hover:bg-blue-50/30 transition-colors ${rowBg[record.status]}`}>
      {/* 이름 */}
      <td className="px-4 py-3">
        <div
          className={`font-medium text-gray-900 ${onNameClick ? 'cursor-pointer hover:text-blue-600 transition-colors' : ''}`}
          onClick={onNameClick}
        >
          {record.students.name}
        </div>
        {record.students.oral_type && <div className="text-xs text-blue-500">{record.students.oral_type}</div>}
      </td>
      {/* 학교·반 */}
      <td className="px-3 py-3">
        <div className="text-xs text-gray-700">{record.students.school}</div>
        <div className="text-xs text-gray-400">
          {record.students.class}
          {record.students.clinic_day && <span className="ml-1 text-blue-400">{record.students.clinic_day}요일</span>}
        </div>
      </td>
      {/* 등원 */}
      <td className="px-3 py-3 text-center text-xs text-gray-600 whitespace-nowrap">
        <div>{checkinTime}</div>
        {recheckInTime && (
          <div className="text-blue-500 font-medium mt-0.5">재등원 {recheckInTime}</div>
        )}
      </td>
      {/* 단어 점수 */}
      <td className="px-3 py-3 text-center">
        {record.status === 'approved'
          ? <input
              ref={wordInputRef}
              value={wordDisplay}
              onChange={(e) => setWordScore(e.target.value)}
              onFocus={() => { if (iWordInherited) { wordInputRef.current?.blur(); setConfirmEdit({ field: 'word_score', editValue: inheritedValues?.word_score ?? '' }) } }}
              onBlur={() => saveScore('word_score', wordScore)}
              placeholder="단어"
              className={`w-16 text-center text-xs border rounded-lg px-2 py-1.5 focus:outline-none focus:border-blue-400 ${iWordInherited ? 'border-dashed border-red-400 bg-red-50 text-red-500' : scoreStyle(wordScore)}`}
            />
          : <span className="text-gray-200 text-xs">—</span>}
      </td>
      {/* 클리닉 점수 */}
      <td className="px-3 py-3 text-center">
        {record.status === 'approved'
          ? <input
              ref={clinicInputRef}
              value={clinicDisplay}
              onChange={(e) => setClinicScore(e.target.value)}
              onFocus={() => { if (iClinicInherited) { clinicInputRef.current?.blur(); setConfirmEdit({ field: 'clinic_score', editValue: inheritedValues?.clinic_score ?? '' }) } }}
              onBlur={() => saveScore('clinic_score', clinicScore)}
              placeholder="클리닉"
              className={`w-16 text-center text-xs border rounded-lg px-2 py-1.5 focus:outline-none focus:border-blue-400 ${iClinicInherited ? 'border-dashed border-red-400 bg-red-50 text-red-500' : scoreStyle(clinicScore)}`}
            />
          : <span className="text-gray-200 text-xs">—</span>}
      </td>
      {/* 구두 */}
      <td className="px-3 py-3 text-center">
        {record.status === 'approved'
          ? <div className={iOralInherited ? 'ring-2 ring-dashed ring-red-400 rounded-lg inline-block' : 'inline-block'}>
              <MissionCycleButton value={oralDisplay} onChange={(v) => {
                if (iOralInherited) { setConfirmEdit({ field: 'oral_status', editValue: v as string }) }
                else { onMission(record.id, 'oral_status', v) }
              }} />
            </div>
          : <span className="text-gray-200 text-xs">—</span>}
      </td>
      {/* 과제 */}
      <td className="px-3 py-3 text-center">
        {record.status === 'approved'
          ? <div className={iHomeworkInherited ? 'ring-2 ring-dashed ring-red-400 rounded-lg inline-block' : 'inline-block'}>
              <MissionCycleButton value={homeworkDisplay} onChange={(v) => {
                if (iHomeworkInherited) { setConfirmEdit({ field: 'homework', editValue: v as string }) }
                else { onMission(record.id, 'homework', v) }
              }} variant="homework" />
            </div>
          : <span className="text-gray-200 text-xs">—</span>}
      </td>
      {/* 기타 */}
      <td className="px-3 py-3">
        {record.status === 'approved' && (
          <button
            onClick={openNotesModal}
            className="flex items-center gap-1 max-w-[100px] group"
          >
            {(oralMemo || homeworkMemo || notes) ? (
              <span className="text-xs text-gray-600 truncate max-w-[70px]">{oralMemo || homeworkMemo || notes}</span>
            ) : (
              <span className="text-xs text-gray-300">메모...</span>
            )}
            <span className={`text-xs flex-shrink-0 ${(oralMemo || homeworkMemo || notes) ? 'text-blue-400 group-hover:text-blue-600' : 'text-gray-300 group-hover:text-gray-500'}`}>···</span>
          </button>
        )}
        {showNotesModal && createPortal(
          <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 p-4">
            <div className="bg-white rounded-2xl w-full max-w-2xl p-6 shadow-xl">
              <h3 className="font-semibold text-gray-800 mb-1">{record.students.name} 학생</h3>
              <p className="text-xs text-gray-400 mb-4">메모</p>
              <div className="grid grid-cols-3 gap-3 mb-4">
                <div>
                  <label className="block text-xs font-medium text-blue-500 mb-1.5">구두 메모</label>
                  <textarea
                    value={modalOralMemo}
                    onChange={(e) => setModalOralMemo(e.target.value)}
                    autoFocus
                    rows={5}
                    className="w-full border border-blue-200 rounded-xl px-3 py-2.5 text-sm focus:outline-none focus:border-blue-400 resize-none"
                    placeholder="구두 관련 메모..."
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium text-purple-500 mb-1.5">과제 메모</label>
                  <textarea
                    value={modalHomeworkMemo}
                    onChange={(e) => setModalHomeworkMemo(e.target.value)}
                    rows={5}
                    className="w-full border border-purple-200 rounded-xl px-3 py-2.5 text-sm focus:outline-none focus:border-purple-400 resize-none"
                    placeholder="과제 관련 메모..."
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium text-gray-400 mb-1.5">기타 메모</label>
                  <textarea
                    value={modalNotes}
                    onChange={(e) => setModalNotes(e.target.value)}
                    rows={5}
                    className="w-full border border-gray-200 rounded-xl px-3 py-2.5 text-sm focus:outline-none focus:border-gray-400 resize-none"
                    placeholder="기타 메모..."
                  />
                </div>
              </div>
              <div className="flex gap-2">
                <button
                  onClick={() => setShowNotesModal(false)}
                  className="flex-1 py-2.5 rounded-xl border border-gray-200 text-sm text-gray-600 hover:bg-gray-50 transition-colors"
                >
                  취소
                </button>
                <button
                  onClick={handleSaveModal}
                  className="flex-1 py-2.5 rounded-xl bg-blue-500 hover:bg-blue-600 text-white text-sm font-semibold transition-colors"
                >
                  저장
                </button>
              </div>
            </div>
          </div>,
          document.body
        )}
        {confirmEdit && createPortal(
          <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 p-4" onClick={() => setConfirmEdit(null)}>
            <div className="bg-white rounded-2xl w-full max-w-sm p-6 shadow-xl" onClick={(e) => e.stopPropagation()}>
              <p className="font-semibold text-gray-800 mb-1">상속값 수정</p>
              <p className="text-xs text-gray-400 mb-4">이번 주 다른 날 기록에서 가져온 값입니다.<br />수정하면 오늘 기록에 저장됩니다.</p>
              <div className="mb-5">
                <label className="block text-xs font-medium text-gray-500 mb-1.5">
                  {{ word_score: '단어 점수', clinic_score: '클리닉 점수', oral_status: '구두', homework: '과제' }[confirmEdit.field]}
                </label>
                {(confirmEdit.field === 'word_score' || confirmEdit.field === 'clinic_score') ? (
                  <input
                    autoFocus
                    value={confirmEdit.editValue}
                    onChange={(e) => setConfirmEdit(prev => prev ? { ...prev, editValue: e.target.value } : null)}
                    className="w-full border border-gray-200 rounded-xl px-3 py-2 text-sm focus:outline-none focus:border-blue-400"
                  />
                ) : (
                  <select
                    autoFocus
                    value={confirmEdit.editValue}
                    onChange={(e) => setConfirmEdit(prev => prev ? { ...prev, editValue: e.target.value } : null)}
                    className="w-full border border-gray-200 rounded-xl px-3 py-2 text-sm focus:outline-none focus:border-blue-400"
                  >
                    {confirmEdit.field === 'oral_status'
                      ? [['pass','Pass'],['fail','Fail'],['delay','Delay'],['word_pass','단어Pass'],['sentence_pass','문장Pass'],['exempt','면제']].map(([v,l]) => <option key={v} value={v}>{l}</option>)
                      : [['pass','Pass'],['fail','Fail'],['delay','Delay'],['partial_pass','일부Pass']].map(([v,l]) => <option key={v} value={v}>{l}</option>)
                    }
                  </select>
                )}
              </div>
              <div className="flex gap-2">
                <button
                  onClick={() => setConfirmEdit(null)}
                  className="flex-1 py-2.5 rounded-xl border border-gray-200 text-sm text-gray-600 hover:bg-gray-50 transition-colors"
                >
                  취소
                </button>
                <button
                  onClick={handleConfirmEdit}
                  className="flex-1 py-2.5 rounded-xl bg-red-500 hover:bg-red-600 text-white text-sm font-semibold transition-colors"
                >
                  수정
                </button>
              </div>
            </div>
          </div>,
          document.body
        )}
      </td>
      {/* 하원 */}
      <td className="px-3 py-3 text-center whitespace-nowrap">
        {record.status === 'approved' && (
          !record.checked_out_at ? (
            <div className="flex flex-col items-center gap-1">
              <button
                onClick={handleCheckOutClick}
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
              {onAdminForceCheckout && (
                <button
                  onClick={onAdminForceCheckout}
                  className="px-2 py-1 rounded-lg text-xs font-semibold bg-red-50 hover:bg-red-100 text-red-500 transition-colors"
                >
                  강제하원
                </button>
              )}
            </div>
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
          <div className="flex flex-col items-center gap-1">
            <button onClick={onCancelApprove} className="text-xs text-gray-400 hover:text-orange-500 transition-colors whitespace-nowrap">
              승인 취소
            </button>
            {onSetNextClinic && !record.checked_out_at && (
              <button
                onClick={onSetNextClinic}
                className={`text-xs px-2 py-0.5 rounded-md transition-colors whitespace-nowrap ${
                  record.next_clinic_date
                    ? 'text-blue-500 hover:text-blue-700 bg-blue-50 hover:bg-blue-100'
                    : 'text-gray-400 hover:text-blue-500 border border-dashed border-gray-300 hover:border-blue-400'
                }`}
              >
                {record.next_clinic_date ? `📅 ${record.next_clinic_date}` : '재등원 날짜'}
              </button>
            )}
          </div>
        )}
        {record.status === 'rejected' && (
          <div className="space-y-1">
            {record.reject_reason && <div className="text-xs text-red-400">{record.reject_reason}</div>}
            {onAllowRetry && (
              <button onClick={onAllowRetry} className="text-xs text-gray-400 hover:text-blue-500 transition-colors">
                재시도 허용
              </button>
            )}
          </div>
        )}
      </td>
    </tr>
  )
}

function MissionCycleButton({ value, onChange, variant = 'oral' }: { value: MissionStatus; onChange: (v: MissionStatus) => void; variant?: 'oral' | 'homework' }) {
  const [open, setOpen] = useState(false)
  const [pos, setPos] = useState({ top: 0, left: 0, upward: false })
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
      const optionCount = variant === 'homework' ? 5 : 7
      const estimatedHeight = optionCount * 36 + 8
      const spaceBelow = window.innerHeight - rect.bottom
      const upward = spaceBelow < estimatedHeight + 8
      setPos({
        top: upward ? rect.top - estimatedHeight - 4 : rect.bottom + 4,
        left: rect.left + rect.width / 2,
        upward,
      })
    }
    setOpen((o) => !o)
  }

  const key = value ?? 'null'
  const badgeStyles: Record<string, string> = {
    'null': 'bg-gray-100 text-gray-400',
    'pass': 'bg-green-100 text-green-700',
    'fail': 'bg-red-100 text-red-700',
    'delay': 'bg-orange-100 text-orange-600',
    'word_pass': 'bg-orange-100 text-orange-600',
    'sentence_pass': 'bg-orange-100 text-orange-600',
    'partial_pass': 'bg-orange-100 text-orange-600',
    'exempt': 'bg-teal-100 text-teal-700',
  }
  const labels: Record<string, string> = {
    'null': '—', 'pass': 'Pass', 'fail': 'Fail', 'delay': 'Delay',
    'word_pass': '단어P', 'sentence_pass': '문장P', 'partial_pass': '일부P', 'exempt': '면제',
  }

  const oralOptions: { value: MissionStatus; label: string; style: string }[] = [
    { value: 'pass', label: 'Pass', style: 'hover:bg-green-50 text-green-700' },
    { value: 'word_pass', label: '단어Pass', style: 'hover:bg-orange-50 text-orange-600' },
    { value: 'sentence_pass', label: '문장Pass', style: 'hover:bg-orange-50 text-orange-600' },
    { value: 'exempt', label: '면제', style: 'hover:bg-teal-50 text-teal-700' },
    { value: 'fail', label: 'Fail', style: 'hover:bg-red-50 text-red-700' },
    { value: 'delay', label: 'Delay', style: 'hover:bg-orange-50 text-orange-600' },
    { value: null, label: '초기화', style: 'hover:bg-gray-50 text-gray-400' },
  ]

  const homeworkOptions: { value: MissionStatus; label: string; style: string }[] = [
    { value: 'pass', label: 'Pass', style: 'hover:bg-green-50 text-green-700' },
    { value: 'partial_pass', label: '일부Pass', style: 'hover:bg-orange-50 text-orange-600' },
    { value: 'fail', label: 'Fail', style: 'hover:bg-red-50 text-red-700' },
    { value: 'delay', label: 'Delay', style: 'hover:bg-orange-50 text-orange-600' },
    { value: null, label: '초기화', style: 'hover:bg-gray-50 text-gray-400' },
  ]

  const options = variant === 'homework' ? homeworkOptions : oralOptions

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
          className={`z-50 bg-white border border-gray-200 rounded-xl shadow-lg py-1 min-w-[80px] ${pos.upward ? 'flex flex-col-reverse' : ''}`}
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
