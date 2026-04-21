import { useState, useRef, useEffect } from 'react'
import { supabase } from '../lib/supabase'
import type { AttendanceWithStudent } from '../lib/database.types'
import { useManifest } from '../hooks/useManifest'

interface BeforeInstallPromptEvent extends Event {
  prompt: () => Promise<void>
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>
}

function getToday() {
  return new Date().toLocaleDateString('sv-SE', { timeZone: 'Asia/Seoul' })
}

function formatTime(iso: string | null) {
  if (!iso) return null
  return new Date(iso).toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Seoul' })
}

function formatDateShort(dateStr: string) {
  const [y, m, d] = dateStr.split('-').map(Number)
  const date = new Date(y, m - 1, d)
  const days = ['일', '월', '화', '수', '목', '금', '토']
  return `${m}/${d}(${days[date.getDay()]})`
}

function getWeekLabel(dateStr: string) {
  const [y, m, d] = dateStr.split('-').map(Number)
  const date = new Date(y, m - 1, d)
  const day = date.getDay()
  const diff = day === 0 ? -6 : 1 - day
  const mon = new Date(y, m - 1, d + diff)
  const fri = new Date(y, m - 1, d + diff + 4)
  return `${mon.getMonth() + 1}/${mon.getDate()}~${fri.getMonth() + 1}/${fri.getDate()}`
}

function groupByWeek(records: AttendanceWithStudent[]) {
  const map = new Map<string, AttendanceWithStudent[]>()
  for (const r of records) {
    const label = getWeekLabel(r.date)
    if (!map.has(label)) map.set(label, [])
    map.get(label)!.push(r)
  }
  return Array.from(map.entries()).map(([label, records]) => ({ label, records }))
}

const STATUS_LABEL: Record<string, string> = {
  pass: 'Pass', fail: 'Fail', delay: 'Delay',
  word_pass: '단어 Pass', sentence_pass: '문장 Pass',
  partial_pass: '일부 Pass', exempt: '면제',
}

const STATUS_COLOR: Record<string, string> = {
  pass: 'text-green-600',
  fail: 'text-red-500',
  partial_pass: 'text-orange-500',
  delay: 'text-yellow-600',
  word_pass: 'text-blue-500',
  sentence_pass: 'text-blue-500',
  exempt: 'text-gray-400',
}

function urlBase64ToUint8Array(base64String: string) {
  const padding = '='.repeat((4 - (base64String.length % 4)) % 4)
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/')
  const rawData = atob(base64)
  return Uint8Array.from([...rawData].map(c => c.charCodeAt(0)))
}

// 주차 히스토리 카드
function WeekCard({ label, records }: { label: string; records: AttendanceWithStudent[] }) {
  const [open, setOpen] = useState(false)
  return (
    <div className="bg-white rounded-2xl border border-gray-100 overflow-hidden">
      <button
        onClick={() => setOpen(!open)}
        className="w-full px-5 py-3.5 flex items-center justify-between hover:bg-gray-50 transition-colors"
      >
        <span className="text-sm font-bold text-gray-700">{label}</span>
        <div className="flex items-center gap-2">
          <span className="text-xs text-gray-400">{records.length}회</span>
          <span className="text-xs text-gray-400">{open ? '▲' : '▼'}</span>
        </div>
      </button>
      {open && (
        <div className="border-t border-gray-100 divide-y divide-gray-50">
          {records.map(r => (
            <div key={r.id} className="px-5 py-4 space-y-2.5">
              {/* 날짜 + 구분 */}
              <div className="flex items-center gap-2">
                <span className="text-sm font-bold text-gray-800">{formatDateShort(r.date)}</span>
                <span className={`text-xs px-2 py-0.5 rounded-full font-medium
                  ${r.visit_type === 'class_clinic' ? 'bg-green-100 text-green-700' : 'bg-blue-100 text-blue-700'}`}>
                  {r.visit_type === 'class_clinic' ? '수업+클리닉' : '클리닉'}
                </span>
              </div>
              {/* 점수 + 상태 */}
              <div className="grid grid-cols-2 gap-x-6 gap-y-1.5">
                {r.word_score && (
                  <div className="flex items-center gap-1.5">
                    <span className="text-xs text-gray-400">단어</span>
                    <span className="text-xs font-semibold text-gray-700">{r.word_score}</span>
                  </div>
                )}
                {r.clinic_score && (
                  <div className="flex items-center gap-1.5">
                    <span className="text-xs text-gray-400">클리닉</span>
                    <span className="text-xs font-semibold text-gray-700">{r.clinic_score}</span>
                  </div>
                )}
                {r.oral_status && (
                  <div className="flex items-center gap-1.5">
                    <span className="text-xs text-gray-400">구두</span>
                    <span className={`text-xs font-semibold ${STATUS_COLOR[r.oral_status] ?? 'text-gray-600'}`}>
                      {STATUS_LABEL[r.oral_status] ?? r.oral_status}
                    </span>
                  </div>
                )}
                {r.homework && (
                  <div className="flex items-center gap-1.5">
                    <span className="text-xs text-gray-400">과제</span>
                    <span className={`text-xs font-semibold ${STATUS_COLOR[r.homework] ?? 'text-gray-600'}`}>
                      {STATUS_LABEL[r.homework] ?? r.homework}
                    </span>
                  </div>
                )}
              </div>
              {/* 직보 점수 */}
              {r.jikbo_score && (
                <div className="flex items-center gap-1.5">
                  <span className="text-xs text-gray-400">직보</span>
                  <span className="text-xs font-semibold text-amber-600">{r.jikbo_score}</span>
                </div>
              )}
              {/* 부모님 알림장 */}
              {r.parent_memo && (
                <p className="text-xs text-gray-600 leading-relaxed bg-green-50 rounded-xl px-3 py-2 whitespace-pre-wrap">{r.parent_memo}</p>
              )}
              {/* 재등원 예정 */}
              {r.next_clinic_date && (
                <div className="flex items-center gap-1.5">
                  <span className="text-xs text-indigo-400 font-medium">재등원 예정</span>
                  <span className="text-xs font-semibold text-indigo-600">{r.next_clinic_date}</span>
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

export default function ParentsPage() {
  useManifest('/manifest-parents.webmanifest')

  const [digits, setDigits] = useState(['', '', '', ''])
  const [loading, setLoading] = useState(false)
  const [record, setRecord] = useState<AttendanceWithStudent | null | 'notfound'>(null)
  const [error, setError] = useState('')
  const [savedStudentId, setSavedStudentId] = useState<string | null>(null)
  const [savedStudentName, setSavedStudentName] = useState('')

  // 히스토리
  const [historyRecords, setHistoryRecords] = useState<AttendanceWithStudent[]>([])
  const [showHistory, setShowHistory] = useState(false)

  // PWA 설치 프롬프트
  const [installPrompt, setInstallPrompt] = useState<BeforeInstallPromptEvent | null>(null)
  const [showIosGuide, setShowIosGuide] = useState(false)
  const [showAndroidGuide, setShowAndroidGuide] = useState(false)
  const [installBannerDismissed, setInstallBannerDismissed] = useState(false)
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
      if (!localStorage.getItem('pwa-install-dismissed')) setShowIosGuide(true)
    } else {
      const handler = (e: Event) => { e.preventDefault(); setInstallPrompt(e as BeforeInstallPromptEvent) }
      window.addEventListener('beforeinstallprompt', handler)
      return () => window.removeEventListener('beforeinstallprompt', handler)
    }
  }, [])

  // 저장된 코드 자동 로드
  useEffect(() => {
    const saved = localStorage.getItem('parents-student-code')
    if (saved && saved.length === 4) {
      setDigits(saved.split(''))
      submitCode(saved)
    }
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  function dismissInstallBanner() {
    localStorage.setItem('pwa-install-dismissed', '1')
    setInstallPrompt(null)
    setShowIosGuide(false)
    setInstallBannerDismissed(true)
  }

  async function handleInstall() {
    if (!installPrompt) return
    await installPrompt.prompt()
    const { outcome } = await installPrompt.userChoice
    if (outcome === 'accepted') localStorage.setItem('pwa-install-dismissed', '1')
    setInstallPrompt(null)
  }

  const inputRefs = [
    useRef<HTMLInputElement>(null),
    useRef<HTMLInputElement>(null),
    useRef<HTMLInputElement>(null),
    useRef<HTMLInputElement>(null),
  ]

  function handleDigit(idx: number, val: string) {
    const v = val.replace(/\D/g, '').slice(-1)
    const next = [...digits]
    next[idx] = v
    setDigits(next)
    if (v && idx < 3) inputRefs[idx + 1].current?.focus()
    if (!v && idx > 0) inputRefs[idx - 1].current?.focus()
  }

  function handleKeyDown(idx: number, e: React.KeyboardEvent) {
    if (e.key === 'Backspace' && !digits[idx] && idx > 0) {
      inputRefs[idx - 1].current?.focus()
    }
  }

  async function submitCode(code: string) {
    if (code.length < 4) { setError('4자리를 모두 입력해주세요'); return }
    setError('')
    setLoading(true)
    setRecord(null)
    setHistoryRecords([])
    setShowHistory(false)

    const { data: student } = await supabase
      .from('students')
      .select('*')
      .eq('code', code)
      .maybeSingle()

    if (!student) {
      setLoading(false)
      setRecord('notfound')
      return
    }

    // 코드 저장 + push 구독
    localStorage.setItem('parents-student-code', code)
    setSavedStudentId(student.id)
    setSavedStudentName(student.name)
    subscribePush(student.id)

    const today = getToday()

    // 오늘 기록 + 전체 히스토리 병렬 조회
    const [{ data: att }, { data: history }] = await Promise.all([
      supabase
        .from('attendances')
        .select('*, students(*)')
        .eq('student_id', student.id)
        .eq('date', today)
        .eq('status', 'approved')
        .order('checked_in_at', { ascending: false })
        .limit(1)
        .maybeSingle(),
      supabase
        .from('attendances')
        .select('*, students(*)')
        .eq('student_id', student.id)
        .eq('status', 'approved')
        .neq('date', today)
        .order('date', { ascending: false }),
    ])

    setLoading(false)
    setRecord(att ?? 'notfound')
    setHistoryRecords(history ?? [])
  }

  async function handleSubmit() {
    await submitCode(digits.join(''))
  }

  async function subscribePush(studentId: string) {
    try {
      if (!('serviceWorker' in navigator) || !('PushManager' in window)) return
      const reg = await navigator.serviceWorker.ready
      const permission = await Notification.requestPermission()
      if (permission !== 'granted') return
      const existing = await reg.pushManager.getSubscription()
      if (existing) await existing.unsubscribe()
      const vapidKey = import.meta.env.VITE_VAPID_PUBLIC_KEY
      if (!vapidKey) return
      const sub = await reg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(vapidKey),
      })
      await supabase.from('students').update({
        parent_push_subscription: sub.toJSON(),
      }).eq('id', studentId)
    } catch (e) {
      console.warn('parent push subscribe failed', e)
    }
  }

  // 학생코드 입력 (저장 초기화)
  function handleChangeCode() {
    localStorage.removeItem('parents-student-code')
    setSavedStudentId(null)
    setSavedStudentName('')
    setDigits(['', '', '', ''])
    setRecord(null)
    setHistoryRecords([])
    setShowHistory(false)
    setError('')
    setTimeout(() => inputRefs[0].current?.focus(), 50)
  }

  const today = new Date().toLocaleDateString('ko-KR', {
    timeZone: 'Asia/Seoul', year: 'numeric', month: 'long', day: 'numeric', weekday: 'long'
  })

  const weekGroups = groupByWeek(historyRecords)

  return (
    <div className="min-h-[100svh] bg-gradient-to-br from-blue-50 via-white to-indigo-50 flex flex-col items-center px-4 py-6" style={{ justifyContent: record && record !== 'notfound' ? 'flex-start' : 'center' }}>

      {/* Android 설치 배너 */}
      {installPrompt && !installBannerDismissed && (
        <div className="fixed bottom-0 left-0 right-0 z-50 p-4">
          <div className="bg-white rounded-2xl shadow-2xl border border-blue-100 p-4 flex items-center gap-3 max-w-sm mx-auto">
            <div className="w-12 h-12 rounded-xl bg-blue-600 flex items-center justify-center flex-shrink-0 text-white font-bold text-lg">최</div>
            <div className="flex-1 min-w-0">
              <p className="text-sm font-bold text-gray-800">홈 화면에 추가</p>
              <p className="text-xs text-gray-400">앱처럼 빠르게 열 수 있어요</p>
            </div>
            <div className="flex gap-2 flex-shrink-0">
              <button onClick={dismissInstallBanner} className="text-xs text-gray-400 px-2 py-1.5">나중에</button>
              <button onClick={handleInstall} className="text-xs bg-blue-600 text-white font-semibold px-3 py-1.5 rounded-xl">추가</button>
            </div>
          </div>
        </div>
      )}

      {/* Android 설치 안내 (installPrompt 없을 때) */}
      {showAndroidGuide && (
        <div className="fixed inset-0 z-50 flex items-end justify-center p-4 bg-black/30" onClick={() => setShowAndroidGuide(false)}>
          <div className="bg-white rounded-2xl shadow-2xl border border-blue-100 p-5 w-full max-w-sm" onClick={e => e.stopPropagation()}>
            <div className="flex items-center justify-between mb-3">
              <p className="text-sm font-bold text-gray-800">홈 화면에 추가하기</p>
              <button onClick={() => setShowAndroidGuide(false)} className="text-gray-400 text-lg leading-none">✕</button>
            </div>
            <p className="text-xs text-gray-500 leading-relaxed">
              브라우저 상단의 <span className="font-semibold text-gray-700">⋮ 메뉴</span>를 누른 후<br/>
              <span className="font-semibold text-gray-700">"홈 화면에 추가"</span>를 선택해주세요
            </p>
          </div>
        </div>
      )}

      {/* iOS 설치 안내 배너 */}
      {showIosGuide && !installBannerDismissed && (
        <div className="fixed bottom-0 left-0 right-0 z-50 p-4">
          <div className="bg-white rounded-2xl shadow-2xl border border-blue-100 p-4 max-w-sm mx-auto">
            <div className="flex items-center justify-between mb-2">
              <p className="text-sm font-bold text-gray-800">홈 화면에 추가하기</p>
              <button onClick={dismissInstallBanner} className="text-gray-400 text-lg leading-none">✕</button>
            </div>
            <p className="text-xs text-gray-500 leading-relaxed">
              하단의 <span className="inline-flex items-center gap-0.5 text-blue-500 font-semibold">공유</span> 버튼을 누른 후<br/>
              <span className="font-semibold text-gray-700">"홈 화면에 추가"</span>를 선택해주세요
            </p>
          </div>
        </div>
      )}

      {/* 로고 — 결과 카드 없을 때만 표시 */}
      {!(record && record !== 'notfound') && (
        <div className="mb-8 text-center">
          <div className="inline-flex items-center justify-center w-16 h-16 rounded-2xl bg-blue-600 shadow-lg mb-4">
            <svg className="w-9 h-9 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 6.253v13m0-13C10.832 5.477 9.246 5 7.5 5S4.168 5.477 3 6.253v13C4.168 18.477 5.754 18 7.5 18s3.332.477 4.5 1.253m0-13C13.168 5.477 14.754 5 16.5 5c1.746 0 3.332.477 4.5 1.253v13C19.832 18.477 18.246 18 16.5 18c-1.746 0-3.332.477-4.5 1.253" />
            </svg>
          </div>
          <h1 className="text-2xl font-bold text-gray-900">최선패스</h1>
          <p className="text-sm text-gray-400 mt-1">학부모 알림장</p>
        </div>
      )}

      {/* 로딩 */}
      {loading && (
        <div className="flex flex-col items-center gap-3 py-10">
          <svg className="animate-spin w-8 h-8 text-blue-500" fill="none" viewBox="0 0 24 24">
            <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"/>
            <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8z"/>
          </svg>
          <p className="text-sm text-gray-400">불러오는 중...</p>
        </div>
      )}

      {!loading && !record && (
        /* 코드 입력 카드 */
        <div className="w-full max-w-sm bg-white rounded-3xl shadow-xl p-8">
          <h2 className="text-lg font-bold text-gray-800 text-center mb-1">오늘 수업 확인</h2>
          <p className="text-sm text-gray-400 text-center mb-8">{today}</p>
          <p className="text-sm font-medium text-gray-600 text-center mb-4">학생 코드 4자리를 입력해주세요</p>
          <div className="flex gap-3 justify-center mb-6">
            {digits.map((d, i) => (
              <input
                key={i}
                ref={inputRefs[i]}
                type="tel"
                inputMode="numeric"
                maxLength={1}
                value={d}
                onChange={e => handleDigit(i, e.target.value)}
                onKeyDown={e => handleKeyDown(i, e)}
                autoFocus={i === 0}
                className={`w-14 h-16 text-center text-2xl font-bold rounded-2xl border-2 outline-none transition-all
                  ${d ? 'border-blue-500 bg-blue-50 text-blue-700' : 'border-gray-200 text-gray-800'}
                  focus:border-blue-500 focus:bg-blue-50`}
              />
            ))}
          </div>
          {error && <p className="text-red-400 text-sm text-center mb-4">{error}</p>}
          <button
            onClick={handleSubmit}
            disabled={loading || digits.join('').length < 4}
            className="w-full py-4 rounded-2xl bg-blue-600 hover:bg-blue-700 disabled:bg-gray-200 disabled:text-gray-400 text-white font-bold text-base transition-all shadow-md active:scale-95"
          >
            확인하기
          </button>
        </div>
      )}

      {!loading && record === 'notfound' && (
        /* 결과 없음 */
        <div className="w-full max-w-sm space-y-3">
          <div className="bg-white rounded-3xl shadow-xl p-8 text-center">
            <div className="w-16 h-16 rounded-full bg-gray-100 flex items-center justify-center mx-auto mb-4">
              <svg className="w-8 h-8 text-gray-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9.172 16.172a4 4 0 015.656 0M9 10h.01M15 10h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
              </svg>
            </div>
            <h3 className="font-bold text-gray-800 mb-2">오늘 수업 기록이 없어요</h3>
            <p className="text-sm text-gray-400 mb-6">수업이 끝난 후 다시 확인해주세요</p>
            {savedStudentId && (
              <button onClick={() => submitCode(localStorage.getItem('parents-student-code') ?? '')} className="w-full py-3 rounded-2xl bg-blue-50 text-blue-600 font-semibold text-sm hover:bg-blue-100 transition-colors mb-3">
                새로고침
              </button>
            )}
            {historyRecords.length > 0 && (
              <button
                onClick={() => setShowHistory(true)}
                className="w-full py-3 rounded-2xl border-2 border-gray-100 text-gray-500 text-sm font-medium hover:bg-gray-50 transition-colors mb-3 flex items-center justify-center gap-1.5"
              >
                <span>📋 지난 기록</span>
                <span className="text-gray-400 text-xs">({historyRecords.length}건)</span>
              </button>
            )}
            <button onClick={handleChangeCode} className="w-full py-3 rounded-2xl border-2 border-gray-200 text-gray-500 font-semibold text-sm hover:bg-gray-50 transition-colors">
              학생코드 입력
            </button>
          </div>

        </div>
      )}

      {!loading && record && record !== 'notfound' && (
        <div className="w-full max-w-sm min-h-[calc(100svh-3rem)] flex flex-col">
          {/* 컴팩트 헤더 — 이름 + 날짜 + 등하원 */}
          <div className="bg-blue-600 rounded-3xl px-5 py-5 text-white shadow-lg shadow-blue-200/50">
            <div className="flex items-center gap-3 mb-4">
              <div className="w-10 h-10 rounded-full bg-white/20 flex items-center justify-center text-base font-bold flex-shrink-0">
                {record.students.name[0]}
              </div>
              <div>
                <h2 className="text-base font-bold leading-tight">{record.students.name} 학생</h2>
                <p className="text-blue-200 text-xs">{today}</p>
              </div>
            </div>
            <div className={`grid gap-2 ${record.rechecked_in_at ? 'grid-cols-3' : 'grid-cols-2'}`}>
              <div className="bg-white/15 rounded-2xl min-h-[92px] px-2 py-3 text-center flex flex-col justify-center">
                <p className="text-blue-200 text-[10px] font-semibold">등원</p>
                <p className="text-sm font-bold mt-0.5">{formatTime(record.approved_at) ?? '-'}</p>
              </div>
              {record.rechecked_in_at && (
                <div className="bg-white/15 rounded-2xl min-h-[92px] px-2 py-3 text-center flex flex-col justify-center">
                  <p className="text-blue-200 text-[10px] font-semibold">재등원</p>
                  <p className="text-sm font-bold mt-0.5">{formatTime(record.rechecked_in_at)}</p>
                </div>
              )}
              <div className="bg-white/15 rounded-2xl min-h-[92px] px-2 py-3 text-center flex flex-col justify-center">
                <p className="text-blue-200 text-[10px] font-semibold">하원</p>
                <p className={`text-sm font-bold mt-0.5 ${!record.checked_out_at ? 'text-blue-200' : ''}`}>
                  {formatTime(record.checked_out_at) ?? '수업 중'}
                </p>
              </div>
            </div>
          </div>

          {/* 학습 결과 — 2×2 그리드 */}
          <div className="flex-1 flex flex-col justify-center gap-3 py-3">
            <div className="bg-white rounded-3xl px-4 py-4 shadow-sm">
            <p className="text-[10px] font-bold text-gray-400 uppercase tracking-wide mb-2">학습 결과</p>
            <div className="grid grid-cols-2 gap-2.5">
              {[
                { label: '단어',   value: record.word_score, icon: '📖',
                  cls: 'bg-blue-50 text-blue-700' },
                { label: '클리닉', value: record.clinic_score, icon: '📝',
                  cls: 'bg-indigo-50 text-indigo-700' },
                { label: '구두',   value: record.oral_status ? (STATUS_LABEL[record.oral_status] ?? record.oral_status) : null, icon: '🗣️',
                  cls: record.oral_status === 'pass' ? 'bg-green-100 text-green-700' : record.oral_status === 'fail' ? 'bg-red-100 text-red-600' : 'bg-yellow-100 text-yellow-700' },
                { label: '과제',   value: record.homework ? (STATUS_LABEL[record.homework] ?? record.homework) : null, icon: '✏️',
                  cls: record.homework === 'pass' ? 'bg-green-100 text-green-700' : record.homework === 'fail' ? 'bg-red-100 text-red-600' : record.homework === 'partial_pass' ? 'bg-orange-100 text-orange-600' : 'bg-yellow-100 text-yellow-700' },
              ].map(({ label, value, icon, cls }) => (
                <div key={label} className="flex items-center justify-between bg-gray-50 rounded-2xl px-3 py-3 min-h-[82px]">
                  <div className="flex items-center gap-1.5">
                    <span className="text-sm">{icon}</span>
                    <span className="text-xs font-medium text-gray-500">{label}</span>
                  </div>
                  {value
                    ? <span className={`text-xs font-bold px-2.5 py-1 rounded-full ${cls}`}>{value}</span>
                    : <span className="text-xs text-gray-300">-</span>}
                </div>
              ))}
            </div>
          </div>

          {/* 직보 + 알림장 */}
          {(record.jikbo_score || record.parent_memo) && (
            <div className="bg-white rounded-3xl px-4 py-4 shadow-sm space-y-3">
              {record.jikbo_score && (
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-1.5">
                    <span className="text-sm">📋</span>
                    <span className="text-xs font-medium text-gray-500">직보</span>
                  </div>
                  <span className="text-xs font-bold px-2.5 py-1 rounded-full bg-amber-50 text-amber-700">{record.jikbo_score}</span>
                </div>
              )}
              {record.parent_memo && (
                <div className="bg-green-50 rounded-2xl px-3 py-3">
                  <p className="text-[10px] text-green-600 font-semibold mb-1">👨‍👩‍👧 알림장</p>
                  <p className="text-sm text-gray-700 leading-relaxed whitespace-pre-wrap">{record.parent_memo}</p>
                </div>
              )}
            </div>
          )}

          {/* 재등원 예정 */}
          {record.next_clinic_date && (
            <div className="bg-indigo-50 rounded-3xl px-4 py-3.5 flex items-center gap-3 shadow-sm">
              <span className="text-lg">📅</span>
              <div>
                <p className="text-[10px] text-indigo-400 font-semibold">재등원 예정</p>
                <p className="text-sm font-bold text-indigo-700">{record.next_clinic_date}</p>
              </div>
            </div>
          )}

          {/* 하단 버튼 */}
          </div>

          <div className={`grid gap-2 pt-2 pb-1 ${historyRecords.length > 0 ? 'grid-cols-2' : 'grid-cols-1'}`}>
            {historyRecords.length > 0 && (
              <button
                onClick={() => setShowHistory(true)}
                className="py-3.5 rounded-2xl border border-gray-200 bg-white text-gray-500 text-xs font-medium hover:bg-gray-50 transition-colors flex items-center justify-center gap-1 shadow-sm"
              >
                📋 지난 기록 <span className="text-gray-400">({historyRecords.length}건)</span>
              </button>
            )}
            <button
              onClick={handleChangeCode}
              className="py-3.5 rounded-2xl border border-gray-200 bg-white text-gray-400 text-xs font-medium hover:bg-gray-50 transition-colors shadow-sm"
            >
              학생코드 입력
            </button>
          </div>
        </div>
      )}

      {/* 지난 기록 Bottom Sheet */}
      {showHistory && (
        <div className="fixed inset-0 z-50 flex flex-col justify-end">
          <style>{`
            @keyframes slideUp {
              from { transform: translateY(100%); }
              to   { transform: translateY(0); }
            }
            .history-sheet { animation: slideUp 0.3s cubic-bezier(0.32, 0.72, 0, 1) forwards; }
          `}</style>
          {/* 배경 오버레이 */}
          <div className="absolute inset-0 bg-black/40" onClick={() => setShowHistory(false)} />
          {/* 시트 */}
          <div className="history-sheet relative bg-white rounded-t-3xl flex flex-col" style={{ maxHeight: '85vh' }}>
            {/* 드래그 핸들 */}
            <div className="flex justify-center pt-3 pb-1 flex-shrink-0">
              <div className="w-10 h-1 rounded-full bg-gray-200" />
            </div>
            {/* 헤더 */}
            <div className="flex items-center justify-between px-5 py-3 border-b border-gray-100 flex-shrink-0">
              <div>
                <h3 className="text-base font-bold text-gray-800">{savedStudentName} 학생</h3>
                <p className="text-xs text-gray-400">전체 {historyRecords.length}건</p>
              </div>
              <button
                onClick={() => setShowHistory(false)}
                className="w-8 h-8 rounded-full bg-gray-100 flex items-center justify-center text-gray-500 hover:bg-gray-200 transition-colors text-sm"
              >
                ✕
              </button>
            </div>
            {/* 스크롤 컨텐츠 */}
            <div className="overflow-y-auto flex-1 p-4 space-y-2 pb-10">
              {weekGroups.map(({ label, records }) => (
                <WeekCard key={label} label={label} records={records} />
              ))}
            </div>
          </div>
        </div>
      )}

      {/* 홈화면 추가 버튼 - standalone이 아닐 때 항상 표시 */}
      {!isStandalone && (
        <div className="fixed bottom-2 left-1/2 -translate-x-1/2 z-40">
          <button
            onClick={installPrompt ? handleInstall : isIos ? () => setShowIosGuide(true) : () => setShowAndroidGuide(true)}
            className="text-xs text-gray-400 hover:text-gray-600 px-3 py-1.5 rounded-full border border-gray-200 bg-white/80 backdrop-blur-sm transition-colors whitespace-nowrap"
          >
            + 홈화면에 추가
          </button>
        </div>
      )}
    </div>
  )
}
