import { useState, useEffect, useRef } from 'react'
import { supabase } from '../lib/supabase'
import type { Student, Attendance, OralQueue, VisitType } from '../lib/database.types'

type PageState = 'input' | 'pending' | 'approved' | 'checked_out' | 'rejected'

// 한국 로컬 날짜 (UTC 기준 toISOString은 오전 9시 전에 날짜가 하루 늦음)
function getLocalDateStr() {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

export default function AttendPage() {
  const [code, setCode] = useState('')
  const [pageState, setPageState] = useState<PageState>('input')
  const [student, setStudent] = useState<Student | null>(null)
  const [attendance, setAttendance] = useState<Attendance | null>(null)
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)
  const subscriptionRef = useRef<ReturnType<typeof supabase.channel> | null>(null)

  // visit_type 모달
  const [showVisitTypeModal, setShowVisitTypeModal] = useState(false)
  const [pendingStudentData, setPendingStudentData] = useState<Student | null>(null)

  // 다음에 올게요
  const [showNextClinicModal, setShowNextClinicModal] = useState(false)
  const [nextClinicDate, setNextClinicDate] = useState('')
  const [nextClinicLoading, setNextClinicLoading] = useState(false)

  // 구두 대기
  const [oralQueue, setOralQueue] = useState<OralQueue | null>(null)
  const oralQueueRef = useRef<OralQueue | null>(null)
  const [queuePosition, setQueuePosition] = useState<number>(0)
  const [showCalledModal, setShowCalledModal] = useState(false)

  useEffect(() => { oralQueueRef.current = oralQueue }, [oralQueue])

  // 새로고침 후 상태 복원
  useEffect(() => {
    const savedId = localStorage.getItem('attendance_id')
    if (!savedId) return

    supabase
      .from('attendances')
      .select('*, students(*)')
      .eq('id', savedId)
      .maybeSingle()
      .then(({ data }) => {
        if (!data) { localStorage.removeItem('attendance_id'); return }
        // 오늘 날짜가 아닌 기록이면 초기화 (날짜 넘어갔을 때 어제 기록 복원 방지)
        if (data.date !== getLocalDateStr()) { localStorage.removeItem('attendance_id'); return }
        const att = { ...data, students: undefined } as Attendance
        const stu = data.students as Student
        setAttendance(att)
        setStudent(stu)
        if (data.checked_out_at) setPageState('checked_out')
        else setPageState(data.status as PageState)
      })
  }, [])

  // attendance 변경시 localStorage 동기화
  useEffect(() => {
    if (attendance) localStorage.setItem('attendance_id', attendance.id)
  }, [attendance?.id])

  // 출석 상태 실시간 구독
  useEffect(() => {
    if (!attendance) return

    const channel = supabase
      .channel(`attendance:${attendance.id}`)
      .on(
        'postgres_changes',
        {
          event: 'UPDATE',
          schema: 'public',
          table: 'attendances',
          filter: `id=eq.${attendance.id}`,
        },
        (payload) => {
          const updated = payload.new as Attendance
          setAttendance(updated)
          if (updated.checked_out_at) {
            setPageState('checked_out')
          } else {
            setPageState(updated.status as PageState)
            // 관리자가 일괄 하원 시 force_next_clinic 플래그 감지
            if (updated.force_next_clinic) setShowNextClinicModal(true)
          }
        }
      )
      .subscribe()

    subscriptionRef.current = channel

    return () => {
      supabase.removeChannel(channel)
    }
  }, [attendance?.id])

  // 구두 대기 조회 및 구독
  useEffect(() => {
    if (!attendance) return

    // 현재 대기 상태 조회
    supabase
      .from('oral_queue')
      .select('*')
      .eq('attendance_id', attendance.id)
      .in('status', ['waiting', 'called'])
      .maybeSingle()
      .then(({ data }) => {
        if (data) {
          setOralQueue(data as OralQueue)
          if (data.status === 'called') setShowCalledModal(true)
        }
      })

    // oral_queue 실시간 구독 (내 항목 변경) - 필터 없이 id로 직접 비교 (DELETE 이벤트는 PK만 포함)
    const queueChannel = supabase
      .channel(`oral_queue:${attendance.id}`)
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'oral_queue' },
        (payload) => {
          if (payload.eventType === 'DELETE') {
            if (oralQueueRef.current && payload.old.id === oralQueueRef.current.id) {
              setOralQueue(null)
              setShowCalledModal(false)
            }
          } else {
            const updated = payload.new as OralQueue
            if (updated.attendance_id !== attendance.id) return
            setOralQueue(updated)
            if (updated.status === 'called') setShowCalledModal(true)
            else setShowCalledModal(false)
          }
        }
      )
      .subscribe()

    return () => { supabase.removeChannel(queueChannel) }
  }, [attendance?.id])

  // 대기 순번 실시간 계산
  useEffect(() => {
    if (!oralQueue || oralQueue.status !== 'waiting') return

    const fetchPosition = async () => {
      const { count } = await supabase
        .from('oral_queue')
        .select('*', { count: 'exact', head: true })
        .eq('status', 'waiting')
        .lte('created_at', oralQueue.created_at)
      setQueuePosition(count ?? 1)
    }

    fetchPosition()

    // 전체 대기열 변경시 순번 재계산
    const posChannel = supabase
      .channel('oral_queue_position')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'oral_queue' }, fetchPosition)
      .subscribe()

    return () => { supabase.removeChannel(posChannel) }
  }, [oralQueue?.id, oralQueue?.status])

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    setError('')

    if (!code.trim()) return

    setLoading(true)
    try {
      const { data: studentData, error: studentError } = await supabase
        .from('students')
        .select('*')
        .eq('code', code.trim())
        .single()

      if (studentError || !studentData) {
        setError('코드가 올바르지 않습니다. 다시 확인해주세요.')
        setLoading(false)
        return
      }

      const today = getLocalDateStr()
      const { data: existing } = await supabase
        .from('attendances')
        .select('*')
        .eq('student_id', studentData.id)
        .eq('date', today)
        .maybeSingle()

      if (existing) {
        setStudent(studentData)
        setAttendance(existing)
        if (existing.checked_out_at) setPageState('checked_out')
        else setPageState(existing.status as PageState)
        setLoading(false)
        return
      }

      // 신규 출석: visit_type 선택 모달
      setStudent(studentData)
      setPendingStudentData(studentData)
      setShowVisitTypeModal(true)
    } finally {
      setLoading(false)
    }
  }

  async function handleVisitTypeSelect(visitType: VisitType) {
    if (!pendingStudentData) return
    setShowVisitTypeModal(false)
    setLoading(true)
    const today = new Date().toISOString().split('T')[0]
    const { data: newAttendance, error: insertError } = await supabase
      .from('attendances')
      .insert({
        student_id: pendingStudentData.id,
        date: today,
        status: 'pending',
        visit_type: visitType,
        checked_in_at: new Date().toISOString(),
      })
      .select()
      .single()

    if (insertError || !newAttendance) {
      setError('출석 요청 중 오류가 발생했습니다. 다시 시도해주세요.')
      setLoading(false)
      return
    }
    setAttendance(newAttendance)
    setPageState('pending')
    setLoading(false)
  }

  async function handleNextClinic() {
    if (!attendance || !nextClinicDate) return
    setNextClinicLoading(true)
    if (attendance.visit_type === 'class_clinic') {
      // class_clinic: 조교확인 없이 바로 하원
      const { data } = await supabase
        .from('attendances')
        .update({ next_clinic_date: nextClinicDate, checked_out_at: new Date().toISOString(), force_next_clinic: false })
        .eq('id', attendance.id)
        .select()
        .single()
      if (data) { setAttendance(data); setPageState('checked_out') }
    } else {
      // clinic: next_clinic_date 저장 후 조교 확인 대기
      const { data } = await supabase
        .from('attendances')
        .update({ next_clinic_date: nextClinicDate })
        .eq('id', attendance.id)
        .select()
        .single()
      if (data) setAttendance(data)
    }
    setShowNextClinicModal(false)
    setNextClinicDate('')
    setNextClinicLoading(false)
  }

  const validStatuses = ['pass', 'fail', 'delay']
  const allDone =
    !!attendance?.word_score?.trim() &&
    !!attendance?.clinic_score?.trim() &&
    validStatuses.includes(attendance?.oral_status as string) &&
    validStatuses.includes(attendance?.homework as string)

  async function handleCheckOut() {
    if (!attendance) return
    const { data } = await supabase
      .from('attendances')
      .update({ checked_out_at: new Date().toISOString() })
      .eq('id', attendance.id)
      .select()
      .single()
    if (data) {
      setAttendance(data)
      setPageState('checked_out')
    }
  }

  async function handleCancelPending() {
    if (!attendance) return
    await supabase.from('attendances').delete().eq('id', attendance.id)
    handleReset()
  }

  async function handleReCheckIn() {
    if (!attendance) return
    const { data } = await supabase
      .from('attendances')
      .update({ checked_out_at: null, rechecked_in_at: new Date().toISOString() })
      .eq('id', attendance.id)
      .select()
      .single()
    if (data) {
      setAttendance(data)
      setPageState('approved')
    }
  }

  async function handleJoinQueue() {
    if (!attendance || !student) return
    const { data } = await supabase
      .from('oral_queue')
      .insert({ attendance_id: attendance.id, student_id: student.id, status: 'waiting' })
      .select()
      .single()
    if (data) setOralQueue(data as OralQueue)
  }

  async function handleLeaveQueue() {
    if (!oralQueue) return
    await supabase.from('oral_queue').delete().eq('id', oralQueue.id)
    setOralQueue(null)
  }

  function handleReset() {
    setCode('')
    setPageState('input')
    setStudent(null)
    setAttendance(null)
    setOralQueue(null)
    setShowCalledModal(false)
    setShowVisitTypeModal(false)
    setShowNextClinicModal(false)
    setPendingStudentData(null)
    setNextClinicDate('')
    setError('')
    localStorage.removeItem('attendance_id')
    if (subscriptionRef.current) {
      supabase.removeChannel(subscriptionRef.current)
    }
    setTimeout(() => inputRef.current?.focus(), 100)
  }

  return (
    <div className="min-h-screen bg-gray-50 flex flex-col items-center justify-center p-4">
      <div className="w-full max-w-sm">
        {/* 헤더 */}
        <div className="text-center mb-8">
          <div className="text-3xl font-bold text-blue-600 mb-1">최선 패스</div>
          <div className="text-sm text-gray-500">최선어학원 클리닉 출석</div>
        </div>

        {/* 코드 입력 화면 */}
        {pageState === 'input' && (
          <div className="bg-white rounded-2xl shadow-sm border border-gray-100 p-6">
            <h2 className="text-lg font-semibold text-gray-800 mb-1">출석 코드 입력</h2>
            <p className="text-sm text-gray-500 mb-1">본인의 개인 코드를 입력하세요.</p>
            <p className="text-xs text-gray-400 mb-5">코드는 전화번호 마지막 4자리거나 중간 4자리입니다.</p>
            <form onSubmit={handleSubmit} className="space-y-4">
              <input
                ref={inputRef}
                type="text"
                inputMode="numeric"
                pattern="[0-9]*"
                value={code}
                onChange={(e) => {
                  setCode(e.target.value)
                  setError('')
                }}
                placeholder="코드 입력"
                maxLength={4}
                autoFocus
                className="w-full text-center text-2xl font-bold tracking-[0.5em] border-2 border-gray-200 rounded-xl py-4 focus:border-blue-500 focus:outline-none transition-colors"
              />
              {error && (
                <p className="text-sm text-red-500 text-center">{error}</p>
              )}
              <button
                type="submit"
                disabled={loading || !code.trim()}
                className="w-full bg-blue-600 hover:bg-blue-700 disabled:bg-gray-300 text-white font-semibold py-3.5 rounded-xl transition-colors text-base"
              >
                {loading ? '확인 중...' : '출석 요청'}
              </button>
            </form>
          </div>
        )}

        {/* 승인 대기 화면 */}
        {pageState === 'pending' && student && (
          <div className="bg-white rounded-2xl shadow-sm border border-gray-100 p-6 text-center">
            <div className="w-16 h-16 bg-yellow-100 rounded-full flex items-center justify-center mx-auto mb-4">
              <svg className="w-8 h-8 text-yellow-500 animate-pulse" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" />
              </svg>
            </div>
            <h2 className="text-lg font-bold text-gray-800 mb-1">{student.name} 학생</h2>
            <p className="text-2xl font-bold text-yellow-600 mb-2">승인 대기 중</p>
            <p className="text-sm text-gray-500 mb-6">조교 선생님께서 확인 중입니다.<br />잠시만 기다려주세요.</p>
            <div className="flex justify-center gap-1.5 mb-2">
              {[0, 1, 2].map((i) => (
                <div
                  key={i}
                  className="w-2 h-2 bg-yellow-400 rounded-full animate-bounce"
                  style={{ animationDelay: `${i * 0.15}s` }}
                />
              ))}
            </div>
            <p className="text-xs text-gray-400 mt-4">{student.class}</p>
            <button
              onClick={handleCancelPending}
              className="mt-4 text-sm text-gray-400 hover:text-red-400 underline transition-colors"
            >
              출석 취소
            </button>
          </div>
        )}

        {/* 승인 완료 화면 */}
        {pageState === 'approved' && student && (
          <div className="bg-white rounded-2xl shadow-sm border border-gray-100 p-6 text-center">
            <div className="w-16 h-16 bg-green-100 rounded-full flex items-center justify-center mx-auto mb-4">
              <svg className="w-9 h-9 text-green-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M5 13l4 4L19 7" />
              </svg>
            </div>
            <h2 className="text-lg font-bold text-gray-800 mb-1">{student.name} 학생</h2>
            <p className="text-2xl font-bold text-green-600 mb-2">출석 완료!</p>
            <p className="text-sm text-gray-500 mb-4">
              등원이 확인되었습니다.<br />오늘도 열심히 해봐요!
            </p>
            {(attendance?.approved_at || attendance?.rechecked_in_at) && (
              <p className="text-xs text-gray-400 mb-4 space-y-0.5">
                {attendance.approved_at && (
                  <span className="block">등원: {new Date(attendance.approved_at).toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit' })}</span>
                )}
                {attendance.rechecked_in_at && (
                  <span className="block text-blue-400">재등원: {new Date(attendance.rechecked_in_at).toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit' })}</span>
                )}
              </p>
            )}

            {/* 구두 대기 */}
            {!oralQueue && (
              <button
                onClick={handleJoinQueue}
                className="w-full bg-purple-500 hover:bg-purple-600 text-white font-semibold py-3 rounded-xl transition-colors text-base mb-3"
              >
                구두 대기 등록
              </button>
            )}
            {oralQueue && oralQueue.status === 'waiting' && (
              <div className="bg-purple-50 border border-purple-100 rounded-xl p-4 mb-3">
                <p className="text-sm text-purple-600 font-medium mb-1">구두 대기 중</p>
                <p className="text-3xl font-bold text-purple-700 mb-1">{queuePosition}번째</p>
                <p className="text-xs text-purple-400 mb-3">호출되면 알려드릴게요</p>
                <button
                  onClick={handleLeaveQueue}
                  className="text-xs text-gray-400 hover:text-red-400 underline transition-colors"
                >
                  대기 취소
                </button>
              </div>
            )}

            {/* 다음에 올게요 - 조교확인 대기 중 */}
            {attendance?.next_clinic_date && attendance.visit_type === 'clinic' && (
              <div className="bg-blue-50 border border-blue-100 rounded-xl p-3 mb-3 text-xs text-blue-600">
                다음 클리닉: <span className="font-bold">{attendance.next_clinic_date}</span><br />
                조교 선생님 확인 후 하원 처리됩니다.
              </div>
            )}

            {!allDone && !attendance?.next_clinic_date && (
              <p className="text-xs text-orange-500 bg-orange-50 rounded-xl py-2 px-3 mb-3">
                조교 선생님의 확인이 완료되면 하원 버튼이 활성화됩니다.
              </p>
            )}
            <button
              onClick={handleCheckOut}
              disabled={!allDone}
              className={`w-full font-semibold py-3.5 rounded-xl transition-colors text-base mb-3 ${
                allDone
                  ? 'bg-indigo-600 hover:bg-indigo-700 text-white'
                  : 'bg-gray-200 text-gray-400 cursor-not-allowed'
              }`}
            >
              하원할게요
            </button>
            {!attendance?.next_clinic_date && (
              <button
                onClick={() => setShowNextClinicModal(true)}
                className="w-full bg-gray-100 hover:bg-gray-200 text-gray-600 font-semibold py-3 rounded-xl transition-colors text-sm mb-3"
              >
                다음에 올게요
              </button>
            )}
            <button
              onClick={handleReset}
              className="text-sm text-gray-400 hover:text-gray-600 underline transition-colors"
            >
              처음으로
            </button>
          </div>
        )}

        {/* 하원 완료 화면 */}
        {pageState === 'checked_out' && student && (
          <div className="bg-white rounded-2xl shadow-sm border border-gray-100 p-6 text-center">
            <div className="w-16 h-16 bg-indigo-100 rounded-full flex items-center justify-center mx-auto mb-4">
              <svg className="w-9 h-9 text-indigo-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M17 16l4-4m0 0l-4-4m4 4H7m6 4v1a3 3 0 01-3 3H6a3 3 0 01-3-3V7a3 3 0 013-3h4a3 3 0 013 3v1" />
              </svg>
            </div>
            <h2 className="text-lg font-bold text-gray-800 mb-1">{student.name} 학생</h2>
            <p className="text-2xl font-bold text-indigo-600 mb-2">하원 완료!</p>
            <p className="text-sm text-gray-500 mb-4">
              오늘도 수고했어요!<br />내일 또 봐요 😊
            </p>
            {attendance?.checked_out_at && (
              <div className="bg-indigo-50 rounded-xl p-3 mb-4 text-xs text-indigo-600 space-y-1">
                {attendance.approved_at && (
                  <div>등원: {new Date(attendance.approved_at).toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit' })}</div>
                )}
                {attendance.rechecked_in_at && (
                  <div>재등원: {new Date(attendance.rechecked_in_at).toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit' })}</div>
                )}
                <div>하원: {new Date(attendance.checked_out_at).toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit' })}</div>
              </div>
            )}
            <button
              onClick={handleReCheckIn}
              className="w-full bg-blue-500 hover:bg-blue-600 text-white font-semibold py-3 rounded-xl transition-colors text-base mb-3"
            >
              재등원
            </button>
            <button
              onClick={handleReset}
              className="text-sm text-gray-400 hover:text-gray-600 underline transition-colors"
            >
              처음으로
            </button>
          </div>
        )}

        {/* 거절 화면 */}
        {pageState === 'rejected' && student && (
          <div className="bg-white rounded-2xl shadow-sm border border-gray-100 p-6 text-center">
            <div className="w-16 h-16 bg-red-100 rounded-full flex items-center justify-center mx-auto mb-4">
              <svg className="w-9 h-9 text-red-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M6 18L18 6M6 6l12 12" />
              </svg>
            </div>
            <h2 className="text-lg font-bold text-gray-800 mb-1">{student.name} 학생</h2>
            <p className="text-2xl font-bold text-red-600 mb-2">출석 거절</p>
            {attendance?.reject_reason ? (
              <div className="bg-red-50 border border-red-100 rounded-xl p-3 mb-5">
                <p className="text-sm text-red-700">{attendance.reject_reason}</p>
              </div>
            ) : (
              <p className="text-sm text-gray-500 mb-5">조교 선생님께 문의해주세요.</p>
            )}
            <button
              onClick={handleReset}
              className="w-full bg-gray-800 hover:bg-gray-700 text-white font-semibold py-3.5 rounded-xl transition-colors text-base"
            >
              다시 시도
            </button>
          </div>
        )}
      </div>

      {/* visit_type 선택 모달 */}
      {showVisitTypeModal && student && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
          <div className="bg-white rounded-2xl w-full max-w-xs p-6 shadow-2xl">
            <h3 className="font-bold text-gray-800 text-center text-lg mb-1">{student.name} 학생</h3>
            <p className="text-sm text-gray-500 text-center mb-6">오늘 방문 목적을 선택하세요</p>
            <div className="flex flex-col gap-3">
              <button
                onClick={() => handleVisitTypeSelect('class_clinic')}
                className="py-4 rounded-xl bg-blue-600 hover:bg-blue-700 text-white font-bold text-base transition-colors"
              >
                수업 + 클리닉
              </button>
              <button
                onClick={() => handleVisitTypeSelect('clinic')}
                className="py-4 rounded-xl bg-purple-600 hover:bg-purple-700 text-white font-bold text-base transition-colors"
              >
                클리닉만
              </button>
            </div>
            <button
              onClick={() => { setShowVisitTypeModal(false); setStudent(null); setPendingStudentData(null) }}
              className="w-full mt-3 py-2.5 text-sm text-gray-400 hover:text-gray-600 transition-colors"
            >
              취소
            </button>
          </div>
        </div>
      )}

      {/* 다음에 올게요 모달 */}
      {showNextClinicModal && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
          <div className="bg-white rounded-2xl w-full max-w-xs p-6 shadow-2xl">
            <h3 className="font-bold text-gray-800 text-center text-lg mb-1">다음에 올게요</h3>
            <p className="text-sm text-gray-500 text-center mb-5">다음 클리닉 날짜를 입력해주세요</p>
            <input
              type="date"
              value={nextClinicDate}
              onChange={(e) => setNextClinicDate(e.target.value)}
              min={new Date().toISOString().split('T')[0]}
              className="w-full border border-gray-200 rounded-xl px-3 py-3 text-sm focus:outline-none focus:border-blue-400 mb-4"
            />
            {attendance?.visit_type === 'clinic' && (
              <p className="text-xs text-orange-500 bg-orange-50 rounded-lg p-2 mb-4">
                클리닉 학생은 조교 선생님 확인 후 하원 처리됩니다.
              </p>
            )}
            <div className="flex gap-2">
              <button
                onClick={() => { setShowNextClinicModal(false); setNextClinicDate('') }}
                className="flex-1 py-3 rounded-xl border border-gray-200 text-sm text-gray-600"
              >
                취소
              </button>
              <button
                onClick={handleNextClinic}
                disabled={!nextClinicDate || nextClinicLoading}
                className="flex-1 py-3 rounded-xl bg-blue-600 hover:bg-blue-700 disabled:bg-gray-300 text-white text-sm font-semibold transition-colors"
              >
                {nextClinicLoading ? '처리 중...' : '확인'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* 구두 호출 모달 */}
      {showCalledModal && student && (
        <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50 p-4">
          <div className="bg-white rounded-2xl p-8 w-full max-w-sm text-center shadow-2xl">
            <div className="w-20 h-20 bg-purple-100 rounded-full flex items-center justify-center mx-auto mb-5">
              <svg className="w-10 h-10 text-purple-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 17h5l-1.405-1.405A2.032 2.032 0 0118 14.158V11a6.002 6.002 0 00-4-5.659V5a2 2 0 10-4 0v.341C7.67 6.165 6 8.388 6 11v3.159c0 .538-.214 1.055-.595 1.436L4 17h5m6 0v1a3 3 0 11-6 0v-1m6 0H9" />
              </svg>
            </div>
            <h2 className="text-xl font-bold text-gray-800 mb-2">{student.name} 학생</h2>
            <p className="text-3xl font-bold text-purple-600 mb-3">지금 오세요!</p>
            {oralQueue?.caller ? (
              <p className="text-sm text-gray-500 mb-6">
                <span className="font-bold text-purple-700">{oralQueue.caller}</span> 님이 호출했습니다.<br />조교님께 가주세요.
              </p>
            ) : (
              <p className="text-sm text-gray-500 mb-6">구두 테스트 차례입니다.<br />조교 선생님께 가주세요.</p>
            )}
            <button
              onClick={() => setShowCalledModal(false)}
              className="w-full bg-purple-600 hover:bg-purple-700 text-white font-semibold py-3.5 rounded-xl transition-colors"
            >
              확인
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
