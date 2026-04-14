import { useState, useEffect, useRef } from 'react'
import { supabase } from '../lib/supabase'

const PIN = import.meta.env.VITE_BOMB_PIN ?? ''

function delay(ms: number) {
  return new Promise(res => setTimeout(res, ms))
}

type Phase = 'idle' | 'counting' | 'exploding'

export default function BombPage() {
  const [pin, setPin] = useState('')
  const [unlocked, setUnlocked] = useState(false)
  const [pinError, setPinError] = useState(false)
  const pinInputRef = useRef<HTMLInputElement>(null)

  const [maintenance, setMaintenance] = useState<boolean | null>(null)
  const [phase, setPhase] = useState<Phase>('idle')
  const [count, setCount] = useState(3)
  const [shake, setShake] = useState(false)
  const [nextMaintenance, setNextMaintenance] = useState(false)

  useEffect(() => {
    if (unlocked) fetchStatus()
  }, [unlocked])

  async function fetchStatus() {
    const { data } = await supabase
      .from('app_settings')
      .select('value')
      .eq('key', 'maintenance_mode')
      .single()
    setMaintenance(data?.value === 'true')
  }

  function handlePinInput(val: string) {
    const digits = val.replace(/\D/g, '').slice(0, 12)
    setPin(digits)
    setPinError(false)
    if (digits.length === 12) {
      if (digits === PIN) {
        setUnlocked(true)
      } else {
        setPinError(true)
        setTimeout(() => { setPin(''); setPinError(false) }, 800)
      }
    }
  }

  async function detonate() {
    if (phase !== 'idle' || maintenance === null) return

    const newVal = !maintenance
    setNextMaintenance(newVal)

    setShake(true)
    setTimeout(() => setShake(false), 500)

    setPhase('counting')
    for (let i = 3; i >= 1; i--) {
      setCount(i)
      await delay(1000)
    }

    setPhase('exploding')
    await supabase.from('app_settings').upsert({
      key: 'maintenance_mode',
      value: String(newVal),
      updated_at: new Date().toISOString(),
    })
    setMaintenance(newVal)
    await delay(2000)
    setPhase('idle')
  }

  // PIN 화면
  if (!unlocked) {
    return (
      <div
        className="min-h-screen bg-black flex flex-col items-center justify-center gap-8 select-none"
        onClick={() => pinInputRef.current?.focus()}
      >
        <style>{`
          @keyframes wrongShake {
            0%,100% { transform: translateX(0); }
            20% { transform: translateX(-10px); }
            40% { transform: translateX(10px); }
            60% { transform: translateX(-10px); }
            80% { transform: translateX(10px); }
          }
          .wrong-shake { animation: wrongShake 0.5s ease; }
        `}</style>

        <div className="text-7xl">💣</div>
        <p className="text-red-500 font-mono text-xs tracking-[0.4em] uppercase">Access Required</p>

        <div className={`flex gap-2 ${pinError ? 'wrong-shake' : ''}`}>
          {Array.from({ length: 12 }, (_, i) => (
            <div key={i} className={`w-8 h-10 rounded-lg border-2 flex items-center justify-center text-sm transition-all duration-200
              ${pinError
                ? 'border-red-500 bg-red-950 text-red-400'
                : pin.length > i
                  ? 'border-red-400 bg-gray-900 text-white'
                  : 'border-gray-700 bg-gray-900'}`}
            >
              {pin.length > i ? '●' : ''}
            </div>
          ))}
        </div>

        {pinError && <p className="text-red-500 text-xs font-mono tracking-widest">INVALID CODE</p>}

        {/* 숨겨진 input (키보드 트리거용) */}
        <input
          ref={pinInputRef}
          type="tel"
          inputMode="numeric"
          value={pin}
          onChange={e => handlePinInput(e.target.value)}
          className="opacity-0 absolute w-0 h-0"
          autoFocus
        />

        {/* 숫자 키패드 */}
        <div className="grid grid-cols-3 gap-3 mt-2">
          {[1, 2, 3, 4, 5, 6, 7, 8, 9, '', 0, '⌫'].map((k, i) => (
            <button
              key={i}
              onClick={() => {
                if (k === '⌫') handlePinInput(pin.slice(0, -1))
                else if (k !== '') handlePinInput(pin + String(k))
              }}
              className={`w-16 h-16 rounded-2xl text-xl font-semibold transition-all active:scale-90
                ${k === '' ? 'opacity-0 pointer-events-none' :
                  k === '⌫' ? 'bg-gray-800 text-gray-400 hover:bg-gray-700' :
                  'bg-gray-800 text-white hover:bg-gray-700 border border-gray-700'}`}
            >
              {k}
            </button>
          ))}
        </div>
      </div>
    )
  }

  // 카운트다운 화면
  if (phase === 'counting') {
    return (
      <div className="fixed inset-0 bg-black flex items-center justify-center">
        <style>{`
          @keyframes countIn {
            0% { transform: scale(2); opacity: 0; }
            30% { transform: scale(1); opacity: 1; }
            80% { transform: scale(1); opacity: 1; }
            100% { transform: scale(0.5); opacity: 0; }
          }
          .count-anim { animation: countIn 0.9s ease forwards; }
        `}</style>
        <div key={count} className="count-anim text-[180px] font-black text-red-500 leading-none select-none">
          {count}
        </div>
      </div>
    )
  }

  // 폭발 화면
  if (phase === 'exploding') {
    return (
      <div className="fixed inset-0 bg-red-600 flex items-center justify-center">
        <style>{`
          @keyframes explodeIn {
            0% { transform: scale(0.3) rotate(-10deg); opacity: 0; }
            60% { transform: scale(1.3) rotate(5deg); opacity: 1; }
            100% { transform: scale(1) rotate(0deg); opacity: 1; }
          }
          .explode-anim { animation: explodeIn 0.5s ease-out forwards; }
        `}</style>
        <div className="text-center explode-anim">
          <div className="text-[120px] mb-4">💥</div>
          <p className="text-white font-black text-3xl tracking-widest">
            {nextMaintenance ? '점검 모드 시작!' : '정상 운영 재개!'}
          </p>
        </div>
      </div>
    )
  }

  // 메인 폭탄실
  return (
    <div className={`min-h-screen bg-black flex flex-col items-center justify-center gap-6 px-4 ${shake ? 'shake-screen' : ''}`}>
      <style>{`
        @keyframes float {
          0%, 100% { transform: translateY(0px); }
          50% { transform: translateY(-14px); }
        }
        @keyframes glowRed {
          0%, 100% { box-shadow: 0 0 40px 10px rgba(239,68,68,0.5), inset 0 0 20px rgba(239,68,68,0.1); }
          50% { box-shadow: 0 0 80px 25px rgba(239,68,68,0.85), inset 0 0 30px rgba(239,68,68,0.2); }
        }
        @keyframes glowGreen {
          0%, 100% { box-shadow: 0 0 40px 10px rgba(34,197,94,0.5), inset 0 0 20px rgba(34,197,94,0.1); }
          50% { box-shadow: 0 0 80px 25px rgba(34,197,94,0.85), inset 0 0 30px rgba(34,197,94,0.2); }
        }
        @keyframes shakeScreen {
          0%,100% { transform: translate(0,0) rotate(0deg); }
          15% { transform: translate(-5px,3px) rotate(-1deg); }
          30% { transform: translate(5px,-3px) rotate(1deg); }
          45% { transform: translate(-4px,2px) rotate(-0.5deg); }
          60% { transform: translate(4px,-2px) rotate(0.5deg); }
          75% { transform: translate(-3px,1px) rotate(-0.3deg); }
          90% { transform: translate(3px,-1px) rotate(0.3deg); }
        }
        .float-anim { animation: float 3s ease-in-out infinite; }
        .glow-red { animation: glowRed 2s ease-in-out infinite; }
        .glow-green { animation: glowGreen 2s ease-in-out infinite; }
        .shake-screen { animation: shakeScreen 0.5s ease; }
      `}</style>

      {/* 상태 뱃지 */}
      <div className={`flex items-center gap-2 px-5 py-2 rounded-full border font-mono text-sm font-bold transition-all
        ${maintenance
          ? 'border-red-500 bg-red-950 text-red-400'
          : 'border-green-600 bg-green-950 text-green-400'}`}>
        <div className={`w-2 h-2 rounded-full ${maintenance ? 'bg-red-400 animate-pulse' : 'bg-green-400'}`} />
        {maintenance === null ? 'LOADING...' : maintenance ? '⚠ 점검 중' : '● 정상 운영'}
      </div>

      {/* 폭탄 이모지 */}
      <div className="float-anim text-[96px] select-none leading-none">💣</div>

      {/* 타이틀 */}
      <div className="text-center">
        <h1 className="text-white font-black text-3xl tracking-[0.2em] mb-2">BOMB ROOM</h1>
        <p className="text-gray-500 text-xs font-mono tracking-wider">
          {maintenance
            ? '다시 눌러서 점검 모드를 해제하세요'
            : '버튼을 눌러 점검 모드로 전환하세요'}
        </p>
        {maintenance && (
          <p className="text-red-500 text-xs font-mono mt-1 tracking-wide">
            출석 · 대시보드 접근이 차단됩니다
          </p>
        )}
      </div>

      {/* 기폭 버튼 */}
      <button
        onClick={detonate}
        disabled={maintenance === null}
        className={`mt-2 w-44 h-44 rounded-full border-4 font-black text-2xl tracking-widest
          text-white transition-all duration-300 active:scale-95 disabled:opacity-40
          ${maintenance
            ? 'bg-green-800 hover:bg-green-700 border-green-400 glow-green'
            : 'bg-red-800 hover:bg-red-700 border-red-400 glow-red'}`}
      >
        {maintenance ? '해 제' : '기 폭'}
      </button>

      {/* 하단 상태 텍스트 */}
      <p className="text-gray-700 text-xs font-mono tracking-widest mt-4">
        {maintenance ? 'MAINTENANCE MODE ACTIVE' : 'ALL SYSTEMS NORMAL'}
      </p>
    </div>
  )
}
