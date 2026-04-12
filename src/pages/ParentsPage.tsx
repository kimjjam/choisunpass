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

const STATUS_LABEL: Record<string, string> = {
  pass: 'Pass', fail: 'Fail', delay: 'Delay',
  word_pass: '단어 Pass', sentence_pass: '문장 Pass',
  partial_pass: '일부 Pass', exempt: '면제',
}

function urlBase64ToUint8Array(base64String: string) {
  const padding = '='.repeat((4 - (base64String.length % 4)) % 4)
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/')
  const rawData = atob(base64)
  return Uint8Array.from([...rawData].map(c => c.charCodeAt(0)))
}

export default function ParentsPage() {
  useManifest('/manifest-parents.webmanifest')

  const [digits, setDigits] = useState(['', '', '', ''])
  const [loading, setLoading] = useState(false)
  const [record, setRecord] = useState<AttendanceWithStudent | null | 'notfound'>(null)
  const [error, setError] = useState('')
  const [savedStudentId, setSavedStudentId] = useState<string | null>(null)

  // PWA 설치 프롬프트
  const [installPrompt, setInstallPrompt] = useState<BeforeInstallPromptEvent | null>(null)
  const [showIosGuide, setShowIosGuide] = useState(false)
  const [installBannerDismissed, setInstallBannerDismissed] = useState(false)
  const [isStandalone, setIsStandalone] = useState(false)

  useEffect(() => {
    const standalone = window.matchMedia('(display-mode: standalone)').matches
      || (window.navigator as Navigator & { standalone?: boolean }).standalone === true
    setIsStandalone(standalone)
    if (standalone) return
    const ios = /iphone|ipad|ipod/i.test(navigator.userAgent)
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
    subscribePush(student.id)

    const today = getToday()
    const { data: att } = await supabase
      .from('attendances')
      .select('*, students(*)')
      .eq('student_id', student.id)
      .eq('date', today)
      .eq('status', 'approved')
      .order('checked_in_at', { ascending: false })
      .limit(1)
      .maybeSingle()

    setLoading(false)
    setRecord(att ?? 'notfound')
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
    setDigits(['', '', '', ''])
    setRecord(null)
    setError('')
    setTimeout(() => inputRefs[0].current?.focus(), 50)
  }

  const today = new Date().toLocaleDateString('ko-KR', {
    timeZone: 'Asia/Seoul', year: 'numeric', month: 'long', day: 'numeric', weekday: 'long'
  })

  return (
    <div className="min-h-screen bg-gradient-to-br from-blue-50 via-white to-indigo-50 flex flex-col items-center justify-center px-4 py-10">

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

      {/* 로고 */}
      <div className="mb-8 text-center">
        <div className="inline-flex items-center justify-center w-16 h-16 rounded-2xl bg-blue-600 shadow-lg mb-4">
          <svg className="w-9 h-9 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 6.253v13m0-13C10.832 5.477 9.246 5 7.5 5S4.168 5.477 3 6.253v13C4.168 18.477 5.754 18 7.5 18s3.332.477 4.5 1.253m0-13C13.168 5.477 14.754 5 16.5 5c1.746 0 3.332.477 4.5 1.253v13C19.832 18.477 18.246 18 16.5 18c-1.746 0-3.332.477-4.5 1.253" />
          </svg>
        </div>
        <h1 className="text-2xl font-bold text-gray-900">최선패스</h1>
        <p className="text-sm text-gray-400 mt-1">학부모 알림장</p>
      </div>

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
        <div className="w-full max-w-sm bg-white rounded-3xl shadow-xl p-8 text-center">
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
          <button onClick={handleChangeCode} className="w-full py-3 rounded-2xl border-2 border-gray-200 text-gray-500 font-semibold text-sm hover:bg-gray-50 transition-colors">
            학생코드 입력
          </button>
        </div>
      )}

      {!loading && record && record !== 'notfound' && (
        /* 알림장 카드 */
        <div className="w-full max-w-sm">
          <div className="bg-blue-600 rounded-t-3xl px-6 pt-7 pb-10 text-white text-center relative overflow-hidden">
            <div className="absolute inset-0 opacity-10">
              <div className="absolute -top-4 -right-4 w-32 h-32 rounded-full bg-white"/>
              <div className="absolute -bottom-6 -left-6 w-40 h-40 rounded-full bg-white"/>
            </div>
            <div className="relative">
              <div className="inline-flex items-center justify-center w-14 h-14 rounded-full bg-white/20 mb-3 text-2xl font-bold">
                {record.students.name[0]}
              </div>
              <h2 className="text-xl font-bold">{record.students.name} 학생</h2>
              <p className="text-blue-200 text-sm mt-1">{today}</p>
            </div>
          </div>

          <div className="bg-white rounded-b-3xl shadow-xl -mt-4 pt-6 pb-8 px-6 space-y-5">

            {/* 등하원 시간 */}
            <div className={`grid gap-3 ${record.rechecked_in_at ? 'grid-cols-3' : 'grid-cols-2'}`}>
              <div className="bg-green-50 rounded-2xl p-4 text-center">
                <p className="text-xs text-green-500 font-semibold mb-1">등원</p>
                <p className="text-lg font-bold text-green-700">{formatTime(record.approved_at) ?? '-'}</p>
              </div>
              {record.rechecked_in_at && (
                <div className="bg-blue-50 rounded-2xl p-4 text-center">
                  <p className="text-xs text-blue-500 font-semibold mb-1">재등원</p>
                  <p className="text-lg font-bold text-blue-700">{formatTime(record.rechecked_in_at)}</p>
                </div>
              )}
              <div className="bg-orange-50 rounded-2xl p-4 text-center">
                <p className="text-xs text-orange-500 font-semibold mb-1">하원</p>
                <p className={`text-lg font-bold ${record.checked_out_at ? 'text-orange-600' : 'text-gray-300'}`}>
                  {formatTime(record.checked_out_at) ?? '수업 중'}
                </p>
              </div>
            </div>

            <div className="border-t border-gray-100"/>

            {/* 학습 결과 */}
            <div className="space-y-3">
              <p className="text-xs font-bold text-gray-400 uppercase tracking-wide">학습 결과</p>
              {[
                { label: '단어', value: record.word_score, icon: '📖', color: 'blue' },
                { label: '클리닉', value: record.clinic_score, icon: '📝', color: 'indigo' },
                { label: '구두', value: record.oral_status ? STATUS_LABEL[record.oral_status] ?? record.oral_status : null, icon: '🗣️', color: record.oral_status === 'pass' ? 'green' : record.oral_status === 'fail' ? 'red' : 'yellow' },
                { label: '과제', value: record.homework ? (STATUS_LABEL[record.homework] ?? record.homework) : null, icon: '✏️', color: record.homework === 'pass' ? 'green' : record.homework === 'fail' ? 'red' : 'yellow' },
              ].map(({ label, value, icon, color }) => (
                <div key={label} className="flex items-center justify-between py-2.5 border-b border-gray-50 last:border-0">
                  <div className="flex items-center gap-2.5">
                    <span className="text-lg">{icon}</span>
                    <span className="text-sm font-medium text-gray-600">{label}</span>
                  </div>
                  {value ? (
                    <span className={`text-sm font-bold px-3 py-1 rounded-full
                      ${color === 'green' ? 'bg-green-100 text-green-700' :
                        color === 'red' ? 'bg-red-100 text-red-600' :
                        color === 'yellow' ? 'bg-yellow-100 text-yellow-700' :
                        color === 'blue' ? 'bg-blue-50 text-blue-700' :
                        'bg-indigo-50 text-indigo-700'}`}>
                      {value}
                    </span>
                  ) : (
                    <span className="text-sm text-gray-300">-</span>
                  )}
                </div>
              ))}
            </div>

            {/* 다음 클리닉 */}
            {record.next_clinic_date && (
              <>
                <div className="border-t border-gray-100"/>
                <div className="bg-indigo-50 rounded-2xl px-4 py-3.5 flex items-center gap-3">
                  <span className="text-xl">📅</span>
                  <div>
                    <p className="text-xs text-indigo-400 font-semibold">재등원 예정</p>
                    <p className="text-sm font-bold text-indigo-700">{record.next_clinic_date}</p>
                  </div>
                </div>
              </>
            )}

            {/* 학생코드 입력 버튼 */}
            <button
              onClick={handleChangeCode}
              className="w-full py-3 rounded-2xl border-2 border-gray-100 text-gray-400 text-sm font-medium hover:bg-gray-50 transition-colors mt-2"
            >
              학생코드 입력
            </button>
          </div>
        </div>
      )}
      {/* 홈화면 추가 버튼 - standalone이 아닐 때 항상 표시 */}
      {!isStandalone && (
        <div className="fixed bottom-2 left-1/2 -translate-x-1/2 z-40">
          <button
            onClick={installPrompt ? handleInstall : () => setShowIosGuide(true)}
            className="text-xs text-gray-400 hover:text-gray-600 px-3 py-1.5 rounded-full border border-gray-200 bg-white/80 backdrop-blur-sm transition-colors whitespace-nowrap"
          >
            + 홈화면에 추가
          </button>
        </div>
      )}
    </div>
  )
}
