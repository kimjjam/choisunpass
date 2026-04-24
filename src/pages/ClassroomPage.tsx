import { useState, useEffect, useRef, useCallback } from 'react'
import { useNavigate } from 'react-router-dom'
import { supabase } from '../lib/supabase'
import { useCurrentUser } from '../hooks/useCurrentUser'

const ICE_SERVERS = [{ urls: 'stun:stun.l.google.com:19302' }]

type SignalPayload =
  | { type: 'request'; viewerId: string }
  | { type: 'answer'; viewerId: string; sdp: string }
  | { type: 'ice'; viewerId: string; from: 'viewer'; candidate: RTCIceCandidateInit }

export default function ClassroomPage() {
  const navigate = useNavigate()
  const currentUser = useCurrentUser()

  // 비밀번호 재확인
  const [verified, setVerified] = useState(false)
  const [pwInput, setPwInput] = useState('')
  const [pwError, setPwError] = useState('')
  const [pwLoading, setPwLoading] = useState(false)

  async function handleVerify(e: React.FormEvent) {
    e.preventDefault()
    if (!currentUser || !pwInput) return
    setPwLoading(true)
    setPwError('')
    const { error } = await supabase.auth.signInWithPassword({ email: currentUser, password: pwInput })
    setPwLoading(false)
    if (error) { setPwError('비밀번호가 올바르지 않습니다.'); return }
    setVerified(true)
  }

  const [roomInput, setRoomInput] = useState('')
  const [roomName, setRoomName] = useState(() => localStorage.getItem('classroom_room') ?? '')
  const [active, setActive] = useState(false)
  const [camError, setCamError] = useState('')
  const [viewerCount, setViewerCount] = useState(0)
  const [calling, setCalling] = useState(false)
  const [callSent, setCallSent] = useState(false)
  const [facingMode, setFacingMode] = useState<'environment' | 'user'>('environment')

  const videoRef = useRef<HTMLVideoElement>(null)
  const streamRef = useRef<MediaStream | null>(null)
  const peersRef = useRef<Map<string, RTCPeerConnection>>(new Map())
  const channelRef = useRef<ReturnType<typeof supabase.channel> | null>(null)

  const createPeer = useCallback((viewerId: string, ch: ReturnType<typeof supabase.channel>, stream: MediaStream) => {
    const existing = peersRef.current.get(viewerId)
    if (existing) { existing.close(); peersRef.current.delete(viewerId) }

    const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS })
    stream.getTracks().forEach(t => pc.addTrack(t, stream))

    pc.onicecandidate = (e) => {
      if (e.candidate) {
        ch.send({ type: 'broadcast', event: 'signal', payload: { type: 'ice', viewerId, from: 'classroom', candidate: e.candidate.toJSON() } })
      }
    }

    pc.onconnectionstatechange = () => {
      if (['disconnected', 'failed', 'closed'].includes(pc.connectionState)) {
        peersRef.current.delete(viewerId)
        setViewerCount(peersRef.current.size)
      }
    }

    peersRef.current.set(viewerId, pc)
    setViewerCount(peersRef.current.size)
    return pc
  }, [])

  const startRoom = useCallback(async (name: string, facing: 'environment' | 'user' = 'environment') => {
    setCamError('')
    let stream: MediaStream
    try {
      stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: facing }, audio: false })
    } catch {
      try {
        stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: false })
      } catch (err) {
        setCamError('카메라 접근 권한이 필요합니다.')
        console.error(err)
        return
      }
    }

    streamRef.current = stream
    if (videoRef.current) { videoRef.current.srcObject = stream }

    const ch = supabase.channel(`classroom:signal:${name}`, { config: { broadcast: { self: false } } })
      .on('broadcast', { event: 'signal' }, async ({ payload }: { payload: SignalPayload }) => {
        if (payload.type === 'request') {
          const pc = createPeer(payload.viewerId, ch, stream)
          const offer = await pc.createOffer()
          await pc.setLocalDescription(offer)
          ch.send({ type: 'broadcast', event: 'signal', payload: { type: 'offer', viewerId: payload.viewerId, sdp: offer.sdp } })
        } else if (payload.type === 'answer') {
          const pc = peersRef.current.get(payload.viewerId)
          if (pc && pc.signalingState === 'have-local-offer') {
            await pc.setRemoteDescription({ type: 'answer', sdp: payload.sdp })
          }
        } else if (payload.type === 'ice' && payload.from === 'viewer') {
          const pc = peersRef.current.get(payload.viewerId)
          if (pc) await pc.addIceCandidate(payload.candidate).catch(() => {})
        }
      })
      .subscribe()

    channelRef.current = ch
    setActive(true)
  }, [createPeer])

  useEffect(() => {
    if (roomName) startRoom(roomName)
    return () => {
      streamRef.current?.getTracks().forEach(t => t.stop())
      if (channelRef.current) supabase.removeChannel(channelRef.current)
      peersRef.current.forEach(pc => pc.close())
    }
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  async function handleCallAdmin() {
    if (calling) return
    setCalling(true)
    await supabase.from('classroom_calls').insert({ room_name: roomName, called_by: currentUser ?? '' })
    setCalling(false)
    setCallSent(true)
    setTimeout(() => setCallSent(false), 4000)
  }

  function handleSetRoom() {
    const name = roomInput.trim()
    if (!name) return
    localStorage.setItem('classroom_room', name)
    setRoomName(name)
    startRoom(name, facingMode)
  }

  async function flipCamera() {
    const next: 'environment' | 'user' = facingMode === 'environment' ? 'user' : 'environment'
    setFacingMode(next)

    // 기존 스트림 정지
    streamRef.current?.getTracks().forEach(t => t.stop())

    // 새 스트림으로 교체
    let newStream: MediaStream
    try {
      newStream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: next }, audio: false })
    } catch {
      newStream = await navigator.mediaDevices.getUserMedia({ video: true, audio: false })
    }
    streamRef.current = newStream
    if (videoRef.current) videoRef.current.srcObject = newStream

    // 기존 peer connection 트랙 교체
    const [newTrack] = newStream.getVideoTracks()
    peersRef.current.forEach(pc => {
      const sender = pc.getSenders().find(s => s.track?.kind === 'video')
      if (sender) sender.replaceTrack(newTrack)
    })
  }

  // 비밀번호 미확인
  if (!verified) {
    return (
      <div className="min-h-screen bg-gray-950 flex flex-col items-center justify-center p-8">
        <div className="text-white text-2xl font-black mb-2">교실 카메라</div>
        <div className="text-gray-400 text-sm mb-8">계속하려면 비밀번호를 입력하세요</div>
        <form onSubmit={handleVerify} className="w-full max-w-xs flex flex-col gap-3">
          <input
            type="password"
            value={pwInput}
            onChange={e => setPwInput(e.target.value)}
            placeholder="비밀번호"
            className="w-full bg-gray-800 text-white text-center text-lg rounded-2xl px-5 py-4 outline-none focus:ring-2 focus:ring-violet-500 placeholder:text-gray-600"
            autoFocus
          />
          {pwError && <div className="text-red-400 text-sm text-center">{pwError}</div>}
          <button
            type="submit"
            disabled={!pwInput || pwLoading}
            className="w-full py-4 rounded-2xl bg-violet-600 hover:bg-violet-500 disabled:bg-gray-800 disabled:text-gray-600 text-white text-lg font-bold transition-colors"
          >
            {pwLoading ? '확인 중…' : '확인'}
          </button>
        </form>
      </div>
    )
  }

  // 방 이름 미설정
  if (!roomName || !active) {
    return (
      <div className="min-h-screen bg-gray-950 flex flex-col items-center justify-center p-8">
        <div className="text-white text-2xl font-black mb-2">교실 카메라</div>
        <div className="text-gray-400 text-sm mb-8">이 태블릿의 교실 이름을 입력하세요</div>
        {camError && <div className="mb-4 text-red-400 text-sm bg-red-950/40 px-4 py-3 rounded-2xl">{camError}</div>}
        <div className="w-full max-w-xs">
          <input
            type="text"
            value={roomInput}
            onChange={e => setRoomInput(e.target.value)}
            onKeyDown={e => e.key === 'Enter' && handleSetRoom()}
            placeholder="예: A교실, 1강의실"
            className="w-full bg-gray-800 text-white text-lg text-center rounded-2xl px-5 py-4 outline-none focus:ring-2 focus:ring-violet-500 placeholder:text-gray-600 mb-4"
            autoFocus
          />
          <button
            onClick={handleSetRoom}
            disabled={!roomInput.trim()}
            className="w-full py-4 rounded-2xl bg-violet-600 hover:bg-violet-500 disabled:bg-gray-800 disabled:text-gray-600 text-white text-lg font-bold transition-colors"
          >
            시작
          </button>
        </div>
      </div>
    )
  }

  return (
    <div className="min-h-screen bg-gray-950 flex flex-col">
      {/* 상단 상태 바 */}
      <div className="flex items-center justify-between px-5 py-3">
        <div>
          <div className="text-white font-black text-base">{roomName}</div>
          <div className="text-gray-500 text-xs">
            {viewerCount > 0 ? `👁 ${viewerCount}명 시청 중` : '대기 중'}
          </div>
        </div>
        <div className="flex items-center gap-3">
          <div className="w-2 h-2 rounded-full bg-green-400 animate-pulse" />
          <button
            onClick={() => navigate('/admin')}
            className="text-xs text-gray-500 hover:text-gray-300 transition-colors"
          >
            관리자 페이지
          </button>
          <button
            onClick={() => {
              localStorage.removeItem('classroom_room')
              streamRef.current?.getTracks().forEach(t => t.stop())
              if (channelRef.current) supabase.removeChannel(channelRef.current)
              peersRef.current.forEach(pc => pc.close())
              setRoomName('')
              setActive(false)
            }}
            className="text-xs text-gray-600 hover:text-gray-400 transition-colors"
          >
            방 변경
          </button>
        </div>
      </div>

      {/* 카메라 미리보기 */}
      <div className="flex-1 relative mx-4 mb-4 rounded-3xl overflow-hidden bg-gray-900">
        <video
          ref={videoRef}
          autoPlay
          muted
          playsInline
          className="w-full h-full object-cover"
        />
        {camError && (
          <div className="absolute inset-0 flex items-center justify-center text-red-400 text-sm">{camError}</div>
        )}
        {/* 카메라 전환 버튼 */}
        <button
          onClick={flipCamera}
          className="absolute bottom-4 right-4 w-12 h-12 flex items-center justify-center rounded-full bg-black/50 hover:bg-black/70 active:scale-95 transition-all text-white text-xl"
          title="카메라 전환"
        >
          🔄
        </button>
      </div>

      {/* 호출 버튼 */}
      <div className="px-6 pb-10 flex flex-col items-center gap-3">
        {callSent && (
          <div className="text-green-400 text-sm font-semibold animate-pulse">관리자에게 호출을 보냈습니다</div>
        )}
        <button
          onClick={handleCallAdmin}
          disabled={calling}
          className="w-full max-w-sm py-5 rounded-3xl bg-red-600 hover:bg-red-500 active:scale-95 disabled:bg-gray-800 text-white text-xl font-black transition-all shadow-2xl shadow-red-900"
        >
          {calling ? '호출 중…' : '🚨 관리자 호출'}
        </button>
      </div>
    </div>
  )
}
