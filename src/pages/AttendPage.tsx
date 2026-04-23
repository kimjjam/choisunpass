import { useState, useEffect, useRef } from 'react'
import { supabase } from '../lib/supabase'
import type { Student, Attendance, OralQueue, VisitType } from '../lib/database.types'
import { useManifest } from '../hooks/useManifest'

interface BeforeInstallPromptEvent extends Event {
  prompt: () => Promise<void>
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>
}

type PageState = 'input' | 'pending' | 'approved' | 'checked_out' | 'rejected' | 'absent'

// 한국 로컬 날짜 (UTC 기준 toISOString은 오전 9시 전에 날짜가 하루 늦음)
function getLocalDateStr() {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

export default function AttendPage() {
  useManifest('/manifest-attend.webmanifest')

  const [installPrompt, setInstallPrompt] = useState<BeforeInstallPromptEvent | null>(null)
  const [showIosGuide, setShowIosGuide] = useState(false)
  const [showAndroidGuide, setShowAndroidGuide] = useState(false)
  const [isStandalone, setIsStandalone] = useState(false)
  const [isIos, setIsIos] = useState(false)

  useEffect(() => {
    const standalone = window.matchMedia('(display-mode: standalone)').matches
      || (window.navigator as Navigator & { standalone?: boolean }).standalone === true
    setIsStandalone(standalone)
    const ios = /iphone|ipad|ipod/i.test(navigator.userAgent)
    setIsIos(ios)
    if (standalone) return
    if (ios) {
      if (!localStorage.getItem('pwa-attend-dismissed')) setShowIosGuide(true)
    } else {
      const handler = (e: Event) => { e.preventDefault(); setInstallPrompt(e as BeforeInstallPromptEvent) }
      window.addEventListener('beforeinstallprompt', handler)
      return () => window.removeEventListener('beforeinstallprompt', handler)
    }
  }, [])

  function dismissAttendBanner() {
    localStorage.setItem('pwa-attend-dismissed', '1')
    setInstallPrompt(null)
    setShowIosGuide(false)
  }

  async function handleAttendInstall() {
    if (!installPrompt) return
    await installPrompt.prompt()
    const { outcome } = await installPrompt.userChoice
    if (outcome === 'accepted') localStorage.setItem('pwa-attend-dismissed', '1')
    setInstallPrompt(null)
  }

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
  const [showNextClinicActionModal, setShowNextClinicActionModal] = useState(false)

  // 구두/숙검 대기
  const [oralQueue, setOralQueue] = useState<OralQueue | null>(null)
  const oralQueueRef = useRef<OralQueue | null>(null)
  const [queuePosition, setQueuePosition] = useState<number>(0)
  const [showCalledModal, setShowCalledModal] = useState(false)
  const [showReCheckInModal, setShowReCheckInModal] = useState(false)
  const [showQueueTypeModal, setShowQueueTypeModal] = useState(false)

  // 미완료 항목 모달
  type IncompleteWeek = { label: string; fields: string[] }
  const [incompleteModal, setIncompleteModal] = useState<IncompleteWeek[] | null>(null)
  const [incompleteItems, setIncompleteItems] = useState<IncompleteWeek[] | null>(null)
  const prevPageState = useRef<PageState>('input')
  const [maintenanceMode, setMaintenanceMode] = useState(false)

  useEffect(() => {
    supabase.from('app_settings').select('value').eq('key', 'maintenance_mode').single()
      .then(({ data }) => { if (data?.value === 'true') setMaintenanceMode(true) })
  }, [])

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

  // pending → approved 전환 시 미완료 항목 체크 + push 구독
  useEffect(() => {
    const wasApproved = prevPageState.current === 'approved'
    prevPageState.current = pageState
    if (pageState !== 'approved' || wasApproved || !student) return
    checkIncompleteItems(student.id, !!attendance?.rechecked_in_at, attendance?.id)
    // push 구독 등록
    if (attendance?.id) subscribePush(attendance.id)
  }, [pageState])

  function urlBase64ToUint8Array(base64String: string) {
    const padding = '='.repeat((4 - (base64String.length % 4)) % 4)
    const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/')
    const rawData = atob(base64)
    return Uint8Array.from([...rawData].map(c => c.charCodeAt(0)))
  }

  async function subscribePush(attendanceId: string) {
    try {
      if (!('serviceWorker' in navigator) || !('PushManager' in window)) {
        console.warn('push not supported')
        return
      }
      const reg = await navigator.serviceWorker.ready
      const permission = await Notification.requestPermission()
      if (permission !== 'granted') {
        console.warn('push permission denied:', permission)
        return
      }
      // 기존 구독 제거 후 새로 구독 (키 변경 대응)
      const existing = await reg.pushManager.getSubscription()
      if (existing) await existing.unsubscribe()
      const vapidKey = import.meta.env.VITE_VAPID_PUBLIC_KEY
      if (!vapidKey) {
        console.error('VITE_VAPID_PUBLIC_KEY is not set')
        return
      }
      const sub = await reg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(vapidKey),
      })
      const { error } = await supabase.from('attendances').update({
        push_subscription: sub.toJSON(),
      }).eq('id', attendanceId)
      if (error) console.error('supabase push_subscription save error:', error)
      else console.log('push subscription saved successfully')
    } catch (e) {
      console.error('push subscribe failed:', e)
    }
  }

  function localDateStr(d: Date) {
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
  }

  function getWeekRange(date: Date) {
    const day = date.getDay()
    const diff = day === 0 ? -6 : 1 - day
    const monday = new Date(date)
    monday.setDate(date.getDate() + diff)
    const friday = new Date(monday)
    friday.setDate(monday.getDate() + 4)
    return { start: localDateStr(monday), end: localDateStr(friday) }
  }

  function getIncompleteFields(r: { word_score?: string | null; clinic_score?: string | null; oral_status?: string | null; homework?: string | null }): string[] {
    const fields: string[] = []
    const blank = (v: string | null | undefined) => !v?.trim() || v === '00' || v === '--' || v === '-'
    if (blank(r.word_score)) fields.push('단어 점수')
    if (blank(r.clinic_score)) fields.push('클리닉 점수')
    if (r.oral_status === 'fail') fields.push('구두 (Fail)')
    else if (r.oral_status === 'word_pass') fields.push('구두 (단어Pass만)')
    else if (r.oral_status === 'sentence_pass') fields.push('구두 (문장Pass만)')
    else if (r.oral_status === 'delay' || !r.oral_status) fields.push('구두 (미완료)')
    if (r.homework === 'fail') fields.push('과제 (Fail)')
    else if (r.homework === 'partial_pass') fields.push('과제 (일부Pass)')
    else if (r.homework === 'delay' || !r.homework) fields.push('과제 (미완료)')
    return fields
  }

  async function checkIncompleteItems(studentId: string, isReCheckIn: boolean, attendanceId?: string) {
    const today = new Date()
    const lastWeek = getWeekRange(new Date(today.getFullYear(), today.getMonth(), today.getDate() - 7))
    const thisWeek = getWeekRange(today)
    const todayStr = localDateStr(today)

    const result: IncompleteWeek[] = []

    // 지난주 미완료 — 여러 기록 중 하나라도 완료된 게 있으면 미완료 아님
    const { data: lastWeekRows } = await supabase
      .from('attendances')
      .select('word_score, clinic_score, oral_status, homework')
      .eq('student_id', studentId)
      .eq('status', 'approved')
      .gte('date', lastWeek.start)
      .lte('date', lastWeek.end)
      .order('date', { ascending: false })
    if (lastWeekRows && lastWeekRows.length > 0) {
      const hasComplete = lastWeekRows.some(r => getIncompleteFields(r).length === 0)
      if (!hasComplete) {
        // 가장 최근 기록 기준으로 미완료 필드 표시
        const fields = getIncompleteFields(lastWeekRows[0])
        if (fields.length > 0) result.push({ label: '지난주', fields })
      }
    }

    // 재등원이면 이번주도 체크 (오늘 제외) — 동일하게 완료 기록 있으면 스킵
    if (isReCheckIn) {
      const { data: thisWeekRows } = await supabase
        .from('attendances')
        .select('word_score, clinic_score, oral_status, homework')
        .eq('student_id', studentId)
        .eq('status', 'approved')
        .gte('date', thisWeek.start)
        .lte('date', thisWeek.end)
        .neq('date', todayStr)
        .order('date', { ascending: false })
      if (thisWeekRows && thisWeekRows.length > 0) {
        const hasComplete = thisWeekRows.some(r => getIncompleteFields(r).length === 0)
        if (!hasComplete) {
          const fields = getIncompleteFields(thisWeekRows[0])
          if (fields.length > 0) result.push({ label: '이번주', fields })
        }
      }
    }

    if (result.length > 0) {
      setIncompleteItems(result)
      // 오늘 이미 본 적 없으면 자동 팝업
      const shownKey = `incomplete-shown-${attendanceId ?? studentId}`
      if (!localStorage.getItem(shownKey)) {
        setIncompleteModal(result)
        localStorage.setItem(shownKey, '1')
      }
    }
  }

  // 출석 상태 폴링 백업 (5초마다 - Realtime 미수신 대비)
  useEffect(() => {
    if (!attendance) return
    const poll = setInterval(async () => {
      const { data } = await supabase.from('attendances').select('*').eq('id', attendance.id).maybeSingle()
      if (!data) {
        // 레코드 삭제됨 → 처음 화면으로
        localStorage.removeItem('attendance_id')
        setAttendance(null)
        setPageState('input')
      } else if (data.status !== attendance.status || !!data.checked_out_at !== !!attendance.checked_out_at) {
        setAttendance(data)
        if (data.checked_out_at) setPageState('checked_out')
        else setPageState(data.status as PageState)
      }
    }, 5000)
    return () => clearInterval(poll)
  }, [attendance?.id, attendance?.status, attendance?.checked_out_at])

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
        },
        (payload) => {
          const updated = payload.new as Attendance
          if (updated.id !== attendance.id) return
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
      .on(
        'postgres_changes',
        {
          event: 'DELETE',
          schema: 'public',
          table: 'attendances',
        },
        (payload) => {
          if ((payload.old as Attendance).id !== attendance.id) return
          // 레코드 삭제 = 재시도 허용 → 처음 화면으로
          localStorage.removeItem('attendance_id')
          setAttendance(null)
          setPageState('input')
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
            if (updated.status === 'called') {
              setShowCalledModal(true)
              // 진동 (Android 지원)
              if (navigator.vibrate) navigator.vibrate([300, 200, 300])
              // 알람음
              try {
                const ctx = new AudioContext()
                const playBeep = (time: number) => {
                  const osc = ctx.createOscillator()
                  const gain = ctx.createGain()
                  osc.connect(gain)
                  gain.connect(ctx.destination)
                  osc.frequency.value = 880
                  gain.gain.setValueAtTime(0.5, time)
                  gain.gain.exponentialRampToValueAtTime(0.001, time + 0.4)
                  osc.start(time)
                  osc.stop(time + 0.4)
                }
                playBeep(ctx.currentTime)
                playBeep(ctx.currentTime + 0.5)
                playBeep(ctx.currentTime + 1.0)
                // 마지막 비프음 종료 후 AudioContext 정리 (메모리 누수 방지)
                setTimeout(() => ctx.close(), 2000)
              } catch {}
            }
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
    if (!pendingStudentData || loading) return  // loading 중 중복 탭 방지
    setShowVisitTypeModal(false)
    setLoading(true)
    const today = getLocalDateStr()

    // 혹시 이미 등록된 출석이 있는지 한 번 더 확인 (빠른 중복 탭 방지)
    const { data: existing } = await supabase
      .from('attendances')
      .select('*')
      .eq('student_id', pendingStudentData.id)
      .eq('date', today)
      .maybeSingle()

    if (existing) {
      setAttendance(existing)
      if (existing.checked_out_at) setPageState('checked_out')
      else setPageState(existing.status as PageState)
      setLoading(false)
      return
    }

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
      // class_clinic: 날짜 저장 후 수업/하원 선택 모달
      const { data } = await supabase
        .from('attendances')
        .update({ next_clinic_date: nextClinicDate, force_next_clinic: false })
        .eq('id', attendance.id)
        .select()
        .single()
      if (data) setAttendance(data)
      setShowNextClinicModal(false)
      setNextClinicDate('')
      setNextClinicLoading(false)
      setShowNextClinicActionModal(true)
    } else {
      // clinic: next_clinic_date 저장 + checkout_requested 플래그 → 조교 확인 대기
      const { data } = await supabase
        .from('attendances')
        .update({ next_clinic_date: nextClinicDate, checkout_requested: true })
        .eq('id', attendance.id)
        .select()
        .single()
      if (data) setAttendance(data)
      setShowNextClinicModal(false)
      setNextClinicDate('')
      setNextClinicLoading(false)
    }
  }

  async function handleNextClinicCheckOut() {
    if (!attendance) return
    const { data } = await supabase
      .from('attendances')
      .update({ checked_out_at: new Date().toISOString() })
      .eq('id', attendance.id)
      .select()
      .single()
    if (data) { setAttendance(data); setPageState('checked_out') }
    setShowNextClinicActionModal(false)
  }

  const validStatuses = ['pass', 'fail', 'delay', 'word_pass', 'sentence_pass', 'partial_pass', 'exempt']
  const allDone =
    !!attendance?.word_score?.trim() &&
    !!attendance?.clinic_score?.trim() &&
    validStatuses.includes(attendance?.oral_status as string) &&
    validStatuses.includes(attendance?.homework as string)
  const canCheckOut = allDone || (attendance?.visit_type === 'class_clinic' && !!attendance?.next_clinic_date)

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

  async function handleJoinQueue(type: 'oral' | 'homework_check') {
    if (!attendance || !student) return
    setShowQueueTypeModal(false)
    const { data } = await supabase
      .from('oral_queue')
      .insert({ attendance_id: attendance.id, student_id: student.id, status: 'waiting', type })
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

  if (maintenanceMode) {
    return (
      <div className="min-h-screen bg-gray-900 flex flex-col items-center justify-center gap-5 px-6 text-center">
        <div className="text-7xl">🚧</div>
        <h1 className="text-white font-black text-2xl">점검 중입니다</h1>
        <p className="text-gray-400 text-sm leading-relaxed">
          현재 서비스 점검 중이에요.<br />잠시 후 다시 시도해주세요.
        </p>
      </div>
    )
  }

  return (
    <div className="min-h-screen bg-slate-50 flex flex-col items-center pt-12 pb-24 px-5">

      {/* Android 설치 배너 */}
      {installPrompt && (
        <div className="fixed bottom-0 left-0 right-0 z-50 p-4">
          <div className="bg-white rounded-3xl shadow-[0_8px_30px_rgba(0,0,0,0.12)] p-4 flex items-center gap-3 max-w-sm mx-auto">
            <div className="w-11 h-11 rounded-2xl bg-blue-500 flex items-center justify-center flex-shrink-0 text-white font-black text-base shadow-sm">최</div>
            <div className="flex-1 min-w-0">
              <p className="text-sm font-bold text-gray-900">홈 화면에 추가</p>
              <p className="text-xs text-gray-400">앱처럼 빠르게 열 수 있어요</p>
            </div>
            <div className="flex gap-2 flex-shrink-0">
              <button onClick={dismissAttendBanner} className="text-xs text-gray-400 px-2 py-1.5">나중에</button>
              <button onClick={handleAttendInstall} className="text-xs bg-blue-500 text-white font-bold px-3 py-1.5 rounded-xl">추가</button>
            </div>
          </div>
        </div>
      )}

      {/* Android 설치 안내 */}
      {showAndroidGuide && (
        <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/40" onClick={() => setShowAndroidGuide(false)}>
          <div className="bg-white rounded-t-3xl w-full max-w-sm p-6 shadow-2xl" onClick={e => e.stopPropagation()}>
            <div className="w-10 h-1 bg-gray-200 rounded-full mx-auto mb-5" />
            <p className="text-base font-bold text-gray-900 mb-2">홈 화면에 추가하기</p>
            <p className="text-sm text-gray-500 leading-relaxed">
              브라우저 상단의 <span className="font-semibold text-gray-700">⋮ 메뉴</span>를 누른 후{' '}
              <span className="font-semibold text-gray-700">"홈 화면에 추가"</span>를 선택해주세요
            </p>
          </div>
        </div>
      )}

      {/* iOS 설치 안내 배너 */}
      {showIosGuide && (
        <div className="fixed bottom-0 left-0 right-0 z-50">
          <div className="bg-white rounded-t-3xl w-full max-w-sm mx-auto p-6 shadow-2xl">
            <div className="w-10 h-1 bg-gray-200 rounded-full mx-auto mb-5" />
            <div className="flex items-center justify-between mb-2">
              <p className="text-base font-bold text-gray-900">홈 화면에 추가하기</p>
              <button onClick={dismissAttendBanner} className="text-gray-400 text-xl leading-none">✕</button>
            </div>
            <p className="text-sm text-gray-500 leading-relaxed">
              하단의 <span className="text-blue-500 font-semibold">공유</span> 버튼을 누른 후{' '}
              <span className="font-semibold text-gray-700">"홈 화면에 추가"</span>를 선택해주세요
            </p>
          </div>
        </div>
      )}

      <div className="w-full max-w-sm">
        {/* 헤더 */}
        <div className="text-center mb-6">
          <div className="text-2xl font-black text-gray-900 mb-0.5">최선 패스</div>
          <div className="text-sm text-gray-400">최선어학원 클리닉 출석</div>
        </div>

        {/* 코드 입력 화면 */}
        {pageState === 'input' && (
          <div className="bg-white rounded-3xl shadow-[0_4px_20px_rgba(0,0,0,0.07)] overflow-hidden">
            {/* 상단 컬러 스트라이프 */}
            <div className="h-1.5 bg-gradient-to-r from-blue-400 via-violet-400 to-pink-400" />
            <div className="px-6 pt-6 pb-7">
              {/* 아이콘 */}
              <div className="w-12 h-12 bg-blue-50 rounded-2xl flex items-center justify-center mb-5">
                <svg className="w-6 h-6 text-blue-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M16 7a4 4 0 11-8 0 4 4 0 018 0zM12 14a7 7 0 00-7 7h14a7 7 0 00-7-7z" />
                </svg>
              </div>
              <h2 className="text-xl font-black text-gray-900 mb-1">출석 코드 입력</h2>
              <p className="text-sm text-gray-400 mb-7">전화번호 마지막 또는 중간 4자리</p>
              <form onSubmit={handleSubmit}>
                {/* OTP 박스 + 투명 input 오버레이 */}
                <div className="relative mb-5">
                  <div className="flex gap-3 justify-center pointer-events-none select-none">
                    {[0, 1, 2, 3].map((i) => (
                      <div
                        key={i}
                        className={`w-16 h-[72px] rounded-2xl flex items-center justify-center text-3xl font-black transition-all duration-150 ${
                          i === code.length
                            ? 'bg-blue-50 ring-2 ring-blue-400 scale-105'
                            : code[i]
                            ? 'bg-slate-50 ring-2 ring-blue-200 text-gray-900'
                            : 'bg-slate-50 ring-2 ring-transparent text-gray-200'
                        }`}
                      >
                        {code[i] ?? ''}
                      </div>
                    ))}
                  </div>
                  <input
                    ref={inputRef}
                    type="text"
                    inputMode="numeric"
                    pattern="[0-9]*"
                    value={code}
                    onChange={(e) => { setCode(e.target.value.replace(/\D/g, '')); setError('') }}
                    maxLength={4}
                    autoFocus
                    className="absolute inset-0 w-full h-full z-10 cursor-pointer bg-transparent text-transparent outline-none border-none"
                    style={{ caretColor: 'transparent' }}
                  />
                </div>
                {error && <p className="text-sm text-red-400 text-center mb-3">{error}</p>}
                <button
                  type="submit"
                  disabled={loading || !code.trim()}
                  className="w-full bg-blue-500 hover:bg-blue-600 disabled:bg-gray-100 disabled:text-gray-300 text-white font-bold py-4 rounded-2xl text-base transition-colors shadow-sm"
                >
                  {loading ? '확인 중...' : '출석 요청'}
                </button>
              </form>
            </div>
          </div>
        )}

        {/* 승인 대기 화면 */}
        {pageState === 'pending' && student && (
          <div className="bg-white rounded-3xl shadow-[0_4px_20px_rgba(0,0,0,0.07)] overflow-hidden">
            <div className="px-6 pt-8 pb-6 text-center">
              <div className="w-16 h-16 bg-amber-50 rounded-full flex items-center justify-center mx-auto mb-5">
                <svg className="w-8 h-8 text-amber-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" />
                </svg>
              </div>
              <p className="text-xs text-gray-400 mb-0.5">{student.class}</p>
              <h2 className="text-xl font-black text-gray-900 mb-1">{student.name} 학생</h2>
              <p className="text-2xl font-black text-amber-500 mb-3">승인 대기 중</p>
              <p className="text-sm text-gray-400 leading-relaxed mb-6">
                조교 선생님이 확인 중이에요<br />잠시만 기다려주세요
              </p>
              <div className="flex justify-center gap-2 mb-2">
                {[0, 1, 2].map((i) => (
                  <div key={i} className="w-2 h-2 bg-amber-400 rounded-full animate-bounce" style={{ animationDelay: `${i * 0.15}s` }} />
                ))}
              </div>
            </div>
            <div className="border-t border-slate-50 px-6 py-4 text-center">
              <button onClick={handleCancelPending} className="text-sm text-gray-300 hover:text-red-400 transition-colors">
                출석 취소
              </button>
            </div>
          </div>
        )}

        {/* 승인 완료 화면 */}
        {pageState === 'approved' && student && (
          <div className="bg-white rounded-3xl shadow-[0_4px_20px_rgba(0,0,0,0.07)] overflow-hidden">
            {/* 상태 헤더 */}
            <div className="px-6 pt-8 pb-6 text-center">
              <div className="w-16 h-16 bg-emerald-50 rounded-full flex items-center justify-center mx-auto mb-4">
                <svg className="w-8 h-8 text-emerald-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M5 13l4 4L19 7" />
                </svg>
              </div>
              <p className="text-xs text-gray-400 mb-0.5">{student.name} 학생</p>
              <h2 className="text-2xl font-black text-gray-900 mb-1">출석 완료</h2>
              <p className="text-sm text-gray-400">등원이 확인되었어요. 오늘도 화이팅!</p>
              {(attendance?.approved_at || attendance?.rechecked_in_at) && (
                <p className="text-xs text-gray-300 mt-2">
                  {attendance?.approved_at && `등원 ${new Date(attendance.approved_at).toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit' })}`}
                  {attendance?.rechecked_in_at && ` · 재등원 ${new Date(attendance.rechecked_in_at).toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit' })}`}
                </p>
              )}
            </div>

            {/* 정보 카드 섹션 */}
            {(incompleteItems || !oralQueue || (oralQueue && oralQueue.status === 'waiting') || (attendance?.next_clinic_date && attendance.visit_type === 'clinic')) && (
              <div className="px-4 pb-4 space-y-2.5">
                {/* 미완료 항목 */}
                {incompleteItems && (
                  <button
                    onClick={() => setIncompleteModal(incompleteItems)}
                    className="w-full flex items-center gap-3 bg-orange-50 rounded-2xl px-4 py-4 text-left"
                  >
                    <div className="w-9 h-9 bg-orange-100 rounded-xl flex items-center justify-center flex-shrink-0">
                      <span className="text-orange-500 text-base">⚠</span>
                    </div>
                    <div className="flex-1">
                      <p className="text-sm font-bold text-orange-700">미완료 항목이 있어요</p>
                      <p className="text-xs text-orange-400 mt-0.5">탭해서 확인하기</p>
                    </div>
                    <svg className="w-4 h-4 text-orange-300 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
                    </svg>
                  </button>
                )}

                {/* 대기 등록 */}
                {!oralQueue && (
                  <button
                    onClick={() => setShowQueueTypeModal(true)}
                    className="w-full flex items-center gap-3 bg-violet-50 rounded-2xl px-4 py-4 text-left"
                  >
                    <div className="w-9 h-9 bg-violet-100 rounded-xl flex items-center justify-center flex-shrink-0">
                      <svg className="w-5 h-5 text-violet-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M17 20h5v-2a3 3 0 00-5.356-1.857M17 20H7m10 0v-2c0-.656-.126-1.283-.356-1.857M7 20H2v-2a3 3 0 015.356-1.857M7 20v-2c0-.656.126-1.283.356-1.857m0 0a5.002 5.002 0 019.288 0M15 7a3 3 0 11-6 0 3 3 0 016 0z" />
                      </svg>
                    </div>
                    <p className="text-sm font-bold text-violet-700 flex-1">대기 등록</p>
                    <svg className="w-4 h-4 text-violet-300 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
                    </svg>
                  </button>
                )}

                {/* 대기 현황 */}
                {oralQueue && oralQueue.status === 'waiting' && (
                  <div className={`flex items-center gap-3 rounded-2xl px-4 py-4 ${oralQueue.type === 'homework_check' ? 'bg-pink-50' : 'bg-violet-50'}`}>
                    <div className={`w-9 h-9 rounded-xl flex items-center justify-center flex-shrink-0 ${oralQueue.type === 'homework_check' ? 'bg-pink-100' : 'bg-violet-100'}`}>
                      <span className={`text-sm font-black ${oralQueue.type === 'homework_check' ? 'text-pink-600' : 'text-violet-600'}`}>{queuePosition}</span>
                    </div>
                    <div className="flex-1">
                      <p className={`text-xs mb-0.5 ${oralQueue.type === 'homework_check' ? 'text-pink-400' : 'text-violet-400'}`}>
                        {oralQueue.type === 'homework_check' ? '숙제검사' : '구두'} 대기 중
                      </p>
                      <p className={`text-sm font-bold ${oralQueue.type === 'homework_check' ? 'text-pink-700' : 'text-violet-700'}`}>
                        {queuePosition}번째 차례예요
                      </p>
                    </div>
                    <button onClick={handleLeaveQueue} className="text-xs text-gray-300 hover:text-red-400 transition-colors flex-shrink-0">
                      취소
                    </button>
                  </div>
                )}

                {/* 다음 클리닉 날짜 */}
                {attendance?.next_clinic_date && attendance.visit_type === 'clinic' && (
                  <div className="flex items-center gap-3 bg-sky-50 rounded-2xl px-4 py-4">
                    <div className="w-9 h-9 bg-sky-100 rounded-xl flex items-center justify-center flex-shrink-0">
                      <svg className="w-5 h-5 text-sky-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 7V3m8 4V3m-9 8h10M5 21h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z" />
                      </svg>
                    </div>
                    <div>
                      <p className="text-xs text-sky-400 mb-0.5">다음 클리닉</p>
                      <p className="text-sm font-bold text-sky-700">{attendance.next_clinic_date}</p>
                    </div>
                  </div>
                )}
              </div>
            )}

            {/* 액션 섹션 */}
            <div className="border-t border-slate-50 px-4 pt-4 pb-5 space-y-2.5">
              {!canCheckOut && (
                <p className="text-xs text-center text-gray-400 pb-1">조교 선생님 확인 후 하원할 수 있어요</p>
              )}
              <button
                onClick={handleCheckOut}
                disabled={!canCheckOut}
                className={`w-full py-4 rounded-2xl font-bold text-base transition-colors shadow-sm ${
                  canCheckOut
                    ? 'bg-blue-500 hover:bg-blue-600 text-white'
                    : 'bg-slate-100 text-slate-300 cursor-not-allowed'
                }`}
              >
                하원할게요
              </button>
              {/* 다음에 올게요: next_clinic_date 없을 때 + 하원취소로 인해 class_clinic인데 next_clinic_date만 남은 비정상 상태도 포함 */}
              {(!attendance?.next_clinic_date || (attendance.visit_type === 'class_clinic' && !attendance.checked_out_at)) && (
                <button
                  onClick={() => {
                    if (attendance?.next_clinic_date) setNextClinicDate(attendance.next_clinic_date)
                    setShowNextClinicModal(true)
                  }}
                  className="w-full py-4 rounded-2xl bg-slate-100 hover:bg-slate-200 text-slate-600 font-bold text-sm transition-colors"
                >
                  다음에 올게요
                </button>
              )}
              <div className="text-center pt-1">
                <button onClick={handleReset} className="text-sm text-gray-300 hover:text-gray-500 transition-colors">
                  처음으로
                </button>
              </div>
            </div>
          </div>
        )}

        {/* 하원 완료 화면 */}
        {pageState === 'checked_out' && student && (
          <div className="bg-white rounded-3xl shadow-[0_4px_20px_rgba(0,0,0,0.07)] overflow-hidden">
            <div className="px-6 pt-8 pb-6 text-center">
              <div className="w-16 h-16 bg-indigo-50 rounded-full flex items-center justify-center mx-auto mb-4">
                <svg className="w-8 h-8 text-indigo-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M17 16l4-4m0 0l-4-4m4 4H7m6 4v1a3 3 0 01-3 3H6a3 3 0 01-3-3V7a3 3 0 013-3h4a3 3 0 013 3v1" />
                </svg>
              </div>
              <p className="text-xs text-gray-400 mb-0.5">{student.name} 학생</p>
              <h2 className="text-2xl font-black text-gray-900 mb-1">하원 완료</h2>
              <p className="text-sm text-gray-400">오늘도 수고했어요!</p>
            </div>

            {attendance?.checked_out_at && (
              <div className="mx-4 mb-4 bg-slate-50 rounded-2xl px-4 py-1">
                {attendance.approved_at && (
                  <div className="flex items-center justify-between py-3 border-b border-slate-100">
                    <span className="text-sm text-gray-400">등원</span>
                    <span className="text-sm font-bold text-gray-700">
                      {new Date(attendance.approved_at).toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit' })}
                    </span>
                  </div>
                )}
                {attendance.rechecked_in_at && (
                  <div className="flex items-center justify-between py-3 border-b border-slate-100">
                    <span className="text-sm text-gray-400">재등원</span>
                    <span className="text-sm font-bold text-blue-500">
                      {new Date(attendance.rechecked_in_at).toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit' })}
                    </span>
                  </div>
                )}
                <div className="flex items-center justify-between py-3">
                  <span className="text-sm text-gray-400">하원</span>
                  <span className="text-sm font-bold text-indigo-500">
                    {new Date(attendance.checked_out_at).toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit' })}
                  </span>
                </div>
              </div>
            )}

            <div className="border-t border-slate-50 px-4 pt-4 pb-5 space-y-2.5">
              <button
                onClick={() => setShowReCheckInModal(true)}
                className="w-full py-4 rounded-2xl bg-blue-500 hover:bg-blue-600 text-white font-bold text-base transition-colors shadow-sm"
              >
                재등원
              </button>
              <div className="text-center pt-1">
                <button onClick={handleReset} className="text-sm text-gray-300 hover:text-gray-500 transition-colors">
                  처음으로
                </button>
              </div>
            </div>
          </div>
        )}

        {/* 거절 화면 */}
        {pageState === 'rejected' && student && (
          <div className="bg-white rounded-3xl shadow-[0_4px_20px_rgba(0,0,0,0.07)] overflow-hidden">
            <div className="px-6 pt-8 pb-6 text-center">
              <div className="w-16 h-16 bg-red-50 rounded-full flex items-center justify-center mx-auto mb-4">
                <svg className="w-8 h-8 text-red-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M6 18L18 6M6 6l12 12" />
                </svg>
              </div>
              <p className="text-xs text-gray-400 mb-0.5">{student.name} 학생</p>
              <h2 className="text-2xl font-black text-gray-900 mb-1">출석 거절</h2>
              {attendance?.reject_reason ? (
                <p className="text-sm text-gray-500 mt-1">{attendance.reject_reason}</p>
              ) : (
                <p className="text-sm text-gray-400 mt-1">조교 선생님께 문의해주세요</p>
              )}
            </div>
            <div className="border-t border-slate-50 px-4 pt-4 pb-5">
              <button
                onClick={handleReset}
                className="w-full py-4 rounded-2xl bg-gray-900 hover:bg-gray-800 text-white font-bold text-base transition-colors"
              >
                다시 시도
              </button>
            </div>
          </div>
        )}

        {/* 결석 화면 */}
        {pageState === 'absent' && student && (
          <div className="bg-white rounded-3xl shadow-[0_4px_20px_rgba(0,0,0,0.07)] overflow-hidden">
            <div className="px-6 pt-8 pb-6 text-center">
              <div className="w-16 h-16 bg-gray-100 rounded-full flex items-center justify-center mx-auto mb-4">
                <svg className="w-8 h-8 text-gray-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 7V3m8 4V3m-9 8h10M5 21h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z" />
                </svg>
              </div>
              <p className="text-xs text-gray-400 mb-0.5">{student.name} 학생</p>
              <h2 className="text-2xl font-black text-gray-900 mb-1">결석 처리됨</h2>
              <p className="text-sm text-gray-400 mt-1">오늘은 결석으로 처리되었어요</p>
              <p className="text-sm text-gray-400">문의사항은 조교 선생님께 알려주세요</p>
            </div>
          </div>
        )}
      </div>

      {/* 재등원 확인 모달 — bottom sheet */}
      {showReCheckInModal && (
        <div className="fixed inset-0 bg-black/40 flex items-end justify-center z-50">
          <div className="bg-white rounded-t-3xl w-full max-w-sm shadow-2xl">
            <div className="flex justify-center pt-3 pb-1">
              <div className="w-10 h-1 bg-gray-200 rounded-full" />
            </div>
            <div className="px-5 pt-4 pb-6">
              <h3 className="font-black text-gray-900 text-lg mb-1 text-center">재등원 확인</h3>
              <p className="text-sm text-gray-400 mb-6 text-center">정말 학원에 다시 방문했나요?</p>
              <div className="flex gap-2.5">
                <button
                  onClick={() => setShowReCheckInModal(false)}
                  className="flex-1 py-4 rounded-2xl bg-slate-100 text-sm text-gray-600 font-bold"
                >
                  취소
                </button>
                <button
                  onClick={() => { setShowReCheckInModal(false); handleReCheckIn() }}
                  className="flex-1 py-4 rounded-2xl bg-blue-500 hover:bg-blue-600 text-white text-sm font-bold transition-colors"
                >
                  네, 방문했어요
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* 미완료 항목 모달 — bottom sheet */}
      {incompleteModal && (
        <div className="fixed inset-0 bg-black/40 flex items-end justify-center z-50">
          <div className="bg-white rounded-t-3xl w-full max-w-sm shadow-2xl max-h-[80vh] flex flex-col">
            <div className="flex justify-center pt-3 pb-1 flex-shrink-0">
              <div className="w-10 h-1 bg-gray-200 rounded-full" />
            </div>
            <div className="px-5 pt-4 pb-2 flex-shrink-0">
              <h3 className="font-black text-gray-900 text-lg mb-0.5 text-center">미완료 항목</h3>
              <p className="text-xs text-gray-400 text-center mb-4">아직 완료되지 않은 항목이 있어요</p>
            </div>
            <div className="px-5 overflow-y-auto flex-1 space-y-2.5 pb-2">
              {incompleteModal.map((week) => (
                <div key={week.label} className="bg-orange-50 rounded-2xl p-4">
                  <p className="text-xs font-bold text-orange-500 mb-2">{week.label}</p>
                  <ul className="space-y-1.5">
                    {week.fields.map((f) => (
                      <li key={f} className="text-sm text-gray-700 flex items-center gap-2">
                        <span className="w-1.5 h-1.5 rounded-full bg-orange-400 flex-shrink-0" />
                        {f}
                      </li>
                    ))}
                  </ul>
                </div>
              ))}
            </div>
            <div className="px-5 pt-4 pb-6 flex-shrink-0">
              <button
                onClick={() => setIncompleteModal(null)}
                className="w-full py-4 rounded-2xl bg-gray-900 text-white text-sm font-bold"
              >
                확인했어요
              </button>
            </div>
          </div>
        </div>
      )}

      {/* visit_type 선택 모달 — bottom sheet */}
      {showVisitTypeModal && student && (
        <div className="fixed inset-0 bg-black/40 flex items-end justify-center z-50">
          <div className="bg-white rounded-t-3xl w-full max-w-sm shadow-2xl">
            <div className="flex justify-center pt-3 pb-1">
              <div className="w-10 h-1 bg-gray-200 rounded-full" />
            </div>
            <div className="px-5 pt-4 pb-6">
              <h3 className="font-black text-gray-900 text-lg mb-0.5 text-center">{student.name} 학생</h3>
              <p className="text-sm text-gray-400 text-center mb-6">오늘 방문 목적을 선택해주세요</p>
              <div className="flex flex-col gap-2.5">
                <button
                  onClick={() => handleVisitTypeSelect('class_clinic')}
                  className="py-4 rounded-2xl bg-blue-500 hover:bg-blue-600 text-white font-bold text-base transition-colors shadow-sm"
                >
                  수업 + 클리닉
                </button>
                <button
                  onClick={() => handleVisitTypeSelect('clinic')}
                  className="py-4 rounded-2xl bg-violet-500 hover:bg-violet-600 text-white font-bold text-base transition-colors shadow-sm"
                >
                  클리닉만
                </button>
                <button
                  onClick={() => { setShowVisitTypeModal(false); setStudent(null); setPendingStudentData(null) }}
                  className="py-3 text-sm text-gray-400 font-medium"
                >
                  취소
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* 대기 타입 선택 모달 — bottom sheet */}
      {showQueueTypeModal && (
        <div className="fixed inset-0 bg-black/40 flex items-end justify-center z-50">
          <div className="bg-white rounded-t-3xl w-full max-w-sm shadow-2xl">
            <div className="flex justify-center pt-3 pb-1">
              <div className="w-10 h-1 bg-gray-200 rounded-full" />
            </div>
            <div className="px-5 pt-4 pb-6">
              <h3 className="font-black text-gray-900 text-lg mb-0.5 text-center">대기 등록</h3>
              <p className="text-sm text-gray-400 text-center mb-6">어떤 대기를 등록할까요?</p>
              <div className="flex gap-2.5 mb-2.5">
                <button
                  onClick={() => handleJoinQueue('oral')}
                  className="flex-1 py-5 rounded-2xl bg-violet-500 hover:bg-violet-600 text-white font-bold text-base transition-colors shadow-sm"
                >
                  구두
                </button>
                <button
                  onClick={() => handleJoinQueue('homework_check')}
                  className="flex-1 py-5 rounded-2xl bg-pink-500 hover:bg-pink-600 text-white font-bold text-base transition-colors shadow-sm"
                >
                  숙제검사
                </button>
              </div>
              <button
                onClick={() => setShowQueueTypeModal(false)}
                className="w-full py-3 text-sm text-gray-400 font-medium"
              >
                취소
              </button>
            </div>
          </div>
        </div>
      )}

      {/* 다음에 올게요 모달 — bottom sheet */}
      {showNextClinicModal && (
        <div className="fixed inset-0 bg-black/40 flex items-end justify-center z-50">
          <div className="bg-white rounded-t-3xl w-full max-w-sm shadow-2xl">
            <div className="flex justify-center pt-3 pb-1">
              <div className="w-10 h-1 bg-gray-200 rounded-full" />
            </div>
            <div className="px-5 pt-4 pb-6">
              <h3 className="font-black text-gray-900 text-lg mb-0.5 text-center">다음에 올게요</h3>
              <p className="text-sm text-gray-400 text-center mb-5">다음 클리닉 날짜를 선택해주세요</p>
              <input
                type="date"
                value={nextClinicDate}
                onChange={(e) => setNextClinicDate(e.target.value)}
                min={new Date().toISOString().split('T')[0]}
                className="w-full bg-slate-50 rounded-2xl px-4 py-3.5 text-sm focus:outline-none focus:bg-blue-50 transition-colors mb-3"
              />
              {attendance?.visit_type === 'clinic' && (
                <p className="text-xs text-sky-500 bg-sky-50 rounded-2xl p-3 mb-4">
                  클리닉 학생은 조교 선생님 확인 후 하원 처리돼요
                </p>
              )}
              <div className="flex gap-2.5">
                <button
                  onClick={() => { setShowNextClinicModal(false); setNextClinicDate('') }}
                  className="flex-1 py-4 rounded-2xl bg-slate-100 text-sm text-gray-600 font-bold"
                >
                  취소
                </button>
                <button
                  onClick={handleNextClinic}
                  disabled={!nextClinicDate || nextClinicLoading}
                  className="flex-1 py-4 rounded-2xl bg-blue-500 hover:bg-blue-600 disabled:bg-slate-100 disabled:text-slate-300 text-white text-sm font-bold transition-colors"
                >
                  {nextClinicLoading ? '처리 중...' : '확인'}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* 수업/하원 선택 모달 — bottom sheet */}
      {showNextClinicActionModal && (
        <div className="fixed inset-0 bg-black/40 flex items-end justify-center z-50">
          <div className="bg-white rounded-t-3xl w-full max-w-sm shadow-2xl">
            <div className="flex justify-center pt-3 pb-1">
              <div className="w-10 h-1 bg-gray-200 rounded-full" />
            </div>
            <div className="px-5 pt-4 pb-6">
              <h3 className="font-black text-gray-900 text-lg mb-0.5 text-center">오늘 어떻게 하실 건가요?</h3>
              <p className="text-sm text-gray-400 text-center mb-6">클리닉 날짜가 저장되었어요</p>
              <div className="flex gap-2.5">
                <button
                  onClick={() => setShowNextClinicActionModal(false)}
                  className="flex-1 py-5 rounded-2xl bg-blue-50 hover:bg-blue-100 text-blue-600 font-bold text-base transition-colors"
                >
                  수업있어요
                </button>
                <button
                  onClick={handleNextClinicCheckOut}
                  className="flex-1 py-5 rounded-2xl bg-gray-900 hover:bg-gray-800 text-white font-bold text-base transition-colors"
                >
                  하원할게요
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* 구두 호출 모달 — bottom sheet */}
      {showCalledModal && student && (
        <div className="fixed inset-0 bg-black/40 flex items-end justify-center z-50">
          <div className="bg-white rounded-t-3xl w-full max-w-sm shadow-2xl">
            <div className="flex justify-center pt-3 pb-1">
              <div className="w-10 h-1 bg-gray-200 rounded-full" />
            </div>
            <div className="px-5 pt-4 pb-6 text-center">
              <div className="w-16 h-16 bg-violet-50 rounded-full flex items-center justify-center mx-auto mb-4 animate-pulse">
                <svg className="w-8 h-8 text-violet-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 17h5l-1.405-1.405A2.032 2.032 0 0118 14.158V11a6.002 6.002 0 00-4-5.659V5a2 2 0 10-4 0v.341C7.67 6.165 6 8.388 6 11v3.159c0 .538-.214 1.055-.595 1.436L4 17h5m6 0v1a3 3 0 11-6 0v-1m6 0H9" />
                </svg>
              </div>
              <p className="text-xs text-gray-400 mb-0.5">{student.name} 학생</p>
              <p className="text-2xl font-black text-violet-600 mb-2">지금 오세요!</p>
              {oralQueue?.caller ? (
                <p className="text-sm text-gray-400 mb-6">
                  <span className="font-bold text-violet-700">{oralQueue.caller}</span> 님이 호출했어요<br />조교님께 가주세요
                </p>
              ) : (
                <p className="text-sm text-gray-400 mb-6">구두 테스트 차례예요<br />조교 선생님께 가주세요</p>
              )}
              <button
                onClick={() => setShowCalledModal(false)}
                className="w-full bg-violet-500 hover:bg-violet-600 text-white font-bold py-4 rounded-2xl transition-colors shadow-sm"
              >
                확인
              </button>
            </div>
          </div>
        </div>
      )}

      {/* 홈화면 추가 버튼 */}
      {!isStandalone && (
        <div className="fixed bottom-4 left-1/2 -translate-x-1/2 z-40">
          <button
            onClick={installPrompt ? handleAttendInstall : isIos ? () => setShowIosGuide(true) : () => setShowAndroidGuide(true)}
            className="text-xs text-gray-400 hover:text-gray-600 px-4 py-2 rounded-full border border-gray-200 bg-white/90 backdrop-blur-sm transition-colors whitespace-nowrap shadow-sm"
          >
            + 홈화면에 추가
          </button>
        </div>
      )}
    </div>
  )
}
