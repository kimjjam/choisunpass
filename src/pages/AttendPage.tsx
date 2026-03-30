import { useState, useEffect, useRef } from 'react'
import { supabase } from '../lib/supabase'
import type { Student, Attendance } from '../lib/database.types'

type PageState = 'input' | 'pending' | 'approved' | 'checked_out' | 'rejected'

export default function AttendPage() {
  const [code, setCode] = useState('')
  const [pageState, setPageState] = useState<PageState>('input')
  const [student, setStudent] = useState<Student | null>(null)
  const [attendance, setAttendance] = useState<Attendance | null>(null)
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)
  const subscriptionRef = useRef<ReturnType<typeof supabase.channel> | null>(null)

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
          }
        }
      )
      .subscribe()

    subscriptionRef.current = channel

    return () => {
      supabase.removeChannel(channel)
    }
  }, [attendance?.id])

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    setError('')

    if (!code.trim()) return

    setLoading(true)
    try {
      // 1. 코드로 학생 조회
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

      // 2. 오늘 이미 출석 요청했는지 확인
      const today = new Date().toISOString().split('T')[0]
      const { data: existing } = await supabase
        .from('attendances')
        .select('*')
        .eq('student_id', studentData.id)
        .eq('date', today)
        .single()

      if (existing) {
        setStudent(studentData)
        setAttendance(existing)
        setPageState(existing.status as PageState)
        setLoading(false)
        return
      }

      // 3. 출석 요청 생성 (pending)
      const { data: newAttendance, error: insertError } = await supabase
        .from('attendances')
        .insert({
          student_id: studentData.id,
          date: today,
          status: 'pending',
          checked_in_at: new Date().toISOString(),
        })
        .select()
        .single()

      if (insertError || !newAttendance) {
        setError('출석 요청 중 오류가 발생했습니다. 다시 시도해주세요.')
        setLoading(false)
        return
      }

      setStudent(studentData)
      setAttendance(newAttendance)
      setPageState('pending')
    } finally {
      setLoading(false)
    }
  }

  const validStatuses = ['pass', 'fail', 'delay']
  const allDone =
    validStatuses.includes(attendance?.word_status as string) &&
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

  function handleReset() {
    setCode('')
    setPageState('input')
    setStudent(null)
    setAttendance(null)
    setError('')
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
            <p className="text-sm text-gray-500 mb-5">본인의 개인 코드를 입력하세요.</p>
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
                maxLength={6}
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
            {attendance?.approved_at && (
              <p className="text-xs text-gray-400 mb-6">
                등원: {new Date(attendance.approved_at).toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit' })}
              </p>
            )}
            {!allDone && (
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
              <div className="bg-indigo-50 rounded-xl p-3 mb-6 text-xs text-indigo-600 space-y-1">
                {attendance.approved_at && (
                  <div>등원: {new Date(attendance.approved_at).toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit' })}</div>
                )}
                <div>하원: {new Date(attendance.checked_out_at).toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit' })}</div>
              </div>
            )}
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
    </div>
  )
}
