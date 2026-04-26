import { useState, useEffect, useRef } from 'react'
import { createPortal } from 'react-dom'
import * as XLSX from 'xlsx'
import { useNavigate } from 'react-router-dom'
import { supabase } from '../lib/supabase'
import { useCurrentUser } from '../hooks/useCurrentUser'
import type { Student, AttendanceWithStudent, Term, ClinicAbsenceWithStudent, VisitType } from '../lib/database.types'
import EditStudentModal from '../components/EditStudentModal'
import StudentHistoryModal from '../components/StudentHistoryModal'

type AdminTab = 'students' | 'weekly' | 'stats' | 'absence' | 'daily'

const ORAL_TYPES = ['빈칸 구두', '별구두', '해석 구두', '별 빈칸 구두', '기타']
const CLINIC_DAYS = ['월', '화', '수', '목', '금']
const GOOGLE_SCRIPT_URL = 'https://script.google.com/macros/s/AKfycbzGc1XSf4VYRXNEMxawN1r9UxXJghNax7ZN2H6AX24MxnxC3KE7WNdsfSLV8WLhjGbBXw/exec'

// 날짜 → 해당 주의 월요일
function getWeekStart(dateStr: string): string {
  const d = new Date(dateStr)
  const day = d.getDay()
  const diff = day === 0 ? -6 : 1 - day
  d.setDate(d.getDate() + diff)
  return d.toISOString().split('T')[0]
}

// 시작일 기준 주차 계산
function weekLabel(weekStart: string, termStart: string): string {
  const start = new Date(termStart)
  const ws = new Date(weekStart)
  const diffDays = Math.round((ws.getTime() - start.getTime()) / (1000 * 60 * 60 * 24))
  const weekNum = Math.floor(diffDays / 7) + 1
  return weekNum < 1 ? '(시작 전)' : `${weekNum}주차`
}

export default function AdminPage() {
  const navigate = useNavigate()
  const currentUser = useCurrentUser()
  const [maintenanceMode, setMaintenanceMode] = useState(false)
  const [tab, setTab] = useState<AdminTab>('students')
  const [students, setStudents] = useState<Student[]>([])
  const [allRecords, setAllRecords] = useState<AttendanceWithStudent[]>([])
  const [loading, setLoading] = useState(false)
  const [gsLoading, setGsLoading] = useState(false)
  const [gsResult, setGsResult] = useState<'success' | 'error' | null>(null)

  // 학생 등록 폼
  const [form, setForm] = useState({ name: '', class: '', school: '', oral_type: '', clinic_day: '', phone: '' })
  const [formError, setFormError] = useState('')
  const [formLoading, setFormLoading] = useState(false)
  const [showRegisterModal, setShowRegisterModal] = useState(false)
  const [showRegisterConfirm, setShowRegisterConfirm] = useState(false)
  const [showTermModal, setShowTermModal] = useState(false)

  const [editTarget, setEditTarget] = useState<Student | null>(null)

  // 학생 관리 / 누적 통계 탭 필터
  const [search, setSearch] = useState('')
  const [dayFilter, setDayFilter] = useState<string>('')
  const [schoolFilter, setSchoolFilter] = useState<string>('')
  const [classFilter, setClassFilter] = useState<string>('')

  // 주차별 탭 전용 필터 (독립)
  const [weeklySearch, setWeeklySearch] = useState('')
  const [weeklyDayFilter, setWeeklyDayFilter] = useState<string>('')
  const [weeklySchoolFilter, setWeeklySchoolFilter] = useState<string>('')
  const [weeklyClassFilter, setWeeklyClassFilter] = useState<string>('')

  // 주차별 탭에서 선택된 주차
  const [selectedWeek, setSelectedWeek] = useState<string>('')

  // 누적 통계 정렬
  const [statsSort, setStatsSort] = useState<{ col: string; dir: 'asc' | 'desc' }>({ col: '', dir: 'desc' })

  // 재등원 관리
  const [absences, setAbsences] = useState<ClinicAbsenceWithStudent[]>([])
  const [absenceWeek, setAbsenceWeek] = useState<string>('')
  const [absenceReasonModal, setAbsenceReasonModal] = useState<{ studentId: string; name: string; type: '미실시' | '미재등원' } | null>(null)
  const [absenceReason, setAbsenceReason] = useState('')
  const [absenceLoading, setAbsenceLoading] = useState(false)

  // 출석 추가 모달
  const [showAddRecordModal, setShowAddRecordModal] = useState(false)
  const [addRecordForm, setAddRecordForm] = useState({
    student_id: '',
    date: '',
    visit_type: 'class_clinic' as 'class_clinic' | 'clinic',
    status: 'approved' as 'approved' | 'absent',
    word_score: '',
    clinic_score: '',
    oral_status: '',
    homework: '',
    oral_memo: '',
    homework_memo: '',
    notes: '',
  })
  const [addRecordLoading, setAddRecordLoading] = useState(false)
  const [addRecordError, setAddRecordError] = useState('')
  const [addRecordStudentSearch, setAddRecordStudentSearch] = useState('')
  const [addRecordSchoolFilter, setAddRecordSchoolFilter] = useState('')
  const [addRecordClassFilter, setAddRecordClassFilter] = useState('')
  // 미실시 학생 (이번 선택 주차에 출석 없는 학생)
  const [noShowStudents, setNoShowStudents] = useState<Student[]>([])
  // 미재등원 학생 (next_clinic_date 지났는데 미등원)
  const [overdueStudents, setOverdueStudents] = useState<AttendanceWithStudent[]>([])

  // 일별 조회
  const [dailySearch, setDailySearch] = useState('')
  const [dailySchoolFilter, setDailySchoolFilter] = useState('')
  const [dailyClassFilter, setDailyClassFilter] = useState('')
  const [selectedDate, setSelectedDate] = useState<string>(() => {
    const d = new Date()
    d.setDate(d.getDate() - 1)
    return d.toISOString().split('T')[0]
  })
  const [dailyRecords, setDailyRecords] = useState<AttendanceWithStudent[]>([])
  const [dailyLoading, setDailyLoading] = useState(false)

  // 학생 히스토리 모달
  const [historyTarget, setHistoryTarget] = useState<Student | null>(null)
  const [historyRecords, setHistoryRecords] = useState<AttendanceWithStudent[]>([])
  const [historyAbsences, setHistoryAbsences] = useState<ClinicAbsenceWithStudent[]>([])

  // 전체 주차 기타 모달
  const [pivotNotesModal, setPivotNotesModal] = useState<{ name: string; week: string; oralMemo: string; homeworkMemo: string; notes: string } | null>(null)

  // 학기 관리
  const [terms, setTerms] = useState<Term[]>([])
  const [selectedTermId, setSelectedTermId] = useState<string>('')
  const [newTermName, setNewTermName] = useState('')
  const [newTermDate, setNewTermDate] = useState('')
  const [termFormError, setTermFormError] = useState('')

  // 교실 실시간 뷰어
  const [classroomOpen, setClassroomOpen] = useState(false)
  const [classroomRoomInput, setClassroomRoomInput] = useState('')
  const [classroomRoom, setClassroomRoom] = useState('')
  const [classroomConnecting, setClassroomConnecting] = useState(false)
  const [classroomConnected, setClassroomConnected] = useState(false)
  const classroomVideoRef = useRef<HTMLVideoElement>(null)
  const classroomRemoteStreamRef = useRef<MediaStream | null>(null)
  const classroomPcRef = useRef<RTCPeerConnection | null>(null)
  const classroomChRef = useRef<ReturnType<typeof supabase.channel> | null>(null)
  const classroomViewerId = useRef(crypto.randomUUID())
  const classroomPendingIceRef = useRef<RTCIceCandidateInit[]>([])
  const classroomRequestRetryRef = useRef<number | null>(null)

  // 교실 호출 알림
  const [classroomCall, setClassroomCall] = useState<{ id: string; room_name: string; called_at: string } | null>(null)

  useEffect(() => {
    supabase.from('classroom_calls').select('id, room_name, called_at').is('acknowledged_at', null).order('called_at').limit(1)
      .then(({ data }) => { if (data?.[0]) setClassroomCall(data[0]) })

    const ch = supabase.channel('admin-classroom-calls')
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'classroom_calls' },
        (payload) => { setClassroomCall(payload.new as { id: string; room_name: string; called_at: string }) })
      .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'classroom_calls' },
        (payload) => { if ((payload.new as { acknowledged_at: string | null }).acknowledged_at) setClassroomCall(null) })
      .subscribe()
    return () => { supabase.removeChannel(ch) }
  }, [])

  async function acknowledgeCall(id: string) {
    await supabase.from('classroom_calls').update({ acknowledged_at: new Date().toISOString(), acknowledged_by: currentUser ?? '' }).eq('id', id)
    setClassroomCall(null)
  }

  async function connectClassroom(room: string) {
    if (classroomPcRef.current) { classroomPcRef.current.close() }
    if (classroomChRef.current) { supabase.removeChannel(classroomChRef.current) }
    setClassroomConnecting(true)
    setClassroomConnected(false)
    if (classroomRequestRetryRef.current !== null) {
      window.clearInterval(classroomRequestRetryRef.current)
      classroomRequestRetryRef.current = null
    }
    classroomPendingIceRef.current = []

    const viewerId = classroomViewerId.current
    const pc = new RTCPeerConnection({ iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] })
    classroomPcRef.current = pc
    let offerReceived = false

    pc.onicecandidate = (e) => {
      if (e.candidate && classroomChRef.current) {
        classroomChRef.current.send({ type: 'broadcast', event: 'signal', payload: { type: 'ice', viewerId, from: 'viewer', candidate: e.candidate.toJSON() } })
      }
    }

    pc.ontrack = (e) => {
      classroomRemoteStreamRef.current = e.streams[0]
      if (classroomVideoRef.current) classroomVideoRef.current.srcObject = e.streams[0]
      setClassroomConnected(true)
      setClassroomConnecting(false)
      if (classroomRequestRetryRef.current !== null) {
        window.clearInterval(classroomRequestRetryRef.current)
        classroomRequestRetryRef.current = null
      }
    }

    pc.onconnectionstatechange = () => {
      if (['disconnected', 'failed', 'closed'].includes(pc.connectionState)) {
        setClassroomConnected(false)
      }
    }

    let ch: ReturnType<typeof supabase.channel>
    const sendRequest = () => {
      ch.send({ type: 'broadcast', event: 'signal', payload: { type: 'request', viewerId } })
    }

    ch = supabase.channel(`classroom:signal:${room}`, { config: { broadcast: { self: false } } })
      .on('broadcast', { event: 'signal' }, async ({ payload }: { payload: { type: string; viewerId: string; sdp?: string; candidate?: RTCIceCandidateInit; from?: string } }) => {
        if (payload.type === 'offer' && payload.viewerId === viewerId) {
          offerReceived = true
          if (classroomRequestRetryRef.current !== null) {
            window.clearInterval(classroomRequestRetryRef.current)
            classroomRequestRetryRef.current = null
          }
          await pc.setRemoteDescription({ type: 'offer', sdp: payload.sdp! })
          for (const candidate of classroomPendingIceRef.current) {
            await pc.addIceCandidate(candidate).catch(() => {})
          }
          classroomPendingIceRef.current = []
          const answer = await pc.createAnswer()
          await pc.setLocalDescription(answer)
          ch.send({ type: 'broadcast', event: 'signal', payload: { type: 'answer', viewerId, sdp: answer.sdp } })
        } else if (payload.type === 'ice' && payload.from === 'classroom' && payload.viewerId === viewerId) {
          if (pc.remoteDescription) {
            await pc.addIceCandidate(payload.candidate!).catch(() => {})
          } else {
            classroomPendingIceRef.current.push(payload.candidate!)
          }
        }
      })
      .subscribe((status) => {
        if (status !== 'SUBSCRIBED') return
        sendRequest()
        let attempts = 0
        classroomRequestRetryRef.current = window.setInterval(() => {
          if (offerReceived || pc.connectionState === 'connected') {
            if (classroomRequestRetryRef.current !== null) {
              window.clearInterval(classroomRequestRetryRef.current)
              classroomRequestRetryRef.current = null
            }
            return
          }
          attempts += 1
          sendRequest()
          if (attempts >= 4 && classroomRequestRetryRef.current !== null) {
            window.clearInterval(classroomRequestRetryRef.current)
            classroomRequestRetryRef.current = null
          }
        }, 1500)
      })

    classroomChRef.current = ch
    setClassroomRoom(room)
    setTimeout(() => {
      if (!offerReceived && pc.connectionState !== 'connected') setClassroomConnecting(false)
    }, 12000)
  }

  function disconnectClassroom() {
    if (classroomRequestRetryRef.current !== null) {
      window.clearInterval(classroomRequestRetryRef.current)
      classroomRequestRetryRef.current = null
    }
    classroomPendingIceRef.current = []
    classroomPcRef.current?.close()
    classroomPcRef.current = null
    if (classroomChRef.current) supabase.removeChannel(classroomChRef.current)
    classroomChRef.current = null
    classroomRemoteStreamRef.current = null
    if (classroomVideoRef.current) classroomVideoRef.current.srcObject = null
    setClassroomConnected(false)
    setClassroomRoom('')
    setClassroomRoomInput('')
  }

  useEffect(() => {
    if (classroomVideoRef.current && classroomRemoteStreamRef.current) {
      classroomVideoRef.current.srcObject = classroomRemoteStreamRef.current
    }
  }, [classroomOpen, classroomConnected, classroomRoom])

  useEffect(() => {
    return () => {
      if (classroomRequestRetryRef.current !== null) {
        window.clearInterval(classroomRequestRetryRef.current)
      }
      classroomPcRef.current?.close()
      if (classroomChRef.current) supabase.removeChannel(classroomChRef.current)
    }
  }, [])

  useEffect(() => {
    supabase.from('app_settings').select('value').eq('key', 'maintenance_mode').single()
      .then(({ data }) => { if (data?.value === 'true') setMaintenanceMode(true) })

    const channel = supabase
      .channel('admin-maintenance')
      .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'app_settings', filter: 'key=eq.maintenance_mode' },
        (payload) => { setMaintenanceMode((payload.new as { value: string }).value === 'true') })
      .subscribe()
    return () => { supabase.removeChannel(channel) }
  }, [])

  useEffect(() => {
    fetchStudents()
    fetchTerms()
  }, [])

  useEffect(() => {
    if (tab === 'weekly' || tab === 'stats') fetchAllRecords()
    if (tab === 'absence') { fetchAbsences(); fetchNoShowData() }
    if (tab === 'daily') fetchDailyRecords(selectedDate)
  }, [tab]) // eslint-disable-line react-hooks/exhaustive-deps

  // 어드민 실시간 구독
  useEffect(() => {
    const channel = supabase
      .channel('admin-attendances')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'attendances' }, () => {
        if (tab === 'weekly' || tab === 'stats') fetchAllRecords()
      })
      .subscribe()
    return () => { supabase.removeChannel(channel) }
  }, [tab])

  async function fetchTerms() {
    const { data } = await supabase.from('terms').select('*').order('start_date', { ascending: true })
    if (data && data.length > 0) {
      setTerms(data)
      setSelectedTermId(data[data.length - 1].id)
    }
  }

  async function handleCreateTerm(e: React.FormEvent) {
    e.preventDefault()
    setTermFormError('')
    if (!newTermName.trim()) { setTermFormError('학기 이름을 입력하세요.'); return }
    if (!newTermDate) { setTermFormError('시작일을 선택하세요.'); return }
    const monday = getWeekStart(newTermDate)
    const { error } = await supabase.from('terms').insert({ name: newTermName.trim(), start_date: monday })
    if (error) { setTermFormError('저장 실패. 다시 시도해주세요.'); return }
    setNewTermName('')
    setNewTermDate('')
    setShowTermModal(false)
    fetchTerms()
  }

  async function handleDeleteTerm(id: string, name: string) {
    if (!confirm(`"${name}" 학기를 삭제하시겠습니까?`)) return
    await supabase.from('terms').delete().eq('id', id)
    fetchTerms()
  }

  async function fetchStudents() {
    const { data } = await supabase
      .from('students')
      .select('*')
      .order('class', { ascending: true })
    if (data) setStudents(data)
  }

  async function fetchAllRecords(keepWeek = false) {
    setLoading(true)
    // Supabase 서버 max rows(기본 1000) 우회 — 페이지네이션으로 전체 수집
    const PAGE = 1000
    let all: AttendanceWithStudent[] = []
    let from = 0
    while (true) {
      const { data, error } = await supabase
        .from('attendances')
        .select('*, students(*)')
        .order('date', { ascending: true })
        .range(from, from + PAGE - 1)
      if (error || !data || data.length === 0) break
      all = all.concat(data as AttendanceWithStudent[])
      if (data.length < PAGE) break
      from += PAGE
    }
    if (all.length > 0) {
      setAllRecords(all)
      if (!keepWeek) {
        const starts = getWeekStarts(all)
        setSelectedWeek(starts[starts.length - 1])
      }
    }
    setLoading(false)
  }

  function getWeekStarts(records: AttendanceWithStudent[]): string[] {
    const set = new Set(records.map((r) => getWeekStart(r.date)))
    return Array.from(set).sort()
  }

  async function fetchDailyRecords(date: string) {
    setDailyLoading(true)
    const { data } = await supabase
      .from('attendances')
      .select('*, students(*)')
      .eq('date', date)
      .order('checked_in_at', { ascending: true })
    setDailyRecords((data as AttendanceWithStudent[]) ?? [])
    setDailyLoading(false)
  }

  async function fetchAbsences() {
    const { data } = await supabase
      .from('clinic_absences')
      .select('*, students(*)')
      .order('week_start_date', { ascending: false })
    if (data) setAbsences(data as ClinicAbsenceWithStudent[])
  }

  async function fetchNoShowData() {
    // 직전 주 월요일 계산 (로컬 날짜 기준 — toISOString은 UTC라 오전 9시 전 하루 오차)
    function localDateStr(d: Date) {
      return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
    }
    const today = new Date()
    const day = today.getDay()
    const diff = day === 0 ? -6 : 1 - day
    const thisMonday = new Date(today)
    thisMonday.setDate(today.getDate() + diff)
    const lastMonday = new Date(thisMonday)
    lastMonday.setDate(thisMonday.getDate() - 7)
    const lastSunday = new Date(lastMonday)
    lastSunday.setDate(lastMonday.getDate() + 6)
    const weekStart = localDateStr(lastMonday)
    const weekEnd = localDateStr(lastSunday)
    setAbsenceWeek(weekStart)

    // 지난주 출석한 학생 id 목록
    const { data: attendedData } = await supabase
      .from('attendances')
      .select('student_id')
      .gte('date', weekStart)
      .lte('date', weekEnd)
    const attendedIds = new Set((attendedData || []).map((r: { student_id: string }) => r.student_id))

    // 모든 학생 중 출석 안 한 학생
    const { data: allStudents } = await supabase.from('students').select('*').order('name')
    if (allStudents) {
      setNoShowStudents((allStudents as Student[]).filter(s => !attendedIds.has(s.id)))
    }

    // 미재등원: next_clinic_date가 오늘 이전이고 그 이후 출석이 없는 경우
    const todayStr = localDateStr(today)
    const { data: overdueData } = await supabase
      .from('attendances')
      .select('*, students(*)')
      .not('next_clinic_date', 'is', null)
      .lt('next_clinic_date', todayStr)
    if (overdueData) {
      // 각 학생의 next_clinic_date 이후 실제 출석이 DB 전체에 있는지 확인
      const studentIds = [...new Set((overdueData as AttendanceWithStudent[]).map(r => r.student_id))]
      const { data: laterData } = await supabase
        .from('attendances')
        .select('student_id, date')
        .in('student_id', studentIds)
        .gte('date', todayStr)
      const laterSet = new Set((laterData || []).map((r: { student_id: string; date: string }) => r.student_id))

      // 각 학생별로 가장 최근 next_clinic_date 기록만 남기고, 그 이후 출석 없는 경우만 표시
      const latestPerStudent = new Map<string, AttendanceWithStudent>()
      for (const r of overdueData as AttendanceWithStudent[]) {
        const existing = latestPerStudent.get(r.student_id)
        if (!existing || r.next_clinic_date! > existing.next_clinic_date!) {
          latestPerStudent.set(r.student_id, r)
        }
      }
      const overdue = [...latestPerStudent.values()].filter(r => !laterSet.has(r.student_id))
      setOverdueStudents(overdue)
    }
  }

  async function handleAddAbsence(studentId: string, type: '미실시' | '미재등원') {
    if (!absenceReasonModal || !selectedTermId) return
    setAbsenceLoading(true)
    const { error } = await supabase.from('clinic_absences').insert({
      student_id: studentId,
      term_id: selectedTermId,
      week_start_date: absenceWeek,
      type,
      reason: absenceReason.trim() || null,
    })
    setAbsenceLoading(false)
    if (error) {
      console.error('결석 사유 저장 실패:', error)
      alert('저장에 실패했습니다. 다시 시도해주세요.')
      return
    }
    setAbsenceReasonModal(null)
    setAbsenceReason('')
    fetchAbsences()
    fetchNoShowData()
  }

  async function openStudentHistory(student: Student) {
    setHistoryTarget(student)
    const { data: records } = await supabase
      .from('attendances')
      .select('*, students(*)')
      .eq('student_id', student.id)
      .order('date', { ascending: false })
    if (records) setHistoryRecords(records as AttendanceWithStudent[])

    const { data: abs } = await supabase
      .from('clinic_absences')
      .select('*, students(*)')
      .eq('student_id', student.id)
      .order('week_start_date', { ascending: false })
    if (abs) setHistoryAbsences(abs as ClinicAbsenceWithStudent[])
  }

  function extractCode(phone: string): string {
    const digits = phone.replace(/\D/g, '')
    if (digits.length >= 4) return digits.slice(-4)
    return String(Math.floor(Math.random() * 10000)).padStart(4, '0')
  }

  function handleRegisterValidate(e: React.FormEvent) {
    e.preventDefault()
    setFormError('')
    if (!form.name.trim()) { setFormError('이름을 입력하세요.'); return }
    if (!form.class.trim()) { setFormError('반(선생님)을 입력하세요.'); return }
    if (!form.school.trim()) { setFormError('학교를 입력하세요.'); return }
    if (!form.phone.trim()) { setFormError('전화번호를 입력하세요.'); return }
    setShowRegisterConfirm(true)
  }

  async function handleRegisterSubmit() {
    setFormLoading(true)
    setFormError('')
    const code = extractCode(form.phone)
    const { data: existing } = await supabase.from('students').select('id').eq('code', code).single()
    if (existing) {
      setFormError(`코드 ${code}가 이미 사용 중입니다. 전화번호 중간 4자리로 시도하거나 관리자에게 문의하세요.`)
      setShowRegisterConfirm(false)
      setFormLoading(false)
      return
    }

    const { error } = await supabase.from('students').insert({
      name: form.name.trim(),
      class: form.class.trim(),
      school: form.school.trim(),
      oral_type: form.oral_type.trim(),
      clinic_day: form.clinic_day,
      code,
    })

    if (error) {
      setFormError('등록 실패. 다시 시도해주세요.')
      setShowRegisterConfirm(false)
    } else {
      setForm({ name: '', class: '', school: '', oral_type: '', clinic_day: '', phone: '' })
      setShowRegisterConfirm(false)
      setShowRegisterModal(false)
      fetchStudents()
    }
    setFormLoading(false)
  }

  function handlePrintCodes(list: Student[]) {
    const win = window.open('', '_blank')
    if (!win) return
    win.document.write(`
      <html><head><title>최선 패스 — 학생 코드 목록</title>
      <style>
        body { font-family: sans-serif; padding: 24px; }
        h1 { font-size: 18px; margin-bottom: 16px; }
        table { width: 100%; border-collapse: collapse; }
        th, td { border: 1px solid #ddd; padding: 8px 12px; text-align: left; font-size: 13px; }
        th { background: #f5f5f5; font-weight: 600; }
        .code { font-family: monospace; font-size: 16px; font-weight: bold; color: #2563eb; letter-spacing: 0.1em; }
        @media print { button { display: none; } }
      </style></head><body>
      <h1>최선 패스 — 학생 코드 목록</h1>
      <table>
        <thead><tr><th>이름</th><th>반(선생님)</th><th>학교</th><th>요일</th><th>코드</th></tr></thead>
        <tbody>
          ${list.map(s => `
            <tr>
              <td>${s.name}</td>
              <td>${s.class}</td>
              <td>${s.school}</td>
              <td>${s.clinic_day ? s.clinic_day + '요일' : '-'}</td>
              <td class="code">${s.code}</td>
            </tr>`).join('')}
        </tbody>
      </table>
      <br/><button onclick="window.print()">🖨️ 인쇄</button>
      </body></html>
    `)
    win.document.close()
  }

  function openAddRecordModal() {
    const mon = selectedWeek && selectedWeek !== 'all' ? selectedWeek : ''
    setAddRecordForm({
      student_id: '',
      date: mon,
      visit_type: 'class_clinic',
      status: 'approved',
      word_score: '',
      clinic_score: '',
      oral_status: '',
      homework: '',
      oral_memo: '',
      homework_memo: '',
      notes: '',
    })
    setAddRecordError('')
    setAddRecordStudentSearch('')
    setAddRecordSchoolFilter('')
    setAddRecordClassFilter('')
    setShowAddRecordModal(true)
  }

  async function handleAddRecord() {
    if (!addRecordForm.student_id || !addRecordForm.date) {
      setAddRecordError('학생과 날짜를 선택해주세요.')
      return
    }
    setAddRecordLoading(true)
    setAddRecordError('')

    const { data: existing } = await supabase
      .from('attendances')
      .select('id')
      .eq('student_id', addRecordForm.student_id)
      .eq('date', addRecordForm.date)
      .maybeSingle()

    if (existing) {
      setAddRecordError('해당 날짜에 이미 출석 기록이 있습니다.')
      setAddRecordLoading(false)
      return
    }

    const now = new Date().toISOString()
    const isApproved = addRecordForm.status === 'approved'
    const { error } = await supabase.from('attendances').insert({
      student_id: addRecordForm.student_id,
      date: addRecordForm.date,
      visit_type: addRecordForm.visit_type,
      status: addRecordForm.status,
      checked_in_at: isApproved ? now : null,
      approved_at: isApproved ? now : null,
      word_score: addRecordForm.word_score || null,
      clinic_score: addRecordForm.clinic_score || null,
      oral_status: addRecordForm.oral_status || null,
      homework: addRecordForm.homework || null,
      oral_memo: addRecordForm.oral_memo || null,
      homework_memo: addRecordForm.homework_memo || null,
      notes: addRecordForm.notes || null,
    })

    setAddRecordLoading(false)
    if (error) {
      setAddRecordError('저장 실패: ' + error.message)
      return
    }
    setShowAddRecordModal(false)
    fetchAllRecords(true)
  }

  async function handleDeleteStudent(id: string, name: string) {
    if (!confirm(`"${name}" 학생을 삭제하시겠습니까?\n관련 출석 기록도 모두 삭제됩니다.`)) return
    await supabase.from('students').delete().eq('id', id)
    fetchStudents()
  }

  // 주차별 엑셀 다운로드 — 구글시트 양식
  function handleExcelDownload(weekStart: string, weekRecords: AttendanceWithStudent[], label: string) {
    if (weekRecords.length === 0) return

    const rows = weekRecords.map((r) => ({
      '반(선생님)': r.students.class,
      '학교': r.students.school,
      '이름': r.students.name,
      '구두 진행 방식': r.students.oral_type,
      '클리닉 요일': r.students.clinic_day,
      '클리닉(출석여부)': r.status === 'approved' ? '○' : '',
      '클리닉등원시간': r.approved_at
        ? new Date(r.approved_at).toLocaleString('ko-KR', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })
        : '',
      '클리닉하원시간': r.checked_out_at
        ? new Date(r.checked_out_at).toLocaleString('ko-KR', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })
        : '',
      '과제(미완료과제입력)': r.homework ?? '',
      '단어점수': r.word_score ?? '',
      '클리닉점수': r.clinic_score ?? '',
      '구두': r.oral_status === 'pass' ? 'Pass' : r.oral_status === 'fail' ? 'Fail' : r.oral_status === 'delay' ? 'Delay' : r.oral_status === 'word_pass' ? '단어Pass' : r.oral_status === 'sentence_pass' ? '문장Pass' : r.oral_status === 'exempt' ? '면제' : '',
      '기타': r.notes ?? '',
      '직보점수': r.jikbo_score ?? '',
      '부모님알림장': r.parent_memo ?? '',
    }))

    const ws = XLSX.utils.json_to_sheet(rows)
    const wb = XLSX.utils.book_new()
    XLSX.utils.book_append_sheet(wb, ws, label)
    XLSX.writeFile(wb, `최선패스_${label}_${weekStart}.xlsx`)
  }

  async function handleGoogleSheetUpload(_weekStart: string, weekRecords: AttendanceWithStudent[], label: string) {
    if (weekRecords.length === 0) return
    setGsLoading(true)
    setGsResult(null)

    // 같은 학생이 주에 여러 번 출석한 경우 최신 날짜 레코드만 사용
    const latestByStudent = new Map<string, AttendanceWithStudent>()
    for (const r of weekRecords) {
      const existing = latestByStudent.get(r.student_id)
      if (!existing || r.date > existing.date) latestByStudent.set(r.student_id, r)
    }
    // 이름 ㄱㄴㄷ 정렬 후 학교 → 반(선생님)별로 이중 그룹핑
    const dedupedRecords = Array.from(latestByStudent.values())
      .sort((a, b) => a.students.name.localeCompare(b.students.name, 'ko'))
    const schools: Record<string, Record<string, object[]>> = {}
    for (const r of dedupedRecords) {
      const school = r.students.school
      const cls = r.students.class
      if (!schools[school]) schools[school] = {}
      if (!schools[school][cls]) schools[school][cls] = []
      schools[school][cls].push({
        name: r.students.name,
        clinic_day: r.students.clinic_day,
        oral_type: r.students.oral_type,
        attendance: r.status === 'approved' ? '○' : '',
        checkin: r.approved_at
          ? new Date(r.approved_at).toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit' })
          : '',
        checkout: r.checked_out_at
          ? new Date(r.checked_out_at).toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit' })
          : '',
        score: [r.word_score, r.clinic_score].filter(Boolean).join(' / '),
        homework: r.homework ?? '',
        oral: r.oral_status === 'pass' ? 'Pass' : r.oral_status === 'fail' ? 'Fail' : r.oral_status === 'delay' ? 'Delay' : r.oral_status === 'word_pass' ? '단어Pass' : r.oral_status === 'sentence_pass' ? '문장Pass' : r.oral_status === 'exempt' ? '면제' : '',
        notes: r.notes ?? '',
        jikbo_score: r.jikbo_score ?? '',
        parent_memo: r.parent_memo ?? '',
        next_clinic_date: r.next_clinic_date ?? '',
      })
    }

    try {
      await fetch(GOOGLE_SCRIPT_URL, {
        method: 'POST',
        mode: 'no-cors',
        body: JSON.stringify({ weekLabel: label, schools }),
      })
      setGsResult('success')
    } catch (err) {
      console.error('GS 전송 실패:', err)
      setGsResult('error')
    } finally {
      setGsLoading(false)
      setTimeout(() => setGsResult(null), 3000)
    }
  }

  // 선택된 학기
  const selectedTerm = terms.find(t => t.id === selectedTermId)
  const nextTerm = selectedTerm
    ? terms.find(t => t.start_date > selectedTerm.start_date)
    : undefined

  // 학기 내 기록만 필터링
  const termRecords = allRecords.filter(r => {
    if (!selectedTerm) return true
    if (r.date < selectedTerm.start_date) return false
    if (nextTerm && r.date >= nextTerm.start_date) return false
    return true
  })

  // 주차별 데이터 그룹핑
  const weekStarts = getWeekStarts(termRecords)
  const weekRecords = termRecords
    .filter((r) => getWeekStart(r.date) === selectedWeek)
    .filter((r) => r.students.name.includes(weeklySearch.trim()))
    .filter((r) => !weeklyDayFilter || r.students.clinic_day === weeklyDayFilter)
    .filter((r) => !weeklySchoolFilter || r.students.school === weeklySchoolFilter)
    .filter((r) => !weeklyClassFilter || r.students.class === weeklyClassFilter)

  const schools = [...new Set(students.map(s => s.school))].filter(Boolean).sort()
  const classes = [...new Set(students.map(s => s.class))].filter(Boolean).sort()

  const filteredStudents = students
    .filter((s) => s.name.includes(search.trim()))
    .filter((s) => !dayFilter || s.clinic_day === dayFilter)
    .filter((s) => !schoolFilter || s.school === schoolFilter)
    .filter((s) => !classFilter || s.class === classFilter)

  // 반별로 그룹핑
  const groupedByClass = weekRecords.reduce<Record<string, AttendanceWithStudent[]>>((acc, r) => {
    const key = `${r.students.school} (${r.students.class})`
    if (!acc[key]) acc[key] = []
    acc[key].push(r)
    return acc
  }, {})

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
    <div className="min-h-screen bg-slate-50">
      {/* 헤더 */}
      <header className="bg-white shadow-md shadow-slate-100 px-6 py-4 flex items-center justify-between sticky top-0 z-40">
        <div>
          <div className="text-lg font-black text-gray-900 tracking-tight">관리자 페이지</div>
          <div className="text-xs text-gray-400 font-medium">최선어학원 클리닉</div>
        </div>
        <div className="flex items-center gap-3">
          <button
            onClick={() => setClassroomOpen(true)}
            className="text-xs text-emerald-600 hover:text-emerald-800 bg-emerald-50 hover:bg-emerald-100 rounded-xl px-3 py-1.5 font-semibold transition-colors"
          >
            교실 실시간
          </button>
          <button
            onClick={() => navigate('/dashboard')}
            className="text-xs text-blue-600 hover:text-blue-800 bg-blue-50 hover:bg-blue-100 rounded-xl px-3 py-1.5 font-semibold transition-colors"
          >
            조교 대시보드
          </button>
          <span className="text-xs text-gray-400 font-medium">{currentUser}</span>
          <button
            onClick={async () => { await supabase.auth.signOut(); navigate('/login') }}
            className="text-xs text-gray-400 hover:text-gray-600 bg-gray-100 hover:bg-gray-200 rounded-xl px-3 py-1.5 transition-colors"
          >
            로그아웃
          </button>
        </div>
      </header>

      {/* 탭 바 + 학생 등록 */}
      <div className="px-6 pt-4 mb-0">
        <div className="flex items-center gap-3">
          <div className="bg-gray-100 rounded-2xl p-1.5 flex gap-1 flex-1">
            <TabButton active={tab === 'students'} onClick={() => setTab('students')}>학생 관리</TabButton>
            <TabButton active={tab === 'weekly'} onClick={() => setTab('weekly')}>주차별 현황</TabButton>
            <TabButton active={tab === 'stats'} onClick={() => { setTab('stats'); fetchAllRecords() }}>누적 통계</TabButton>
            <TabButton active={tab === 'absence'} onClick={() => setTab('absence')}>재등원 관리</TabButton>
            <TabButton active={tab === 'daily'} onClick={() => setTab('daily')}>일별 조회</TabButton>
          </div>
          <button
            onClick={() => { setShowRegisterModal(true); setShowRegisterConfirm(false); setFormError('') }}
            className="bg-blue-500 hover:bg-blue-600 text-white text-sm font-semibold px-4 py-2.5 rounded-xl shadow-sm shadow-blue-200 transition-all whitespace-nowrap"
          >
            + 학생 등록
          </button>
        </div>
      </div>

      {/* ── 학생 관리 탭 ── */}
      {tab === 'students' && (
        <div className="px-6 space-y-3 pb-8 max-w-screen-2xl mx-auto pt-4">
          {/* 필터 바 */}
          <div className="flex items-center gap-2 flex-wrap">
            <input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="학생 이름 검색..."
              className="bg-white border border-gray-200 rounded-xl px-3 py-2 text-sm focus:outline-none focus:border-blue-400 w-44 shadow-sm"
            />
            <select
              value={schoolFilter}
              onChange={(e) => setSchoolFilter(e.target.value)}
              className="bg-white border border-gray-200 rounded-xl px-3 py-2 text-sm focus:outline-none focus:border-blue-400 text-gray-700 w-36 shadow-sm"
            >
              <option value="">전체 학교</option>
              {schools.map(s => <option key={s} value={s}>{s}</option>)}
            </select>
            <select
              value={classFilter}
              onChange={(e) => setClassFilter(e.target.value)}
              className="bg-white border border-gray-200 rounded-xl px-3 py-2 text-sm focus:outline-none focus:border-blue-400 text-gray-700 w-32 shadow-sm"
            >
              <option value="">전체 선생님</option>
              {classes.map(c => <option key={c} value={c}>{c}</option>)}
            </select>
            <div className="flex gap-1">
              {['', '월', '화', '수', '목', '금'].map((d) => (
                <button
                  key={d}
                  onClick={() => setDayFilter(d)}
                  className={`px-3 py-2 rounded-xl text-xs font-semibold transition-all ${
                    dayFilter === d ? 'bg-blue-500 text-white shadow-sm shadow-blue-200' : 'bg-white border border-gray-200 text-gray-500 hover:border-blue-300 shadow-sm'
                  }`}
                >
                  {d || '전체'}
                </button>
              ))}
            </div>
          </div>
          {/* 학생 목록 */}
          <div className="bg-white rounded-3xl shadow-md shadow-slate-100 overflow-hidden">
            <div className="px-5 py-4 border-b border-slate-100 flex items-center justify-between">
              <span className="font-bold text-gray-800 text-sm">
                전체 학생 <span className="text-blue-500">{filteredStudents.length}명</span>{search && <span className="text-gray-400 font-normal text-xs ml-1">/ 검색결과</span>}
              </span>
              <button
                onClick={() => handlePrintCodes(filteredStudents)}
                className="text-xs text-gray-500 hover:text-blue-600 bg-gray-100 hover:bg-blue-50 rounded-xl px-2.5 py-1.5 transition-colors"
              >
                코드 목록 인쇄
              </button>
            </div>
            {filteredStudents.length === 0 ? (
              <div className="py-16 text-center text-gray-400 text-sm font-medium">
                {search ? `"${search}" 검색 결과가 없습니다.` : '등록된 학생이 없습니다.'}
              </div>
            ) : (
              <div className="divide-y divide-slate-100/80">
                {filteredStudents.map((s, i) => {
                  const avatarColors = [
                    'bg-blue-100 text-blue-600', 'bg-violet-100 text-violet-600',
                    'bg-emerald-100 text-emerald-600', 'bg-amber-100 text-amber-600',
                    'bg-rose-100 text-rose-600', 'bg-cyan-100 text-cyan-600',
                  ]
                  const avatarColor = avatarColors[i % avatarColors.length]
                  return (
                    <div key={s.id} className="px-5 py-3.5 flex items-center justify-between hover:bg-slate-50/80 transition-colors">
                      <div className="flex items-center gap-3">
                        <div className={`w-9 h-9 rounded-2xl flex items-center justify-center font-bold text-sm flex-shrink-0 ${avatarColor}`}>
                          {s.name[0]}
                        </div>
                        <div>
                          <div
                            className="font-semibold text-gray-900 text-sm cursor-pointer hover:text-blue-600 transition-colors"
                            onClick={() => openStudentHistory(s)}
                          >{s.name}</div>
                          <div className="text-xs text-gray-400 mt-0.5">
                            {s.class} · {s.school}
                            {s.oral_type && <span className="text-purple-400"> · {s.oral_type}</span>}
                            {s.clinic_day && <span className="text-blue-400"> · {s.clinic_day}요일</span>}
                          </div>
                        </div>
                      </div>
                      <div className="flex items-center gap-2">
                        <button
                          onClick={() => navigator.clipboard.writeText(s.code)}
                          title="코드 복사"
                          className="font-mono text-sm font-bold text-blue-600 bg-blue-50 hover:bg-blue-100 px-3 py-1.5 rounded-xl transition-colors"
                        >
                          {s.code}
                        </button>
                        <button
                          onClick={() => setEditTarget(s)}
                          className="text-xs text-gray-400 hover:text-blue-500 bg-gray-100 hover:bg-blue-50 px-2.5 py-1.5 rounded-xl transition-colors"
                          title="정보 수정"
                        >
                          ✎
                        </button>
                        <button
                          onClick={() => handleDeleteStudent(s.id, s.name)}
                          className="text-xs text-gray-300 hover:text-red-400 hover:bg-red-50 px-2.5 py-1.5 rounded-xl transition-colors"
                          title="학생 삭제"
                        >
                          ✕
                        </button>
                      </div>
                    </div>
                  )
                })}
              </div>
            )}
          </div>
        </div>
      )}

      {/* ── 주차별 현황 탭 ── */}
      {tab === 'weekly' && (
        <div className="px-6 space-y-3 pb-8 max-w-screen-2xl mx-auto pt-4">
          {/* 학기 관리 */}
          <div className="bg-white rounded-3xl shadow-md shadow-slate-100 p-5 space-y-3">
            <div className="flex items-center justify-between">
              <span className="text-sm font-bold text-gray-800">학기 선택</span>
              <button
                onClick={() => { setShowTermModal(true); setTermFormError(''); setNewTermName(''); setNewTermDate('') }}
                className="bg-blue-500 hover:bg-blue-600 text-white text-xs font-semibold px-3 py-1.5 rounded-xl shadow-sm shadow-blue-200 transition-all"
              >
                + 학기 추가
              </button>
            </div>
            {terms.length === 0 ? (
              <p className="text-xs text-gray-400">등록된 학기가 없습니다.</p>
            ) : (
              <div className="flex gap-2 flex-wrap">
                {terms.map(t => (
                  <div key={t.id} className="flex items-center gap-1">
                    <button
                      onClick={() => { setSelectedTermId(t.id); setSelectedWeek('') }}
                      className={`px-3 py-1.5 rounded-xl text-sm font-semibold transition-all ${
                        selectedTermId === t.id ? 'bg-blue-500 text-white shadow-sm shadow-blue-200' : 'bg-slate-100 text-gray-600 hover:bg-slate-200'
                      }`}
                    >
                      {t.name}
                      <span className="ml-1.5 text-xs opacity-60">{t.start_date}</span>
                    </button>
                    <button
                      onClick={() => handleDeleteTerm(t.id, t.name)}
                      className="text-xs text-gray-300 hover:text-red-400 hover:bg-red-50 px-1.5 py-1 rounded-xl transition-colors"
                    >
                      ✕
                    </button>
                  </div>
                ))}
              </div>
            )}
          </div>

          {loading ? (
            <div className="py-16 text-center text-gray-400 text-sm font-medium">불러오는 중...</div>
          ) : weekStarts.length === 0 ? (
            <div className="py-16 text-center text-gray-400 text-sm font-medium">출석 기록이 없습니다.</div>
          ) : (
            <>
              {/* 주차별 전용 필터 */}
              <div className="flex items-center gap-2 flex-wrap">
                <input
                  value={weeklySearch}
                  onChange={(e) => setWeeklySearch(e.target.value)}
                  placeholder="학생 이름 검색..."
                  className="bg-white border border-gray-200 rounded-xl px-3 py-2 text-sm focus:outline-none focus:border-blue-400 w-40 shadow-sm"
                />
                <select
                  value={weeklySchoolFilter}
                  onChange={(e) => setWeeklySchoolFilter(e.target.value)}
                  className="bg-white border border-gray-200 rounded-xl px-3 py-2 text-sm focus:outline-none focus:border-blue-400 text-gray-700 w-36 shadow-sm"
                >
                  <option value="">전체 학교</option>
                  {schools.map(s => <option key={s} value={s}>{s}</option>)}
                </select>
                <select
                  value={weeklyClassFilter}
                  onChange={(e) => setWeeklyClassFilter(e.target.value)}
                  className="bg-white border border-gray-200 rounded-xl px-3 py-2 text-sm focus:outline-none focus:border-blue-400 text-gray-700 w-32 shadow-sm"
                >
                  <option value="">전체 선생님</option>
                  {classes.map(c => <option key={c} value={c}>{c}</option>)}
                </select>
                <div className="flex gap-1">
                  {['', '월', '화', '수', '목', '금', '토', '일'].map((d) => (
                    <button
                      key={d}
                      onClick={() => setWeeklyDayFilter(d)}
                      className={`px-3 py-2 rounded-xl text-xs font-semibold transition-all ${
                        weeklyDayFilter === d ? 'bg-blue-500 text-white shadow-sm shadow-blue-200' : 'bg-white border border-gray-200 text-gray-500 hover:border-blue-300 shadow-sm'
                      }`}
                    >
                      {d || '전체'}
                    </button>
                  ))}
                </div>
                {(weeklySearch || weeklyDayFilter || weeklySchoolFilter || weeklyClassFilter) && (
                  <button
                    onClick={() => { setWeeklySearch(''); setWeeklyDayFilter(''); setWeeklySchoolFilter(''); setWeeklyClassFilter('') }}
                    className="text-xs text-gray-400 hover:text-red-500 bg-white border border-gray-200 rounded-xl px-2.5 py-2 transition-colors shadow-sm"
                  >
                    필터 초기화
                  </button>
                )}
              </div>

              {/* 주차 선택 */}
              <div className="flex gap-2 flex-wrap">
                <button
                  onClick={() => setSelectedWeek('all')}
                  className={`px-4 py-2 rounded-full text-sm font-medium transition-colors ${
                    selectedWeek === 'all'
                      ? 'bg-purple-600 text-white'
                      : 'bg-white border border-gray-200 text-gray-600 hover:border-purple-300'
                  }`}
                >
                  전체 주차
                </button>
                {weekStarts.map((ws) => (
                  <button
                    key={ws}
                    onClick={() => setSelectedWeek(ws)}
                    className={`px-4 py-2 rounded-full text-sm font-medium transition-colors ${
                      selectedWeek === ws
                        ? 'bg-blue-600 text-white'
                        : 'bg-white border border-gray-200 text-gray-600 hover:border-blue-300'
                    }`}
                  >
                    {weekLabel(ws, selectedTerm?.start_date ?? ws)}
                    <span className="ml-1.5 text-xs opacity-70">{ws}</span>
                  </button>
                ))}
              </div>

              {/* 전체 주차 뷰 출석 추가 버튼 */}
              {selectedWeek === 'all' && (
                <div className="flex justify-end">
                  <button
                    onClick={openAddRecordModal}
                    className="flex items-center gap-1.5 bg-indigo-50 hover:bg-indigo-100 border border-indigo-200 text-indigo-700 font-semibold px-4 py-2 rounded-xl text-sm transition-colors"
                  >
                    + 출석 추가
                  </button>
                </div>
              )}

              {/* ── 전체 주차 피벗 뷰 ── */}
              {selectedWeek === 'all' && (() => {
                const filteredAll = termRecords
                  .filter(r => r.students.name.includes(weeklySearch.trim()))
                  .filter(r => !weeklyDayFilter || r.students.clinic_day === weeklyDayFilter)
                  .filter(r => !weeklySchoolFilter || r.students.school === weeklySchoolFilter)
                  .filter(r => !weeklyClassFilter || r.students.class === weeklyClassFilter)

                // 학생별 { student, records: { weekStart → record } } 피벗
                const studentMap: Record<string, { student: AttendanceWithStudent['students']; records: Record<string, AttendanceWithStudent> }> = {}
                filteredAll.forEach(r => {
                  if (!studentMap[r.student_id]) studentMap[r.student_id] = { student: r.students, records: {} }
                  const ws = getWeekStart(r.date)
                  // 같은 주에 여러 기록이면 최신 것으로
                  if (!studentMap[r.student_id].records[ws] || r.date > studentMap[r.student_id].records[ws].date) {
                    studentMap[r.student_id].records[ws] = r
                  }
                })

                // 반별 그룹핑 후 가나다 정렬
                const grouped: Record<string, typeof studentMap[string][]> = {}
                Object.values(studentMap).forEach(s => {
                  const key = `${s.student.school} (${s.student.class})`
                  if (!grouped[key]) grouped[key] = []
                  grouped[key].push(s)
                })
                Object.values(grouped).forEach(arr => arr.sort((a, b) => a.student.name.localeCompare(b.student.name, 'ko')))
                const sortedGroups = Object.entries(grouped).sort(([a], [b]) => a.localeCompare(b, 'ko'))

                const WEEK_COLS = 12

                return (
                  <div className="bg-white rounded-3xl shadow-md shadow-slate-100 overflow-hidden">
                    <div className="overflow-x-auto">
                      <table className="text-xs border-collapse" style={{ minWidth: 'max-content' }}>
                        <thead>
                          <tr className="bg-gray-50 border-b border-gray-200">
                            <th className="px-3 py-2.5 text-left font-semibold text-gray-600 border-r border-gray-200 sticky left-0 bg-gray-50 z-10" rowSpan={2}>이름</th>
                            <th className="px-3 py-2.5 text-left font-semibold text-gray-600 border-r border-gray-200 whitespace-nowrap" rowSpan={2}>구두 방식</th>
                            <th className="px-3 py-2.5 text-center font-semibold text-gray-600 border-r border-gray-200" rowSpan={2}>요일</th>
                            {weekStarts.map((ws, wsIdx) => (
                              <th key={ws} colSpan={WEEK_COLS} className={`px-3 py-2 text-center font-bold border-r border-blue-200 whitespace-nowrap ${wsIdx % 2 === 0 ? 'bg-indigo-100 text-indigo-700' : 'bg-blue-50 text-blue-700'}`}>
                                {weekLabel(ws, selectedTerm?.start_date ?? ws)}
                                <span className="ml-1.5 text-xs font-normal opacity-60">{ws}</span>
                              </th>
                            ))}
                          </tr>
                          <tr className="border-b border-gray-200">
                            {weekStarts.map((ws, wsIdx) => (
                              <>
                                <th key={`${ws}-1`} className={`px-2 py-2 text-center font-medium text-gray-500 border-r border-gray-100 whitespace-nowrap ${wsIdx % 2 === 0 ? 'bg-indigo-50' : 'bg-gray-50'}`}>클리닉</th>
                                <th key={`${ws}-2`} className={`px-2 py-2 text-center font-medium text-gray-500 border-r border-gray-100 whitespace-nowrap ${wsIdx % 2 === 0 ? 'bg-indigo-50' : 'bg-gray-50'}`}>등원</th>
                                <th key={`${ws}-3`} className={`px-2 py-2 text-center font-medium text-gray-500 border-r border-gray-100 whitespace-nowrap ${wsIdx % 2 === 0 ? 'bg-indigo-50' : 'bg-gray-50'}`}>하원</th>
                                <th key={`${ws}-4`} className={`px-2 py-2 text-center font-medium text-gray-500 border-r border-gray-100 whitespace-nowrap ${wsIdx % 2 === 0 ? 'bg-indigo-50' : 'bg-gray-50'}`}>단어/클리닉</th>
                                <th key={`${ws}-5`} className={`px-2 py-2 text-center font-medium text-gray-500 border-r border-gray-100 whitespace-nowrap ${wsIdx % 2 === 0 ? 'bg-indigo-50' : 'bg-gray-50'}`}>과제</th>
                                <th key={`${ws}-6`} className={`px-2 py-2 text-center font-medium text-gray-500 border-r border-gray-100 whitespace-nowrap ${wsIdx % 2 === 0 ? 'bg-indigo-50' : 'bg-gray-50'}`}>구두</th>
                                <th key={`${ws}-7`} className={`px-2 py-2 text-center font-medium text-blue-400 border-r border-gray-100 whitespace-nowrap ${wsIdx % 2 === 0 ? 'bg-indigo-50' : 'bg-gray-50'}`}>구두메모</th>
                                <th key={`${ws}-8`} className={`px-2 py-2 text-center font-medium text-purple-400 border-r border-gray-100 whitespace-nowrap ${wsIdx % 2 === 0 ? 'bg-indigo-50' : 'bg-gray-50'}`}>과제메모</th>
                                <th key={`${ws}-9`} className={`px-2 py-2 text-center font-medium text-gray-500 border-r border-gray-100 whitespace-nowrap ${wsIdx % 2 === 0 ? 'bg-indigo-50' : 'bg-gray-50'}`}>기타</th>
                                <th key={`${ws}-11`} className={`px-2 py-2 text-center font-medium text-amber-500 border-r border-gray-100 whitespace-nowrap ${wsIdx % 2 === 0 ? 'bg-indigo-50' : 'bg-gray-50'}`}>직보</th>
                                <th key={`${ws}-12`} className={`px-2 py-2 text-center font-medium text-green-600 border-r border-gray-100 whitespace-nowrap ${wsIdx % 2 === 0 ? 'bg-indigo-50' : 'bg-gray-50'}`}>알림장</th>
                                <th key={`${ws}-10`} className={`px-2 py-2 text-center font-medium text-gray-500 border-r border-gray-200 whitespace-nowrap ${wsIdx % 2 === 0 ? 'bg-indigo-50' : 'bg-gray-50'}`}>다음클리닉</th>
                              </>
                            ))}
                          </tr>
                        </thead>
                        <tbody>
                          {sortedGroups.map(([classKey, rows]) => (
                            <>
                              <tr key={classKey + '-hdr'} className="bg-purple-50 border-y border-purple-100">
                                <td
                                  colSpan={3 + weekStarts.length * WEEK_COLS}
                                  className="px-3 py-2 font-semibold text-purple-800 text-xs sticky left-0"
                                >
                                  {classKey}
                                  <span className="ml-2 font-normal text-purple-400">{rows.length}명</span>
                                </td>
                              </tr>
                              {rows.map(({ student, records }) => (
                                <tr key={student.id} className="border-b border-gray-50 hover:bg-gray-50 transition-colors">
                                  <td className="px-3 py-2 font-medium text-gray-900 whitespace-nowrap border-r border-gray-100 sticky left-0 bg-white">
                                    <span className="cursor-pointer hover:text-blue-600 transition-colors" onClick={() => openStudentHistory(student as Student)}>{student.name}</span>
                                  </td>
                                  <td className="px-3 py-2 text-gray-500 whitespace-nowrap border-r border-gray-100">{student.oral_type || '-'}</td>
                                  <td className="px-3 py-2 text-center text-gray-500 border-r border-gray-100">{student.clinic_day || '-'}</td>
                                  {weekStarts.map((ws, wsIdx) => {
                                    const isOdd = wsIdx % 2 === 0
                                    const oddBg = isOdd ? 'bg-indigo-50/50' : ''
                                    const r = records[ws]
                                    if (!r) return (
                                      <>
                                        {Array.from({ length: WEEK_COLS }).map((_, i) => (
                                          <td key={`${ws}-empty-${i}`} className={`px-2 py-2 border-r ${i === WEEK_COLS - 1 ? 'border-gray-200' : 'border-gray-100'} ${isOdd ? 'bg-indigo-50/30' : 'bg-gray-50/20'}`} />
                                        ))}
                                      </>
                                    )
                                    const checkinTime = r.approved_at
                                      ? new Date(r.approved_at).toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit' })
                                      : '-'
                                    const checkoutTime = r.checked_out_at
                                      ? new Date(r.checked_out_at).toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit' })
                                      : '-'
                                    const score = [r.word_score, r.clinic_score].filter(Boolean).join(' / ') || '-'
                                    const hwLabel: Record<string, string> = { pass: 'Pass', fail: 'Fail', delay: 'Delay', partial_pass: '일부P', exempt: '면제', word_pass: '단어P', sentence_pass: '문장P' }
                                    const hw = r.homework ? (hwLabel[r.homework] ?? r.homework) : '-'
                                    const oralLabel: Record<string, string> = { pass: 'Pass', fail: 'Fail', delay: 'Delay', partial_pass: '일부P', exempt: '면제', word_pass: '단어P', sentence_pass: '문장P' }
                                    const oral = r.oral_status ? (oralLabel[r.oral_status] ?? r.oral_status) : '-'
                                    return (
                                      <>
                                        <td key={`${ws}-att`} className={`px-2 py-2 text-center border-r border-gray-100 ${oddBg}`}>
                                          {r.status === 'approved' ? <span className="text-green-600 font-bold">○</span> : <span className="text-gray-300">-</span>}
                                        </td>
                                        <td key={`${ws}-in`} className={`px-2 py-2 text-center text-gray-600 whitespace-nowrap border-r border-gray-100 ${oddBg}`}>{checkinTime}</td>
                                        <td key={`${ws}-out`} className={`px-2 py-2 text-center text-gray-600 whitespace-nowrap border-r border-gray-100 ${oddBg}`}>{checkoutTime}</td>
                                        <td key={`${ws}-score`} className={`px-2 py-2 text-center text-gray-700 whitespace-nowrap border-r border-gray-100 ${oddBg}`}>{score}</td>
                                        <td key={`${ws}-hw`} className={`px-2 py-2 text-center whitespace-nowrap border-r border-gray-100 ${oddBg}`}>
                                          <span className={hw === 'Pass' ? 'text-green-600 font-medium' : hw === 'Fail' ? 'text-red-500' : hw === 'Delay' ? 'text-yellow-600' : 'text-gray-600'}>{hw}</span>
                                        </td>
                                        <td key={`${ws}-oral`} className={`px-2 py-2 text-center whitespace-nowrap border-r border-gray-100 ${oddBg}`}>
                                          <span className={oral === 'Pass' ? 'text-green-600 font-medium' : oral === 'Fail' ? 'text-red-500' : oral === 'Delay' ? 'text-yellow-600' : 'text-gray-600'}>{oral}</span>
                                        </td>
                                        <td key={`${ws}-oralmemo`} className={`px-2 py-2 border-r border-gray-100 ${oddBg}`}>
                                          {r.oral_memo
                                            ? <button onClick={() => setPivotNotesModal({ name: student.name, week: weekLabel(ws, selectedTerm?.start_date ?? ws), oralMemo: r.oral_memo ?? '', homeworkMemo: r.homework_memo ?? '', notes: r.notes ?? '' })} className="text-blue-500 hover:text-blue-700 text-xs truncate max-w-[80px] block text-left transition-colors" title={r.oral_memo}>{r.oral_memo}</button>
                                            : <span className="text-gray-300 text-xs">-</span>
                                          }
                                        </td>
                                        <td key={`${ws}-hwmemo`} className={`px-2 py-2 border-r border-gray-100 ${oddBg}`}>
                                          {r.homework_memo
                                            ? <button onClick={() => setPivotNotesModal({ name: student.name, week: weekLabel(ws, selectedTerm?.start_date ?? ws), oralMemo: r.oral_memo ?? '', homeworkMemo: r.homework_memo ?? '', notes: r.notes ?? '' })} className="text-purple-500 hover:text-purple-700 text-xs truncate max-w-[80px] block text-left transition-colors" title={r.homework_memo}>{r.homework_memo}</button>
                                            : <span className="text-gray-300 text-xs">-</span>
                                          }
                                        </td>
                                        <td key={`${ws}-notes`} className={`px-2 py-2 border-r border-gray-100 ${oddBg}`}>
                                          {r.notes
                                            ? <button onClick={() => setPivotNotesModal({ name: student.name, week: weekLabel(ws, selectedTerm?.start_date ?? ws), oralMemo: r.oral_memo ?? '', homeworkMemo: r.homework_memo ?? '', notes: r.notes ?? '' })} className="text-gray-500 hover:text-gray-700 text-xs truncate max-w-[80px] block text-left transition-colors" title={r.notes}>{r.notes}</button>
                                            : <span className="text-gray-300 text-xs">-</span>
                                          }
                                        </td>
                                        <td key={`${ws}-jikbo`} className={`px-2 py-2 text-center border-r border-gray-100 ${oddBg}`}>
                                          {r.jikbo_score
                                            ? <span className="text-amber-600 font-semibold text-xs">{r.jikbo_score}</span>
                                            : <span className="text-gray-300 text-xs">-</span>}
                                        </td>
                                        <td key={`${ws}-pmemo`} className={`px-2 py-2 border-r border-gray-100 ${oddBg}`}>
                                          {r.parent_memo
                                            ? <span className="text-green-700 text-xs truncate max-w-[80px] block" title={r.parent_memo}>{r.parent_memo}</span>
                                            : <span className="text-gray-300 text-xs">-</span>}
                                        </td>
                                        <td key={`${ws}-next`} className={`px-2 py-2 text-center text-gray-500 whitespace-nowrap border-r border-gray-200 ${oddBg}`}>{r.next_clinic_date || '-'}</td>
                                      </>
                                    )
                                  })}
                                </tr>
                              ))}
                            </>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </div>
                )
              })()}

              {/* 전체 주차 기타 모달 */}
              {pivotNotesModal && createPortal(
                <div className="fixed inset-0 bg-black/30 backdrop-blur-sm flex items-center justify-center z-50 p-4" onClick={() => setPivotNotesModal(null)}>
                  <div className="bg-white rounded-3xl w-full max-w-sm p-6 shadow-2xl" onClick={e => e.stopPropagation()}>
                    <div className="flex items-center justify-between mb-1">
                      <h3 className="font-semibold text-gray-800">{pivotNotesModal.name} 학생</h3>
                      <button onClick={() => setPivotNotesModal(null)} className="text-gray-400 hover:text-gray-600 text-lg">✕</button>
                    </div>
                    <p className="text-xs text-gray-400 mb-4">{pivotNotesModal.week} · 메모</p>
                    <div className="space-y-3">
                      {pivotNotesModal.oralMemo && (
                        <div>
                          <p className="text-xs font-medium text-blue-500 mb-1">구두 메모</p>
                          <p className="text-sm text-gray-700 whitespace-pre-wrap bg-blue-50 rounded-xl px-4 py-3 leading-relaxed">{pivotNotesModal.oralMemo}</p>
                        </div>
                      )}
                      {pivotNotesModal.homeworkMemo && (
                        <div>
                          <p className="text-xs font-medium text-purple-500 mb-1">과제 메모</p>
                          <p className="text-sm text-gray-700 whitespace-pre-wrap bg-purple-50 rounded-xl px-4 py-3 leading-relaxed">{pivotNotesModal.homeworkMemo}</p>
                        </div>
                      )}
                      {pivotNotesModal.notes && (
                        <div>
                          <p className="text-xs font-medium text-gray-500 mb-1">기타 메모</p>
                          <p className="text-sm text-gray-700 whitespace-pre-wrap bg-gray-50 rounded-xl px-4 py-3 leading-relaxed">{pivotNotesModal.notes}</p>
                        </div>
                      )}
                    </div>
                    <button
                      onClick={() => setPivotNotesModal(null)}
                      className="w-full mt-4 py-3 rounded-2xl bg-slate-100 hover:bg-slate-200 text-sm text-gray-600 font-medium transition-colors"
                    >
                      닫기
                    </button>
                  </div>
                </div>,
                document.body
              )}

              {/* 주차 헤더 + 엑셀 버튼 */}
              {selectedWeek && selectedWeek !== 'all' && (
                <>
                  <div className="flex items-center justify-between">
                    <h2 className="font-bold text-gray-800">
                      {weekLabel(selectedWeek, selectedTerm?.start_date ?? selectedWeek)}
                      <span className="ml-2 text-sm font-normal text-gray-400">{selectedWeek} 주</span>
                    </h2>
                    <div className="flex items-center gap-2">
                      {gsResult === 'success' && <span className="text-xs text-green-600 font-medium">✓ 구글시트 전송 완료</span>}
                      {gsResult === 'error' && <span className="text-xs text-red-500 font-medium">전송 실패, 다시 시도해주세요</span>}
                      <button
                        onClick={openAddRecordModal}
                        className="flex items-center gap-1.5 bg-indigo-50 hover:bg-indigo-100 border border-indigo-200 text-indigo-700 font-semibold px-4 py-2 rounded-xl text-sm transition-colors"
                      >
                        + 출석 추가
                      </button>
                      <button
                        onClick={() => handleGoogleSheetUpload(selectedWeek, weekRecords, weekLabel(selectedWeek, selectedTerm?.start_date ?? selectedWeek))}
                        disabled={weekRecords.length === 0 || gsLoading}
                        className="flex items-center gap-1.5 bg-white hover:bg-gray-50 disabled:bg-gray-100 border border-gray-200 text-gray-700 font-semibold px-4 py-2 rounded-xl text-sm transition-colors"
                      >
                        <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none">
                          <rect x="3" y="3" width="18" height="18" rx="2" fill="#0F9D58"/>
                          <path d="M7 8h10M7 12h10M7 16h6" stroke="white" strokeWidth="1.5" strokeLinecap="round"/>
                        </svg>
                        {gsLoading ? '전송 중...' : '구글시트 전송'}
                      </button>
                      <button
                        onClick={() => handleExcelDownload(selectedWeek, weekRecords, weekLabel(selectedWeek, selectedTerm?.start_date ?? selectedWeek))}
                        disabled={weekRecords.length === 0}
                        className="bg-green-600 hover:bg-green-700 disabled:bg-gray-300 text-white font-semibold px-4 py-2 rounded-xl text-sm transition-colors"
                      >
                        엑셀 다운로드
                      </button>
                    </div>
                  </div>

                  {weekRecords.length === 0 ? (
                    <div className="py-10 text-center text-gray-400 text-sm">해당 주차 기록이 없습니다.</div>
                  ) : (
                    /* 반별 테이블 */
                    Object.entries(groupedByClass).map(([classKey, classRecords]) => (
                      <div key={classKey} className="bg-white rounded-3xl shadow-md shadow-slate-100 overflow-hidden">
                        <div className="px-4 py-3 border-b border-gray-100 bg-gray-50">
                          <span className="font-semibold text-gray-800 text-sm">{classKey}</span>
                          <span className="ml-2 text-xs text-gray-400">{classRecords.length}명</span>
                        </div>
                        <div className="overflow-x-auto">
                          <table className="w-full text-sm">
                            <thead>
                              <tr className="border-b border-gray-100">
                                <th className="px-3 py-2.5 text-left text-xs font-semibold text-gray-500">이름</th>
                                <th className="px-3 py-2.5 text-center text-xs font-semibold text-gray-500"></th>
                                <th className="px-3 py-2.5 text-left text-xs font-semibold text-gray-500">구두 방식</th>
                                <th className="px-3 py-2.5 text-center text-xs font-semibold text-gray-500">요일</th>
                                <th className="px-3 py-2.5 text-center text-xs font-semibold text-gray-500">출석</th>
                                <th className="px-3 py-2.5 text-center text-xs font-semibold text-gray-500">등원</th>
                                <th className="px-3 py-2.5 text-center text-xs font-semibold text-gray-500">재등원</th>
                                <th className="px-3 py-2.5 text-center text-xs font-semibold text-gray-500">하원</th>
                                <th className="px-3 py-2.5 text-center text-xs font-semibold text-gray-500">단어</th>
                                <th className="px-3 py-2.5 text-center text-xs font-semibold text-gray-500">클리닉</th>
                                <th className="px-3 py-2.5 text-center text-xs font-semibold text-gray-500">구두</th>
                                <th className="px-3 py-2.5 text-left text-xs font-semibold text-gray-500">미완료 과제</th>
                                <th className="px-3 py-2.5 text-left text-xs font-semibold text-blue-400">구두메모</th>
                                <th className="px-3 py-2.5 text-left text-xs font-semibold text-purple-400">과제메모</th>
                                <th className="px-3 py-2.5 text-left text-xs font-semibold text-gray-500">기타</th>
                                <th className="px-3 py-2.5 text-center text-xs font-semibold text-amber-500">직보</th>
                                <th className="px-3 py-2.5 text-left text-xs font-semibold text-green-600">알림장</th>
                              </tr>
                            </thead>
                            <tbody className="divide-y divide-gray-50">
                              {classRecords.map((r) => (
                                <WeeklyRow
                                  key={r.id}
                                  record={r}
                                  onUpdate={() => fetchAllRecords(true)}
                                  onNameClick={() => openStudentHistory(r.students)}
                                />
                              ))}
                            </tbody>
                          </table>
                        </div>
                      </div>
                    ))
                  )}
                </>
              )}
            </>
          )}
        </div>
      )}

      {/* ── 출석 추가 모달 ── */}
      {showAddRecordModal && (() => {
        const isAllWeeks = !selectedWeek || selectedWeek === 'all'
        const weekDates = !isAllWeeks
          ? Array.from({ length: 7 }, (_, i) => {
              const d = new Date(selectedWeek + 'T00:00:00')
              d.setDate(d.getDate() + i)
              const str = `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`
              const dayNames = ['일','월','화','수','목','금','토']
              return { value: str, label: `${d.getMonth()+1}/${d.getDate()}(${dayNames[d.getDay()]})` }
            })
          : []
        const modalSchools = [...new Set(students.map(s => s.school))].filter(Boolean).sort()
        const modalClasses = [...new Set(
          students
            .filter(s => !addRecordSchoolFilter || s.school === addRecordSchoolFilter)
            .map(s => s.class)
        )].filter(Boolean).sort()
        const filteredModalStudents = [...students]
          .filter(s => !addRecordSchoolFilter || s.school === addRecordSchoolFilter)
          .filter(s => !addRecordClassFilter || s.class === addRecordClassFilter)
          .filter(s => !addRecordStudentSearch || s.name.includes(addRecordStudentSearch.trim()))
          .sort((a, b) => `${a.school} ${a.class} ${a.name}`.localeCompare(`${b.school} ${b.class} ${b.name}`, 'ko'))
        const selectedStudent = students.find(s => s.id === addRecordForm.student_id)

        return createPortal(
          <div className="fixed inset-0 bg-black/50 backdrop-blur-sm flex items-center justify-center z-50 p-4">
            <div className="bg-white rounded-3xl w-full max-w-4xl shadow-2xl flex flex-col max-h-[92vh]">
              {/* 헤더 */}
              <div className="px-8 py-5 border-b border-gray-100 flex items-center justify-between flex-shrink-0">
                <div>
                  <h3 className="font-bold text-gray-800 text-lg">출석 기록 추가</h3>
                  <p className="text-xs text-gray-400 mt-0.5">과거 기록을 직접 입력합니다</p>
                </div>
                <button onClick={() => setShowAddRecordModal(false)} className="text-gray-400 hover:text-gray-600 text-2xl leading-none">✕</button>
              </div>

              {/* 바디 — 좌/우 2패널 */}
              <div className="flex flex-1 overflow-hidden">

                {/* ── 좌: 학생 선택 패널 ── */}
                <div className="w-80 flex-shrink-0 border-r border-gray-100 flex flex-col">
                  <div className="px-6 pt-5 pb-3 space-y-2 flex-shrink-0">
                    <p className="text-xs font-semibold text-gray-500 uppercase tracking-wide">학생 선택</p>
                    {/* 검색 */}
                    <input
                      value={addRecordStudentSearch}
                      onChange={e => setAddRecordStudentSearch(e.target.value)}
                      placeholder="이름 검색..."
                      className="w-full border border-gray-200 rounded-xl px-3 py-2 text-sm focus:outline-none focus:border-blue-400"
                    />
                    {/* 학교 필터 */}
                    <div className="flex gap-1.5 flex-wrap">
                      <button
                        onClick={() => { setAddRecordSchoolFilter(''); setAddRecordClassFilter('') }}
                        className={`px-2.5 py-1 rounded-lg text-xs font-medium border transition-all ${!addRecordSchoolFilter ? 'bg-gray-800 text-white border-gray-800' : 'bg-white text-gray-500 border-gray-200 hover:border-gray-400'}`}
                      >전체</button>
                      {modalSchools.map(sch => (
                        <button key={sch}
                          onClick={() => { setAddRecordSchoolFilter(sch); setAddRecordClassFilter('') }}
                          className={`px-2.5 py-1 rounded-lg text-xs font-medium border transition-all ${addRecordSchoolFilter === sch ? 'bg-blue-600 text-white border-blue-600' : 'bg-white text-gray-500 border-gray-200 hover:border-blue-300'}`}
                        >{sch}</button>
                      ))}
                    </div>
                    {/* 반 필터 */}
                    {addRecordSchoolFilter && (
                      <div className="flex gap-1.5 flex-wrap">
                        <button
                          onClick={() => setAddRecordClassFilter('')}
                          className={`px-2.5 py-1 rounded-lg text-xs font-medium border transition-all ${!addRecordClassFilter ? 'bg-gray-800 text-white border-gray-800' : 'bg-white text-gray-500 border-gray-200 hover:border-gray-400'}`}
                        >전체반</button>
                        {modalClasses.map(cls => (
                          <button key={cls}
                            onClick={() => setAddRecordClassFilter(cls)}
                            className={`px-2.5 py-1 rounded-lg text-xs font-medium border transition-all ${addRecordClassFilter === cls ? 'bg-indigo-600 text-white border-indigo-600' : 'bg-white text-gray-500 border-gray-200 hover:border-indigo-300'}`}
                          >{cls}</button>
                        ))}
                      </div>
                    )}
                  </div>
                  {/* 학생 목록 */}
                  <div className="flex-1 overflow-y-auto px-3 pb-4">
                    {filteredModalStudents.length === 0
                      ? <p className="text-xs text-gray-400 text-center py-6">검색 결과 없음</p>
                      : filteredModalStudents.map(s => (
                        <button
                          key={s.id}
                          onClick={() => setAddRecordForm(f => ({ ...f, student_id: s.id }))}
                          className={`w-full text-left px-3 py-2.5 rounded-xl mb-1 transition-all ${
                            addRecordForm.student_id === s.id
                              ? 'bg-blue-600 text-white'
                              : 'hover:bg-gray-50 text-gray-800'
                          }`}
                        >
                          <span className="text-sm font-semibold">{s.name}</span>
                          <span className={`ml-2 text-xs ${addRecordForm.student_id === s.id ? 'text-blue-100' : 'text-gray-400'}`}>{s.school} · {s.class}</span>
                        </button>
                      ))
                    }
                  </div>
                </div>

                {/* ── 우: 기록 입력 패널 ── */}
                <div className="flex-1 overflow-y-auto px-8 py-5 space-y-5">
                  {/* 선택된 학생 표시 */}
                  <div className={`rounded-2xl px-4 py-3 text-sm font-medium ${selectedStudent ? 'bg-blue-50 text-blue-800' : 'bg-gray-50 text-gray-400'}`}>
                    {selectedStudent ? `${selectedStudent.name} (${selectedStudent.school} · ${selectedStudent.class})` : '← 좌측에서 학생을 선택하세요'}
                  </div>

                  {/* 날짜 */}
                  <div>
                    <label className="block text-xs font-semibold text-gray-500 uppercase tracking-wide mb-2">날짜</label>
                    {isAllWeeks ? (
                      <input
                        type="date"
                        value={addRecordForm.date}
                        onChange={e => setAddRecordForm(f => ({ ...f, date: e.target.value }))}
                        className="border border-gray-200 rounded-xl px-3 py-2 text-sm focus:outline-none focus:border-blue-400"
                      />
                    ) : (
                      <div className="flex gap-2 flex-wrap">
                        {weekDates.map(d => (
                          <button
                            key={d.value}
                            onClick={() => setAddRecordForm(f => ({ ...f, date: d.value }))}
                            className={`px-4 py-2 rounded-xl text-sm font-semibold border transition-all ${
                              addRecordForm.date === d.value
                                ? 'bg-blue-600 text-white border-blue-600'
                                : 'bg-white text-gray-600 border-gray-200 hover:border-blue-300'
                            }`}
                          >
                            {d.label}
                          </button>
                        ))}
                      </div>
                    )}
                  </div>

                  {/* 방문 유형 + 출석 상태 */}
                  <div className="grid grid-cols-2 gap-4">
                    <div>
                      <label className="block text-xs font-semibold text-gray-500 uppercase tracking-wide mb-1.5">방문 유형</label>
                      <select
                        value={addRecordForm.visit_type}
                        onChange={e => setAddRecordForm(f => ({ ...f, visit_type: e.target.value as 'class_clinic' | 'clinic' }))}
                        className="w-full border border-gray-200 rounded-xl px-3 py-2.5 text-sm focus:outline-none focus:border-blue-400"
                      >
                        <option value="class_clinic">수업+클리닉</option>
                        <option value="clinic">클리닉</option>
                      </select>
                    </div>
                    <div>
                      <label className="block text-xs font-semibold text-gray-500 uppercase tracking-wide mb-1.5">출석 상태</label>
                      <select
                        value={addRecordForm.status}
                        onChange={e => setAddRecordForm(f => ({ ...f, status: e.target.value as 'approved' | 'absent' }))}
                        className="w-full border border-gray-200 rounded-xl px-3 py-2.5 text-sm focus:outline-none focus:border-blue-400"
                      >
                        <option value="approved">출석 완료</option>
                        <option value="absent">결석</option>
                      </select>
                    </div>
                  </div>

                  {/* 출석 완료일 때만: 점수·메모 */}
                  {addRecordForm.status === 'approved' && (
                    <>
                      <div className="border-t border-gray-100 pt-4">
                        <p className="text-xs font-semibold text-gray-400 uppercase tracking-wide mb-3">점수</p>
                        <div className="grid grid-cols-2 gap-4">
                          <div>
                            <label className="block text-xs font-medium text-gray-500 mb-1">단어 점수</label>
                            <input
                              value={addRecordForm.word_score}
                              onChange={e => setAddRecordForm(f => ({ ...f, word_score: e.target.value }))}
                              placeholder="예: 85"
                              className="w-full border border-gray-200 rounded-xl px-3 py-2 text-sm focus:outline-none focus:border-blue-400"
                            />
                          </div>
                          <div>
                            <label className="block text-xs font-medium text-gray-500 mb-1">클리닉 점수</label>
                            <input
                              value={addRecordForm.clinic_score}
                              onChange={e => setAddRecordForm(f => ({ ...f, clinic_score: e.target.value }))}
                              placeholder="예: 90"
                              className="w-full border border-gray-200 rounded-xl px-3 py-2 text-sm focus:outline-none focus:border-blue-400"
                            />
                          </div>
                          <div>
                            <label className="block text-xs font-medium text-gray-500 mb-1">구두</label>
                            <select
                              value={addRecordForm.oral_status}
                              onChange={e => setAddRecordForm(f => ({ ...f, oral_status: e.target.value }))}
                              className="w-full border border-gray-200 rounded-xl px-3 py-2 text-sm focus:outline-none focus:border-blue-400"
                            >
                              <option value="">-</option>
                              <option value="pass">Pass</option>
                              <option value="word_pass">단어Pass</option>
                              <option value="sentence_pass">문장Pass</option>
                              <option value="exempt">면제</option>
                              <option value="fail">Fail</option>
                              <option value="delay">Delay</option>
                            </select>
                          </div>
                          <div>
                            <label className="block text-xs font-medium text-gray-500 mb-1">과제</label>
                            <select
                              value={addRecordForm.homework}
                              onChange={e => setAddRecordForm(f => ({ ...f, homework: e.target.value }))}
                              className="w-full border border-gray-200 rounded-xl px-3 py-2 text-sm focus:outline-none focus:border-blue-400"
                            >
                              <option value="">-</option>
                              <option value="pass">Pass</option>
                              <option value="partial_pass">일부Pass</option>
                              <option value="fail">Fail</option>
                              <option value="delay">Delay</option>
                            </select>
                          </div>
                        </div>
                      </div>
                      <div className="border-t border-gray-100 pt-4">
                        <p className="text-xs font-semibold text-gray-400 uppercase tracking-wide mb-3">메모</p>
                        <div className="space-y-3">
                          <div>
                            <label className="block text-xs font-medium text-blue-500 mb-1">구두 메모</label>
                            <input
                              value={addRecordForm.oral_memo}
                              onChange={e => setAddRecordForm(f => ({ ...f, oral_memo: e.target.value }))}
                              placeholder="구두 관련 메모..."
                              className="w-full border border-gray-200 rounded-xl px-3 py-2 text-sm focus:outline-none focus:border-blue-400"
                            />
                          </div>
                          <div>
                            <label className="block text-xs font-medium text-purple-500 mb-1">과제 메모</label>
                            <input
                              value={addRecordForm.homework_memo}
                              onChange={e => setAddRecordForm(f => ({ ...f, homework_memo: e.target.value }))}
                              placeholder="과제 관련 메모..."
                              className="w-full border border-gray-200 rounded-xl px-3 py-2 text-sm focus:outline-none focus:border-purple-400"
                            />
                          </div>
                          <div>
                            <label className="block text-xs font-medium text-gray-500 mb-1">기타 메모</label>
                            <input
                              value={addRecordForm.notes}
                              onChange={e => setAddRecordForm(f => ({ ...f, notes: e.target.value }))}
                              placeholder="기타 메모..."
                              className="w-full border border-gray-200 rounded-xl px-3 py-2 text-sm focus:outline-none focus:border-gray-400"
                            />
                          </div>
                        </div>
                      </div>
                    </>
                  )}

                  {addRecordError && <p className="text-sm text-red-500 font-medium">{addRecordError}</p>}
                </div>
              </div>

              {/* 푸터 */}
              <div className="px-8 py-4 border-t border-gray-100 flex gap-3 flex-shrink-0">
                <button
                  onClick={() => setShowAddRecordModal(false)}
                  className="flex-1 py-3 rounded-2xl border border-gray-200 text-sm text-gray-600 hover:bg-gray-50 transition-colors font-medium"
                >
                  취소
                </button>
                <button
                  onClick={handleAddRecord}
                  disabled={addRecordLoading || !addRecordForm.student_id || !addRecordForm.date}
                  className="flex-1 py-3 rounded-2xl bg-indigo-600 hover:bg-indigo-700 disabled:bg-gray-300 text-white text-sm font-bold transition-colors"
                >
                  {addRecordLoading ? '저장 중...' : '추가'}
                </button>
              </div>
            </div>
          </div>,
          document.body
        )
      })()}

      {/* ── 누적 통계 탭 ── */}
      {tab === 'stats' && (
        <div className="px-6 pb-8 space-y-3 max-w-screen-2xl mx-auto pt-4">
          {/* 학기 선택 */}
          {terms.length > 0 && (
            <div className="flex gap-2 flex-wrap">
              {terms.map(t => (
                <button
                  key={t.id}
                  onClick={() => setSelectedTermId(t.id)}
                  className={`px-3 py-1.5 rounded-xl text-sm font-semibold transition-all ${
                    selectedTermId === t.id ? 'bg-blue-500 text-white shadow-sm shadow-blue-200' : 'bg-slate-100 text-gray-600 hover:bg-slate-200'
                  }`}
                >
                  {t.name}
                </button>
              ))}
            </div>
          )}
          {loading ? (
            <div className="py-16 text-center text-gray-400 text-sm">불러오는 중...</div>
          ) : (
            (() => {
              const totalWeeks = getWeekStarts(termRecords).length
              const statsRows = filteredStudents.map((s) => {
                const sRecords = termRecords.filter((r) => r.student_id === s.id)
                const attended = sRecords.filter((r) => r.status === 'approved').length
                const wordPass = sRecords.filter((r) => r.word_status === 'pass').length
                const wordFail = sRecords.filter((r) => r.word_status === 'fail').length
                const oralPass = sRecords.filter((r) => r.oral_status === 'pass').length
                const oralFail = sRecords.filter((r) => r.oral_status === 'fail').length
                const rate = totalWeeks > 0 ? Math.round((attended / totalWeeks) * 100) : 0
                return { s, attended, rate, wordPass, wordFail, oralPass, oralFail, total: sRecords.length }
              })

              if (statsSort.col) {
                statsRows.sort((a, b) => {
                  const val = (row: typeof a) => {
                    if (statsSort.col === 'attended') return row.attended
                    if (statsSort.col === 'rate') return row.rate
                    if (statsSort.col === 'wordPass') return row.wordPass
                    if (statsSort.col === 'oralPass') return row.oralPass
                    return 0
                  }
                  return statsSort.dir === 'desc' ? val(b) - val(a) : val(a) - val(b)
                })
              }

              function SortTh({ col, children }: { col: string; children: React.ReactNode }) {
                const active = statsSort.col === col
                const isDesc = active && statsSort.dir === 'desc'
                return (
                  <th
                    className="px-3 py-2.5 text-center text-xs font-semibold text-gray-500 cursor-pointer select-none hover:text-blue-600 whitespace-nowrap"
                    onClick={() => setStatsSort(active ? { col, dir: isDesc ? 'asc' : 'desc' } : { col, dir: 'desc' })}
                  >
                    {children}
                    <span className="ml-1 inline-block">
                      {active ? (isDesc ? '↓' : '↑') : <span className="text-gray-300">↕</span>}
                    </span>
                  </th>
                )
              }

              return (
                <div className="bg-white rounded-3xl shadow-md shadow-slate-100 overflow-hidden">
                  <div className="px-4 py-3 border-b border-gray-100 bg-gray-50 flex items-center justify-between">
                    <span className="font-semibold text-gray-800 text-sm">학생별 누적 현황</span>
                    <span className="text-xs text-gray-400">총 {totalWeeks}주차 기준</span>
                  </div>
                  <div className="overflow-x-auto">
                    <table className="w-full text-sm">
                      <thead>
                        <tr className="border-b border-gray-100">
                          <th className="px-4 py-2.5 text-left text-xs font-semibold text-gray-500">이름</th>
                          <th className="px-3 py-2.5 text-left text-xs font-semibold text-gray-500">반</th>
                          <SortTh col="attended">출석</SortTh>
                          <SortTh col="rate">출석률</SortTh>
                          <SortTh col="wordPass">단어 P/F</SortTh>
                          <SortTh col="oralPass">구두 P/F</SortTh>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-gray-50">
                        {statsRows.map(({ s, attended, rate, wordPass, wordFail, oralPass, oralFail }) => (
                          <tr key={s.id} className="hover:bg-blue-50 transition-colors cursor-pointer" onClick={() => openStudentHistory(s)}>
                            <td className="px-4 py-3 font-medium text-gray-900 hover:text-blue-600 underline underline-offset-2 decoration-dotted">{s.name}</td>
                            <td className="px-3 py-3 text-xs text-gray-500">{s.class}</td>
                            <td className="px-3 py-3 text-center text-sm font-bold text-gray-700">
                              {attended}<span className="text-xs font-normal text-gray-400">/{totalWeeks}</span>
                            </td>
                            <td className="px-3 py-3 text-center">
                              <div className="flex items-center gap-1.5 justify-center">
                                <div className="w-16 h-1.5 bg-gray-100 rounded-full overflow-hidden">
                                  <div
                                    className={`h-full rounded-full ${rate >= 80 ? 'bg-green-400' : rate >= 50 ? 'bg-yellow-400' : 'bg-red-400'}`}
                                    style={{ width: `${rate}%` }}
                                  />
                                </div>
                                <span className={`text-xs font-semibold ${rate >= 80 ? 'text-green-600' : rate >= 50 ? 'text-yellow-600' : 'text-red-600'}`}>
                                  {rate}%
                                </span>
                              </div>
                            </td>
                            <td className="px-3 py-3 text-center text-xs">
                              <span className="text-green-600 font-semibold">{wordPass}P</span>
                              <span className="text-gray-300 mx-0.5">/</span>
                              <span className="text-red-500 font-semibold">{wordFail}F</span>
                            </td>
                            <td className="px-3 py-3 text-center text-xs">
                              <span className="text-green-600 font-semibold">{oralPass}P</span>
                              <span className="text-gray-300 mx-0.5">/</span>
                              <span className="text-red-500 font-semibold">{oralFail}F</span>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              )
            })()
          )}
        </div>
      )}

      {/* ── 재등원 관리 탭 ── */}
      {tab === 'absence' && (
        <div className="px-6 pb-8 max-w-screen-xl mx-auto space-y-4 pt-4">
          <p className="text-xs text-gray-400">기준 주차: {absenceWeek ? `${absenceWeek} 주` : '계산 중...'}</p>

          {/* 미실시 학생 */}
          <div className="bg-white rounded-3xl shadow-md shadow-slate-100 overflow-hidden">
            <div className="px-4 py-3 border-b border-gray-100 bg-red-50">
              <span className="font-semibold text-red-700 text-sm">미실시 학생 ({noShowStudents.filter(s => !absences.some(a => a.student_id === s.id && a.week_start_date === absenceWeek && a.type === '미실시')).length}명)</span>
              <span className="text-xs text-red-400 ml-2">직전 주 출석 기록 없음</span>
            </div>
            {noShowStudents.filter(s => !absences.some(a => a.student_id === s.id && a.week_start_date === absenceWeek && a.type === '미실시')).length === 0 ? (
              <div className="py-8 text-center text-gray-400 text-sm">모두 처리됐습니다</div>
            ) : (
              <table className="w-full text-sm">
                <thead><tr className="border-b border-gray-100 bg-gray-50">
                  <th className="px-4 py-2 text-left text-xs text-gray-500">이름</th>
                  <th className="px-3 py-2 text-left text-xs text-gray-500">학교 · 반</th>
                  <th className="px-3 py-2 text-center text-xs text-gray-500">처리</th>
                </tr></thead>
                <tbody>
                  {noShowStudents.filter(s => !absences.some(a => a.student_id === s.id && a.week_start_date === absenceWeek && a.type === '미실시')).map(s => (
                    <tr key={s.id} className="border-b border-gray-50">
                      <td className="px-4 py-2.5 font-medium text-gray-800">{s.name}</td>
                      <td className="px-3 py-2.5 text-xs text-gray-500">{s.school} · {s.class}</td>
                      <td className="px-3 py-2.5 text-center">
                        <button
                          onClick={() => setAbsenceReasonModal({ studentId: s.id, name: s.name, type: '미실시' })}
                          className="text-xs bg-red-50 hover:bg-red-100 text-red-600 px-2.5 py-1 rounded-xl transition-colors"
                        >사유 입력</button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>

          {/* 미재등원 학생 */}
          <div className="bg-white rounded-3xl shadow-md shadow-slate-100 overflow-hidden">
            <div className="px-4 py-3 border-b border-gray-100 bg-orange-50">
              <span className="font-semibold text-orange-700 text-sm">미재등원 학생 ({overdueStudents.filter(r => !absences.some(a => a.student_id === r.student_id && a.type === '미재등원')).length}명)</span>
              <span className="text-xs text-orange-400 ml-2">다음에 올게요 날짜 경과</span>
            </div>
            {overdueStudents.filter(r => !absences.some(a => a.student_id === r.student_id && a.type === '미재등원')).length === 0 ? (
              <div className="py-8 text-center text-gray-400 text-sm">모두 처리됐습니다</div>
            ) : (
              <table className="w-full text-sm">
                <thead><tr className="border-b border-gray-100 bg-gray-50">
                  <th className="px-4 py-2 text-left text-xs text-gray-500">이름</th>
                  <th className="px-3 py-2 text-left text-xs text-gray-500">학교 · 반</th>
                  <th className="px-3 py-2 text-center text-xs text-gray-500">약속 날짜</th>
                  <th className="px-3 py-2 text-center text-xs text-gray-500">처리</th>
                </tr></thead>
                <tbody>
                  {overdueStudents.filter(r => !absences.some(a => a.student_id === r.student_id && a.type === '미재등원')).map(r => (
                    <tr key={r.id} className="border-b border-gray-50">
                      <td className="px-4 py-2.5 font-medium text-gray-800">{r.students.name}</td>
                      <td className="px-3 py-2.5 text-xs text-gray-500">{r.students.school} · {r.students.class}</td>
                      <td className="px-3 py-2.5 text-center text-xs text-orange-600 font-medium">{r.next_clinic_date}</td>
                      <td className="px-3 py-2.5 text-center">
                        <button
                          onClick={() => setAbsenceReasonModal({ studentId: r.student_id, name: r.students.name, type: '미재등원' })}
                          className="text-xs bg-orange-50 hover:bg-orange-100 text-orange-600 px-2.5 py-1 rounded-xl transition-colors"
                        >사유 입력</button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>

          {/* 처리된 기록 */}
          <div className="bg-white rounded-3xl shadow-md shadow-slate-100 overflow-hidden">
            <div className="px-4 py-3 border-b border-gray-100">
              <span className="font-semibold text-gray-700 text-sm">처리된 기록 ({absences.filter(a => a.week_start_date === absenceWeek).length}건)</span>
            </div>
            {absences.filter(a => a.week_start_date === absenceWeek).length === 0 ? (
              <div className="py-6 text-center text-gray-400 text-sm">이번 주 처리 기록 없음</div>
            ) : (
              <table className="w-full text-sm">
                <thead><tr className="border-b border-gray-100 bg-gray-50">
                  <th className="px-4 py-2 text-left text-xs text-gray-500">이름</th>
                  <th className="px-3 py-2 text-left text-xs text-gray-500">학교</th>
                  <th className="px-3 py-2 text-center text-xs text-gray-500">구분</th>
                  <th className="px-3 py-2 text-left text-xs text-gray-500">사유</th>
                </tr></thead>
                <tbody>
                  {absences.filter(a => a.week_start_date === absenceWeek).map(a => (
                    <tr key={a.id} className="border-b border-gray-50">
                      <td className="px-4 py-2.5 font-medium text-gray-800">{a.students.name}</td>
                      <td className="px-3 py-2.5 text-xs text-gray-500">{a.students.school}</td>
                      <td className="px-3 py-2.5 text-center">
                        <span className={`text-xs px-2 py-0.5 rounded-full ${a.type === '미실시' ? 'bg-red-100 text-red-600' : 'bg-orange-100 text-orange-600'}`}>{a.type}</span>
                      </td>
                      <td className="px-3 py-2.5 text-xs text-gray-500">{a.reason || '-'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </div>
      )}

      {/* 학기 추가 모달 */}
      {showTermModal && (
        <div className="fixed inset-0 bg-black/30 backdrop-blur-sm flex items-center justify-center z-50 p-4">
          <div className="bg-white rounded-3xl w-full max-w-sm shadow-xl">
            <div className="px-6 py-4 border-b border-gray-100 flex items-center justify-between">
              <h3 className="font-bold text-gray-800">새 학기 추가</h3>
              <button
                onClick={() => { setShowTermModal(false); setTermFormError(''); setNewTermName(''); setNewTermDate('') }}
                className="text-gray-400 hover:text-gray-600 text-xl"
              >✕</button>
            </div>
            <form onSubmit={handleCreateTerm} className="px-6 py-5 space-y-4">
              <div>
                <label className="block text-xs font-medium text-gray-500 mb-1">학기 이름</label>
                <input
                  value={newTermName}
                  onChange={(e) => setNewTermName(e.target.value)}
                  placeholder="예: 2026 중간고사 후"
                  className="w-full border border-gray-200 rounded-xl px-3 py-2 text-sm focus:outline-none focus:border-blue-400"
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-gray-500 mb-1">시작일</label>
                <input
                  type="date"
                  value={newTermDate}
                  onChange={(e) => setNewTermDate(e.target.value)}
                  className="w-full border border-gray-200 rounded-xl px-3 py-2 text-sm focus:outline-none focus:border-blue-400"
                />
                <p className="text-xs text-gray-400 mt-1">선택한 날짜가 포함된 주의 월요일로 저장됩니다.</p>
              </div>
              {termFormError && <p className="text-xs text-red-500">{termFormError}</p>}
              <div className="flex gap-2 pt-1">
                <button
                  type="button"
                  onClick={() => { setShowTermModal(false); setTermFormError(''); setNewTermName(''); setNewTermDate('') }}
                  className="flex-1 py-2 rounded-xl border border-gray-200 text-sm text-gray-600 hover:bg-gray-50 transition-colors"
                >
                  취소
                </button>
                <button
                  type="submit"
                  className="flex-1 py-2 rounded-xl bg-blue-600 hover:bg-blue-700 text-white text-sm font-semibold transition-colors"
                >
                  + 추가
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* ── 일별 조회 탭 ── */}
      {tab === 'daily' && (() => {
        const dailyFiltered = dailyRecords
          .filter(r => r.students.name.includes(dailySearch.trim()))
          .filter(r => !dailySchoolFilter || r.students.school === dailySchoolFilter)
          .filter(r => !dailyClassFilter || r.students.class === dailyClassFilter)
        const dailySchools = [...new Set(dailyRecords.map(r => r.students.school))].filter(Boolean).sort()
        const dailyClasses = [...new Set(dailyRecords.map(r => r.students.class))].filter(Boolean).sort()
        return (
        <div className="px-6 pb-8 max-w-screen-xl mx-auto space-y-4 pt-4">
          {/* 날짜 피커 + 필터 */}
          <div className="flex items-center gap-3 flex-wrap">
            <input
              type="date"
              value={selectedDate}
              max={new Date().toISOString().split('T')[0]}
              onChange={(e) => {
                setSelectedDate(e.target.value)
                fetchDailyRecords(e.target.value)
              }}
              className="bg-white border border-gray-200 rounded-xl px-3 py-2 text-sm focus:outline-none focus:border-blue-400 shadow-sm"
            />
            <span className="text-sm text-gray-500">
              {new Date(selectedDate).toLocaleDateString('ko-KR', { year: 'numeric', month: 'long', day: 'numeric', weekday: 'short' })}
            </span>
            <input
              value={dailySearch}
              onChange={(e) => setDailySearch(e.target.value)}
              placeholder="이름 검색..."
              className="border border-gray-200 rounded-xl px-3 py-2 text-sm focus:outline-none focus:border-blue-400 w-36"
            />
            <select
              value={dailySchoolFilter}
              onChange={(e) => setDailySchoolFilter(e.target.value)}
              className="border border-gray-200 rounded-xl px-3 py-2 text-sm focus:outline-none focus:border-blue-400 text-gray-700 w-36"
            >
              <option value="">전체 학교</option>
              {dailySchools.map(s => <option key={s} value={s}>{s}</option>)}
            </select>
            <select
              value={dailyClassFilter}
              onChange={(e) => setDailyClassFilter(e.target.value)}
              className="border border-gray-200 rounded-xl px-3 py-2 text-sm focus:outline-none focus:border-blue-400 text-gray-700 w-32"
            >
              <option value="">전체 선생님</option>
              {dailyClasses.map(c => <option key={c} value={c}>{c}</option>)}
            </select>
            {(dailySearch || dailySchoolFilter || dailyClassFilter) && (
              <button
                onClick={() => { setDailySearch(''); setDailySchoolFilter(''); setDailyClassFilter('') }}
                className="text-xs text-gray-400 hover:text-red-400 border border-gray-200 rounded-lg px-2.5 py-2 transition-colors"
              >
                초기화
              </button>
            )}
            {!dailyLoading && (
              <div className="flex gap-2 text-xs">
                <span className="bg-gray-100 text-gray-600 px-2 py-0.5 rounded-full">전체 {dailyFiltered.length}명{dailyFiltered.length !== dailyRecords.length && ` / ${dailyRecords.length}명`}</span>
                <span className="bg-green-100 text-green-700 px-2 py-0.5 rounded-full">승인 {dailyFiltered.filter(r => r.status === 'approved').length}명</span>
                <span className="bg-yellow-100 text-yellow-700 px-2 py-0.5 rounded-full">대기 {dailyFiltered.filter(r => r.status === 'pending').length}명</span>
                <span className="bg-red-100 text-red-600 px-2 py-0.5 rounded-full">거절 {dailyFiltered.filter(r => r.status === 'rejected').length}명</span>
              </div>
            )}
          </div>

          {/* 기록 테이블 */}
          <div className="bg-white rounded-3xl shadow-md shadow-slate-100 overflow-hidden">
            {dailyLoading ? (
              <div className="py-16 text-center text-gray-400 text-sm">불러오는 중...</div>
            ) : dailyFiltered.length === 0 ? (
              <div className="py-16 text-center text-gray-400 text-sm">{dailyRecords.length === 0 ? '해당 날짜의 출석 기록이 없습니다' : '필터 조건에 맞는 학생이 없습니다'}</div>
            ) : (
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-gray-100 bg-gray-50">
                    <th className="px-4 py-3 text-left text-xs font-semibold text-gray-500">#</th>
                    <th className="px-4 py-3 text-left text-xs font-semibold text-gray-500">이름</th>
                    <th className="px-3 py-3 text-left text-xs font-semibold text-gray-500">학교 · 반</th>
                    <th className="px-3 py-3 text-center text-xs font-semibold text-gray-500">유형</th>
                    <th className="px-3 py-3 text-center text-xs font-semibold text-gray-500">상태</th>
                    <th className="px-3 py-3 text-center text-xs font-semibold text-gray-500">등원</th>
                    <th className="px-3 py-3 text-center text-xs font-semibold text-gray-500">하원</th>
                    <th className="px-3 py-3 text-center text-xs font-semibold text-gray-500">단어</th>
                    <th className="px-3 py-3 text-center text-xs font-semibold text-gray-500">클리닉</th>
                    <th className="px-3 py-3 text-center text-xs font-semibold text-gray-500">구두</th>
                    <th className="px-3 py-3 text-center text-xs font-semibold text-gray-500">과제</th>
                    <th className="px-3 py-3 text-center text-xs font-semibold text-amber-500">직보</th>
                    <th className="px-3 py-3 text-left text-xs font-semibold text-green-600">알림장</th>
                    <th className="px-3 py-3 text-center text-xs font-semibold text-gray-500">재등원 예정</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-50">
                  {dailyFiltered.map((r, idx) => {
                    const statusBadge = () => {
                      if (r.status === 'approved') return <span className="text-xs bg-green-100 text-green-700 px-2 py-0.5 rounded-full font-medium">승인</span>
                      if (r.status === 'pending') return <span className="text-xs bg-yellow-100 text-yellow-700 px-2 py-0.5 rounded-full font-medium">대기</span>
                      return <span className="text-xs bg-red-100 text-red-600 px-2 py-0.5 rounded-full font-medium">거절</span>
                    }
                    return (
                      <tr key={r.id} className="hover:bg-gray-50 transition-colors">
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
                        <td className="px-3 py-3 text-center">{statusBadge()}</td>
                        <td className="px-3 py-3 text-center text-xs text-gray-500">
                          {r.checked_in_at ? new Date(r.checked_in_at).toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit' }) : '-'}
                        </td>
                        <td className="px-3 py-3 text-center text-xs text-gray-500">
                          {r.checked_out_at ? new Date(r.checked_out_at).toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit' }) : <span className="text-gray-300">-</span>}
                        </td>
                        <td className="px-3 py-3 text-center text-xs text-gray-700">{r.word_score || <span className="text-gray-300">-</span>}</td>
                        <td className="px-3 py-3 text-center text-xs text-gray-700">{r.clinic_score || <span className="text-gray-300">-</span>}</td>
                        <td className="px-3 py-3 text-center"><MissionBadge value={r.oral_status} /></td>
                        <td className="px-3 py-3 text-center"><MissionBadge value={r.homework} /></td>
                        <td className="px-3 py-3 text-center text-xs">
                          {r.jikbo_score
                            ? <span className="text-amber-600 font-semibold">{r.jikbo_score}</span>
                            : <span className="text-gray-300">-</span>}
                        </td>
                        <td className="px-3 py-3 text-xs">
                          {r.parent_memo
                            ? <span className="text-green-700" title={r.parent_memo}>{r.parent_memo}</span>
                            : <span className="text-gray-300">-</span>}
                        </td>
                        <td className="px-3 py-3 text-center text-xs">
                          {r.next_clinic_date
                            ? <span className="text-blue-600 font-medium">{r.next_clinic_date}</span>
                            : <span className="text-gray-300">-</span>}
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            )}
          </div>
        </div>
        )
      })()}

      {/* 학생 등록 모달 */}
      {showRegisterModal && (
        <div className="fixed inset-0 bg-black/30 backdrop-blur-sm flex items-center justify-center z-50 p-4">
          <div className="bg-white rounded-3xl w-full max-w-sm shadow-xl">
            <div className="px-6 py-4 border-b border-gray-100 flex items-center justify-between">
              <h3 className="font-bold text-gray-800">새 학생 등록</h3>
              <button
                onClick={() => { setShowRegisterModal(false); setShowRegisterConfirm(false); setForm({ name: '', class: '', school: '', oral_type: '', clinic_day: '', phone: '' }); setFormError('') }}
                className="text-gray-400 hover:text-gray-600 text-xl"
              >✕</button>
            </div>

            {!showRegisterConfirm ? (
              /* ── 입력 폼 ── */
              <form onSubmit={handleRegisterValidate} className="p-6 space-y-3">
                <div>
                  <label className="text-xs text-gray-500 font-medium mb-1 block">이름 *</label>
                  <input
                    value={form.name}
                    onChange={(e) => setForm({ ...form, name: e.target.value })}
                    placeholder="홍길동"
                    className="w-full border border-gray-200 rounded-xl px-3 py-2 text-sm focus:outline-none focus:border-blue-400"
                  />
                </div>
                <div>
                  <label className="text-xs text-gray-500 font-medium mb-1 block">반(선생님) *</label>
                  <input
                    value={form.class}
                    onChange={(e) => setForm({ ...form, class: e.target.value })}
                    placeholder="김선생님반"
                    className="w-full border border-gray-200 rounded-xl px-3 py-2 text-sm focus:outline-none focus:border-blue-400"
                  />
                </div>
                <div>
                  <label className="text-xs text-gray-500 font-medium mb-1 block">학교 *</label>
                  <input
                    value={form.school}
                    onChange={(e) => setForm({ ...form, school: e.target.value })}
                    placeholder="신봉고등학교"
                    className="w-full border border-gray-200 rounded-xl px-3 py-2 text-sm focus:outline-none focus:border-blue-400"
                  />
                </div>
                <div>
                  <label className="text-xs text-gray-500 font-medium mb-1 block">전화번호 * <span className="text-gray-400 font-normal">(코드 자동 생성)</span></label>
                  <input
                    value={form.phone}
                    onChange={(e) => setForm({ ...form, phone: e.target.value })}
                    placeholder="010-0000-0000"
                    inputMode="numeric"
                    className="w-full border border-gray-200 rounded-xl px-3 py-2 text-sm focus:outline-none focus:border-blue-400"
                  />
                  {form.phone.replace(/\D/g, '').length >= 4 && (
                    <p className="text-xs text-blue-500 mt-1">코드: <span className="font-mono font-bold">{extractCode(form.phone)}</span></p>
                  )}
                </div>
                <div>
                  <label className="text-xs text-gray-500 font-medium mb-1 block">구두 방식</label>
                  <select
                    value={form.oral_type}
                    onChange={(e) => setForm({ ...form, oral_type: e.target.value })}
                    className="w-full border border-gray-200 rounded-xl px-3 py-2 text-sm focus:outline-none focus:border-blue-400 text-gray-700"
                  >
                    <option value="">선택 안 함</option>
                    {ORAL_TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
                  </select>
                </div>
                <div>
                  <label className="text-xs text-gray-500 font-medium mb-1 block">클리닉 요일</label>
                  <select
                    value={form.clinic_day}
                    onChange={(e) => setForm({ ...form, clinic_day: e.target.value })}
                    className="w-full border border-gray-200 rounded-xl px-3 py-2 text-sm focus:outline-none focus:border-blue-400 text-gray-700"
                  >
                    <option value="">선택 안 함</option>
                    {CLINIC_DAYS.map((d) => <option key={d} value={d}>{d}요일</option>)}
                  </select>
                </div>
                {formError && <p className="text-xs text-red-500">{formError}</p>}
                <div className="flex gap-2 pt-1">
                  <button
                    type="button"
                    onClick={() => { setShowRegisterModal(false); setForm({ name: '', class: '', school: '', oral_type: '', clinic_day: '', phone: '' }); setFormError('') }}
                    className="flex-1 py-3 rounded-2xl bg-slate-100 hover:bg-slate-200 font-medium text-sm text-gray-500 hover:bg-gray-50 transition-colors"
                  >
                    취소
                  </button>
                  <button
                    type="submit"
                    className="flex-1 py-3 rounded-2xl bg-blue-500 hover:bg-blue-600 text-white font-bold text-sm transition-all shadow-sm shadow-blue-200"
                  >
                    다음 →
                  </button>
                </div>
              </form>
            ) : (
              /* ── 등록 확인 ── */
              <div className="p-6 space-y-4">
                <p className="text-sm text-gray-500">아래 내용으로 등록하시겠습니까?</p>
                <div className="bg-gray-50 rounded-xl p-4 space-y-2 text-sm">
                  <div className="flex justify-between">
                    <span className="text-gray-400">이름</span>
                    <span className="font-semibold text-gray-800">{form.name}</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-gray-400">반(선생님)</span>
                    <span className="text-gray-700">{form.class}</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-gray-400">학교</span>
                    <span className="text-gray-700">{form.school}</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-gray-400">코드</span>
                    <span className="font-mono font-bold text-blue-600">{extractCode(form.phone)}</span>
                  </div>
                  {form.oral_type && (
                    <div className="flex justify-between">
                      <span className="text-gray-400">구두 방식</span>
                      <span className="text-gray-700">{form.oral_type}</span>
                    </div>
                  )}
                  {form.clinic_day && (
                    <div className="flex justify-between">
                      <span className="text-gray-400">클리닉 요일</span>
                      <span className="text-gray-700">{form.clinic_day}요일</span>
                    </div>
                  )}
                </div>
                {formError && <p className="text-xs text-red-500">{formError}</p>}
                <div className="flex gap-2">
                  <button
                    onClick={() => setShowRegisterConfirm(false)}
                    className="flex-1 py-3 rounded-2xl bg-slate-100 hover:bg-slate-200 font-medium text-sm text-gray-500 hover:bg-gray-50 transition-colors"
                  >
                    ← 수정
                  </button>
                  <button
                    onClick={handleRegisterSubmit}
                    disabled={formLoading}
                    className="flex-1 py-3 rounded-2xl bg-blue-500 hover:bg-blue-600 disabled:bg-gray-300 text-white font-bold text-sm transition-all shadow-sm shadow-blue-200"
                  >
                    {formLoading ? '등록 중...' : '확인 등록'}
                  </button>
                </div>
              </div>
            )}
          </div>
        </div>
      )}

      {/* 사유 입력 모달 */}
      {absenceReasonModal && (
        <div className="fixed inset-0 bg-black/30 backdrop-blur-sm flex items-center justify-center z-50 p-4">
          <div className="bg-white rounded-3xl w-full max-w-sm p-6 shadow-2xl">
            <h3 className="font-semibold text-gray-800 mb-1">{absenceReasonModal.name} — {absenceReasonModal.type}</h3>
            <p className="text-xs text-gray-400 mb-4">사유를 입력하면 재등원탭에서 제거되고 주차별 현황에 기록됩니다.</p>
            <textarea
              value={absenceReason}
              onChange={(e) => setAbsenceReason(e.target.value)}
              placeholder="사유 입력 (선택사항)"
              rows={3}
              className="w-full border border-gray-200 rounded-xl px-3 py-2.5 text-sm focus:outline-none focus:border-blue-400 mb-4 resize-none"
            />
            <div className="flex gap-2">
              <button onClick={() => { setAbsenceReasonModal(null); setAbsenceReason('') }} className="flex-1 py-3 rounded-xl border border-gray-200 text-sm text-gray-600">취소</button>
              <button
                onClick={() => handleAddAbsence(absenceReasonModal.studentId, absenceReasonModal.type)}
                disabled={absenceLoading}
                className="flex-1 py-3 rounded-xl bg-blue-600 hover:bg-blue-700 disabled:bg-gray-300 text-white text-sm font-semibold"
              >{absenceLoading ? '저장 중...' : '저장'}</button>
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
          showChart={true}
          absences={historyAbsences}
        />
      )}

      {/* 학생 수정 모달 */}
      {editTarget && (
        <EditStudentModal
          student={editTarget}
          onClose={() => setEditTarget(null)}
          onSaved={fetchStudents}
        />
      )}

      {/* 교실 호출 알림 모달 */}
      {classroomCall && (
        <div className="fixed inset-0 z-[60] flex items-start justify-center pt-8 px-4 pointer-events-none">
          <div className="pointer-events-auto bg-white rounded-3xl shadow-2xl w-full max-w-sm overflow-hidden animate-bounce-once">
            <div className="bg-red-500 px-5 py-4 flex items-center gap-3">
              <span className="text-2xl">🚨</span>
              <div>
                <div className="text-white font-black text-base">관리자 호출</div>
                <div className="text-red-100 text-xs">{classroomCall.room_name}</div>
              </div>
              <div className="ml-auto text-red-200 text-xs">
                {new Date(classroomCall.called_at).toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit' })}
              </div>
            </div>
            <div className="px-5 py-4 flex gap-2">
              <button
                onClick={() => { setClassroomOpen(true); connectClassroom(classroomCall.room_name); acknowledgeCall(classroomCall.id) }}
                className="flex-1 py-3 rounded-2xl bg-emerald-500 hover:bg-emerald-600 text-white text-sm font-bold transition-colors"
              >
                카메라 확인
              </button>
              <button
                onClick={() => acknowledgeCall(classroomCall.id)}
                className="flex-1 py-3 rounded-2xl bg-gray-100 hover:bg-gray-200 text-gray-700 text-sm font-semibold transition-colors"
              >
                확인
              </button>
            </div>
          </div>
        </div>
      )}

      {/* 교실 실시간 뷰어 모달 */}
      {classroomOpen && (
        <div className="fixed inset-0 z-50 bg-black/80 flex flex-col">
          {/* 뷰어 헤더 */}
          <div className="flex items-center justify-between px-5 py-4 bg-gray-950">
            <div className="flex items-center gap-3">
              <div className="text-white font-black text-sm">교실 실시간</div>
              {classroomRoom && (
                <span className="text-xs bg-gray-800 text-gray-300 rounded-full px-3 py-1">{classroomRoom}</span>
              )}
              {classroomConnecting && <span className="text-xs text-yellow-400 animate-pulse">연결 중…</span>}
              {classroomConnected && <span className="text-xs text-green-400">● 연결됨</span>}
            </div>
            <div className="flex items-center gap-2">
              {classroomRoom && (
                <button
                  onClick={disconnectClassroom}
                  className="text-xs text-gray-400 hover:text-white bg-gray-800 rounded-xl px-3 py-1.5 transition-colors"
                >
                  연결 해제
                </button>
              )}
              <button
                onClick={() => { setClassroomOpen(false) }}
                className="w-8 h-8 flex items-center justify-center rounded-full bg-gray-800 hover:bg-gray-700 text-gray-300 text-sm transition-colors"
              >
                ✕
              </button>
            </div>
          </div>

          {/* 방 이름 입력 */}
          {!classroomRoom && (
            <div className="flex-1 flex flex-col items-center justify-center px-8 gap-4">
              <div className="text-white text-lg font-semibold">연결할 교실 이름을 입력하세요</div>
              <div className="text-gray-400 text-sm">태블릿에 설정된 이름과 동일해야 합니다</div>
              <input
                type="text"
                value={classroomRoomInput}
                onChange={e => setClassroomRoomInput(e.target.value)}
                onKeyDown={e => e.key === 'Enter' && classroomRoomInput.trim() && connectClassroom(classroomRoomInput.trim())}
                placeholder="예: A교실"
                className="w-full max-w-xs bg-gray-800 text-white text-center text-lg rounded-2xl px-5 py-4 outline-none focus:ring-2 focus:ring-emerald-500 placeholder:text-gray-600"
                autoFocus
              />
              <button
                onClick={() => classroomRoomInput.trim() && connectClassroom(classroomRoomInput.trim())}
                disabled={!classroomRoomInput.trim()}
                className="w-full max-w-xs py-4 rounded-2xl bg-emerald-600 hover:bg-emerald-500 disabled:bg-gray-800 disabled:text-gray-600 text-white font-bold transition-colors"
              >
                연결
              </button>
            </div>
          )}

          {/* 비디오 뷰 */}
          {classroomRoom && (
            <div className="flex-1 relative flex items-center justify-center bg-black">
              <video
                ref={classroomVideoRef}
                autoPlay
                playsInline
                className="w-full h-full object-contain"
              />
              {!classroomConnected && !classroomConnecting && (
                <div className="absolute inset-0 flex flex-col items-center justify-center gap-3">
                  <div className="text-gray-400 text-sm">연결이 끊어졌습니다</div>
                  <button
                    onClick={() => connectClassroom(classroomRoom)}
                    className="text-sm text-emerald-400 hover:text-emerald-300 bg-gray-900 rounded-xl px-4 py-2 transition-colors"
                  >
                    재연결
                  </button>
                </div>
              )}
              {classroomConnecting && (
                <div className="absolute inset-0 flex items-center justify-center">
                  <div className="text-yellow-400 text-sm animate-pulse">교실 태블릿에 연결 요청 중…</div>
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  )
}

// ── 주차별 행 (과제/기타 인라인 편집) ──────────────────────

const VALID_STATUSES = ['pass', 'fail', 'delay', 'word_pass', 'sentence_pass', 'partial_pass', 'exempt']

function WeeklyRow({ record, onUpdate, onNameClick }: { record: AttendanceWithStudent; onUpdate: () => void; onNameClick?: () => void }) {
  const [notes, setNotes] = useState(record.notes ?? '')
  const [oralMemo, setOralMemo] = useState(record.oral_memo ?? '')
  const [homeworkMemo, setHomeworkMemo] = useState(record.homework_memo ?? '')
  const [saving, setSaving] = useState(false)
  const [showEditModal, setShowEditModal] = useState(false)
  const [showNotesModal, setShowNotesModal] = useState(false)
  const [modalOralMemo, setModalOralMemo] = useState('')
  const [modalHomeworkMemo, setModalHomeworkMemo] = useState('')
  const [modalNotes, setModalNotes] = useState('')
  const notesTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const [showEditConfirm, setShowEditConfirm] = useState(false)
  const [editForm, setEditForm] = useState({
    status: record.status as string,
    visit_type: record.visit_type ?? 'class_clinic',
    word_score: record.word_score ?? '',
    clinic_score: record.clinic_score ?? '',
    oral_status: record.oral_status ?? '',
    homework: record.homework ?? '',
    oral_memo: record.oral_memo ?? '',
    homework_memo: record.homework_memo ?? '',
    notes: record.notes ?? '',
  })

  async function saveAllMemos(o: string, h: string, n: string) {
    await supabase.from('attendances').update({
      oral_memo: o || null,
      homework_memo: h || null,
      notes: n || null,
    }).eq('id', record.id)
    onUpdate()
  }

  function openNotesModal() {
    setModalOralMemo(oralMemo)
    setModalHomeworkMemo(homeworkMemo)
    setModalNotes(notes)
    setShowNotesModal(true)
  }

  async function handleSaveModal() {
    setOralMemo(modalOralMemo)
    setHomeworkMemo(modalHomeworkMemo)
    setNotes(modalNotes)
    if (notesTimerRef.current) clearTimeout(notesTimerRef.current)
    setSaving(true)
    await saveAllMemos(modalOralMemo, modalHomeworkMemo, modalNotes)
    setSaving(false)
    setShowNotesModal(false)
  }

  async function handleEditSubmit() {
    setSaving(true)
    const { error } = await supabase.from('attendances').update({
      status: editForm.status,
      visit_type: editForm.visit_type,
      word_score: editForm.word_score || null,
      clinic_score: editForm.clinic_score || null,
      oral_status: VALID_STATUSES.includes(editForm.oral_status) ? editForm.oral_status : null,
      homework: editForm.homework || null,
      oral_memo: editForm.oral_memo || null,
      homework_memo: editForm.homework_memo || null,
      notes: editForm.notes || null,
    }).eq('id', record.id)
    setSaving(false)
    if (error) {
      alert('저장 실패: ' + error.message)
      return
    }
    setShowEditConfirm(false)
    setShowEditModal(false)
    setOralMemo(editForm.oral_memo)
    setHomeworkMemo(editForm.homework_memo)
    setNotes(editForm.notes)
    onUpdate()
  }

  const homeworkIsStatus = VALID_STATUSES.includes(record.homework as string)

  const checkinTime = record.approved_at
    ? new Date(record.approved_at).toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit' })
    : '-'
  const recheckInTime = record.rechecked_in_at
    ? new Date(record.rechecked_in_at).toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit' })
    : '-'
  const checkoutTime = record.checked_out_at
    ? new Date(record.checked_out_at).toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit' })
    : '-'

  return (
    <>
    <tr className={`hover:bg-gray-50 transition-colors ${saving ? 'opacity-60' : ''}`}>
      <td className="px-3 py-2.5 font-medium text-gray-900 whitespace-nowrap">
        <span onClick={onNameClick} className={onNameClick ? 'cursor-pointer hover:text-blue-600 transition-colors' : ''}>{record.students.name}</span>
      </td>
      <td className="px-3 py-2.5 text-center">
        <button
          onClick={() => { setEditForm({ status: record.status, visit_type: record.visit_type ?? 'class_clinic', word_score: record.word_score ?? '', clinic_score: record.clinic_score ?? '', oral_status: record.oral_status ?? '', homework: record.homework ?? '', oral_memo: record.oral_memo ?? '', homework_memo: record.homework_memo ?? '', notes: record.notes ?? '' }); setShowEditModal(true) }}
          className="text-gray-300 hover:text-blue-500 transition-colors"
          title="수정"
        >
          ✏️
        </button>
      </td>
      <td className="px-3 py-2.5 text-xs text-gray-500 whitespace-nowrap">{record.students.oral_type || '-'}</td>
      <td className="px-3 py-2.5 text-center text-xs text-gray-500">
        {['일','월','화','수','목','금','토'][new Date(record.date + 'T00:00:00').getDay()]}
        {record.students.clinic_day && record.students.clinic_day !== ['일','월','화','수','목','금','토'][new Date(record.date + 'T00:00:00').getDay()] && (
          <span className="text-gray-300 ml-0.5">({record.students.clinic_day})</span>
        )}
      </td>
      <td className="px-3 py-2.5 text-center">
        {record.status === 'approved'
          ? <span className="text-green-600 font-bold">○</span>
          : record.status === 'absent'
          ? <span className="text-xs bg-gray-100 text-gray-500 px-1.5 py-0.5 rounded-full font-medium">결석</span>
          : record.status === 'rejected'
          ? <span className="text-red-400 text-xs">거절</span>
          : <span className="text-gray-300">-</span>}
      </td>
      <td className="px-3 py-2.5 text-center text-xs text-gray-500 whitespace-nowrap">{checkinTime}</td>
      <td className="px-3 py-2.5 text-center text-xs text-blue-500 whitespace-nowrap">
        {record.rechecked_in_at ? recheckInTime : <span className="text-gray-200">-</span>}
      </td>
      <td className="px-3 py-2.5 text-center text-xs text-indigo-500 whitespace-nowrap">{checkoutTime}</td>
      <td className="px-3 py-2.5 text-center text-xs">
        {record.word_score
          ? <span className={['00', '--', '-'].includes(record.word_score ?? '') ? 'text-orange-500 font-semibold' : ['.', '..'].includes(record.word_score ?? '') ? 'text-teal-600 font-medium' : 'text-gray-700'}>{record.word_score}</span>
          : <span className="text-gray-300">-</span>}
      </td>
      <td className="px-3 py-2.5 text-center text-xs">
        {record.clinic_score
          ? <span className={['00', '--', '-'].includes(record.clinic_score ?? '') ? 'text-orange-500 font-semibold' : ['.', '..'].includes(record.clinic_score ?? '') ? 'text-teal-600 font-medium' : 'text-gray-700'}>{record.clinic_score}</span>
          : <span className="text-gray-300">-</span>}
      </td>
      <td className="px-3 py-2.5 text-center"><MissionBadge value={record.oral_status} /></td>
      <td className="px-3 py-2.5 text-center">
        {homeworkIsStatus
          ? <MissionBadge value={record.homework} />
          : <span className="text-xs text-gray-400">{record.homework || '-'}</span>}
      </td>
      {/* 구두메모 */}
      <td className="px-3 py-2.5">
        <button onClick={openNotesModal} className="flex items-center gap-1 max-w-[90px] group">
          {oralMemo
            ? <span className="text-xs text-blue-600 truncate max-w-[70px]">{oralMemo}</span>
            : <span className="text-xs text-gray-300">입력...</span>
          }
          <span className={`text-xs flex-shrink-0 ${oralMemo ? 'text-blue-400 group-hover:text-blue-600' : 'text-gray-300 group-hover:text-gray-500'}`}>···</span>
        </button>
      </td>
      {/* 과제메모 */}
      <td className="px-3 py-2.5">
        <button onClick={openNotesModal} className="flex items-center gap-1 max-w-[90px] group">
          {homeworkMemo
            ? <span className="text-xs text-purple-600 truncate max-w-[70px]">{homeworkMemo}</span>
            : <span className="text-xs text-gray-300">입력...</span>
          }
          <span className={`text-xs flex-shrink-0 ${homeworkMemo ? 'text-purple-400 group-hover:text-purple-600' : 'text-gray-300 group-hover:text-gray-500'}`}>···</span>
        </button>
      </td>
      {/* 기타 + 메모 모달 */}
      <td className="px-3 py-2.5">
        <button onClick={openNotesModal} className="flex items-center gap-1 max-w-[90px] group">
          {notes
            ? <span className="text-xs text-gray-600 truncate max-w-[70px]">{notes}</span>
            : <span className="text-xs text-gray-300">입력...</span>
          }
          <span className={`text-xs flex-shrink-0 ${notes ? 'text-gray-400 group-hover:text-gray-600' : 'text-gray-300 group-hover:text-gray-500'}`}>···</span>
        </button>
      </td>
      {/* 직보 점수 (읽기 전용) */}
      <td className="px-3 py-2.5 text-center text-xs">
        {record.jikbo_score
          ? <span className="text-amber-600 font-semibold">{record.jikbo_score}</span>
          : <span className="text-gray-300">-</span>}
      </td>
      {/* 부모님 알림장 (읽기 전용) */}
      <td className="px-3 py-2.5 text-xs">
        {record.parent_memo
          ? <span className="text-green-700 truncate max-w-[120px] block" title={record.parent_memo}>{record.parent_memo}</span>
          : <span className="text-gray-300">-</span>}
        {showNotesModal && createPortal(
          <div className="fixed inset-0 bg-black/30 backdrop-blur-sm flex items-center justify-center z-50 p-4">
            <div className="bg-white rounded-3xl w-full max-w-sm p-6 shadow-2xl">
              <h3 className="font-semibold text-gray-800 mb-1">{record.students.name} 학생</h3>
              <p className="text-xs text-gray-400 mb-4">{record.date} · 메모 편집</p>
              <div className="space-y-3">
                <div>
                  <label className="block text-xs font-medium text-blue-500 mb-1">구두 메모</label>
                  <textarea
                    value={modalOralMemo}
                    onChange={(e) => setModalOralMemo(e.target.value)}
                    autoFocus
                    rows={2}
                    className="w-full border border-gray-200 rounded-xl px-3 py-2 text-sm focus:outline-none focus:border-blue-400 resize-none"
                    placeholder="구두 관련 메모..."
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium text-purple-500 mb-1">과제 메모</label>
                  <textarea
                    value={modalHomeworkMemo}
                    onChange={(e) => setModalHomeworkMemo(e.target.value)}
                    rows={2}
                    className="w-full border border-gray-200 rounded-xl px-3 py-2 text-sm focus:outline-none focus:border-purple-400 resize-none"
                    placeholder="과제 관련 메모..."
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium text-gray-400 mb-1">기타 메모</label>
                  <textarea
                    value={modalNotes}
                    onChange={(e) => setModalNotes(e.target.value)}
                    rows={2}
                    className="w-full border border-gray-200 rounded-xl px-3 py-2 text-sm focus:outline-none focus:border-gray-400 resize-none"
                    placeholder="기타 메모..."
                  />
                </div>
              </div>
              <div className="flex gap-2 mt-4">
                <button
                  onClick={() => setShowNotesModal(false)}
                  className="flex-1 py-3 rounded-2xl bg-slate-100 hover:bg-slate-200 font-medium text-sm text-gray-600 hover:bg-gray-50 transition-colors"
                >
                  취소
                </button>
                <button
                  onClick={handleSaveModal}
                  disabled={saving}
                  className="flex-1 py-3 rounded-2xl bg-blue-500 hover:bg-blue-600 disabled:bg-gray-300 text-white text-sm font-bold transition-all shadow-sm shadow-blue-200"
                >
                  {saving ? '저장 중...' : '저장'}
                </button>
              </div>
            </div>
          </div>,
          document.body
        )}
      </td>
    </tr>

    {/* 수정 모달 */}
    {showEditModal && (
      <tr><td colSpan={99}>
        <div className="fixed inset-0 bg-black/30 backdrop-blur-sm flex items-center justify-center z-50 p-4">
          <div className="bg-white rounded-3xl w-full max-w-sm shadow-xl">
            <div className="px-6 py-4 border-b border-gray-100 flex items-center justify-between">
              <div>
                <h3 className="font-bold text-gray-800">기록 수정</h3>
                <p className="text-xs text-gray-400 mt-0.5">{record.students.name} · {record.date}</p>
              </div>
              <button onClick={() => setShowEditModal(false)} className="text-gray-400 hover:text-gray-600 text-xl">✕</button>
            </div>
            <div className="px-6 py-5 space-y-4">
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs font-medium text-gray-500 mb-1">출석 상태</label>
                  <select
                    value={editForm.status}
                    onChange={(e) => setEditForm(f => ({ ...f, status: e.target.value }))}
                    className="w-full border border-gray-200 rounded-xl px-3 py-2 text-sm focus:outline-none focus:border-blue-400"
                  >
                    <option value="approved">출석 완료</option>
                    <option value="absent">결석</option>
                    <option value="pending">대기</option>
                    <option value="rejected">거절</option>
                  </select>
                </div>
                <div>
                  <label className="block text-xs font-medium text-gray-500 mb-1">방문 유형</label>
                  <select
                    value={editForm.visit_type}
                    onChange={(e) => setEditForm(f => ({ ...f, visit_type: e.target.value as VisitType }))}
                    className="w-full border border-gray-200 rounded-xl px-3 py-2 text-sm focus:outline-none focus:border-blue-400"
                  >
                    <option value="class_clinic">수업+클리닉</option>
                    <option value="clinic">클리닉</option>
                  </select>
                </div>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs font-medium text-gray-500 mb-1">단어 점수</label>
                  <input
                    value={editForm.word_score}
                    onChange={(e) => setEditForm(f => ({ ...f, word_score: e.target.value }))}
                    placeholder="예: 85"
                    className="w-full border border-gray-200 rounded-xl px-3 py-2 text-sm focus:outline-none focus:border-blue-400"
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium text-gray-500 mb-1">클리닉 점수</label>
                  <input
                    value={editForm.clinic_score}
                    onChange={(e) => setEditForm(f => ({ ...f, clinic_score: e.target.value }))}
                    placeholder="예: 90"
                    className="w-full border border-gray-200 rounded-xl px-3 py-2 text-sm focus:outline-none focus:border-blue-400"
                  />
                </div>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs font-medium text-gray-500 mb-1">구두</label>
                  <select
                    value={editForm.oral_status}
                    onChange={(e) => setEditForm(f => ({ ...f, oral_status: e.target.value }))}
                    className="w-full border border-gray-200 rounded-xl px-3 py-2 text-sm focus:outline-none focus:border-blue-400"
                  >
                    <option value="">-</option>
                    <option value="pass">Pass</option>
                    <option value="word_pass">단어Pass</option>
                    <option value="sentence_pass">문장Pass</option>
                    <option value="exempt">면제</option>
                    <option value="fail">Fail</option>
                    <option value="delay">Delay</option>
                  </select>
                </div>
                <div>
                  <label className="block text-xs font-medium text-gray-500 mb-1">과제</label>
                  <select
                    value={VALID_STATUSES.includes(editForm.homework) ? editForm.homework : ''}
                    onChange={(e) => setEditForm(f => ({ ...f, homework: e.target.value }))}
                    className="w-full border border-gray-200 rounded-xl px-3 py-2 text-sm focus:outline-none focus:border-blue-400"
                  >
                    <option value="">-</option>
                    <option value="pass">Pass</option>
                    <option value="partial_pass">일부Pass</option>
                    <option value="fail">Fail</option>
                    <option value="delay">Delay</option>
                  </select>
                </div>
              </div>
              <div>
                <label className="block text-xs font-medium text-blue-500 mb-1">구두 메모</label>
                <input
                  value={editForm.oral_memo}
                  onChange={(e) => setEditForm(f => ({ ...f, oral_memo: e.target.value }))}
                  placeholder="구두 관련 메모..."
                  className="w-full border border-gray-200 rounded-xl px-3 py-2 text-sm focus:outline-none focus:border-blue-400"
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-purple-500 mb-1">과제 메모</label>
                <input
                  value={editForm.homework_memo}
                  onChange={(e) => setEditForm(f => ({ ...f, homework_memo: e.target.value }))}
                  placeholder="과제 관련 메모..."
                  className="w-full border border-gray-200 rounded-xl px-3 py-2 text-sm focus:outline-none focus:border-purple-400"
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-gray-500 mb-1">기타 메모</label>
                <input
                  value={editForm.notes}
                  onChange={(e) => setEditForm(f => ({ ...f, notes: e.target.value }))}
                  placeholder="기타 메모..."
                  className="w-full border border-gray-200 rounded-xl px-3 py-2 text-sm focus:outline-none focus:border-blue-400"
                />
              </div>
              <div className="flex gap-2 pt-1">
                <button
                  onClick={() => setShowEditModal(false)}
                  className="flex-1 py-2 rounded-xl border border-gray-200 text-sm text-gray-600 hover:bg-gray-50 transition-colors"
                >
                  취소
                </button>
                <button
                  onClick={() => setShowEditConfirm(true)}
                  className="flex-1 py-2 rounded-xl bg-blue-600 hover:bg-blue-700 text-white text-sm font-semibold transition-colors"
                >
                  수정
                </button>
              </div>
            </div>
          </div>
        </div>
      </td></tr>
    )}

    {/* 수정 확인 모달 */}
    {showEditConfirm && (
      <tr><td colSpan={99}>
        <div className="fixed inset-0 bg-black/30 backdrop-blur-sm flex items-center justify-center z-50 p-4">
          <div className="bg-white rounded-3xl w-full max-w-xs p-6 shadow-2xl">
            <h3 className="font-semibold text-gray-800 mb-2 text-center">정말 수정하시겠습니까?</h3>
            <p className="text-xs text-gray-400 text-center mb-6">{record.students.name} · {record.date}</p>
            <div className="flex gap-2">
              <button
                onClick={() => setShowEditConfirm(false)}
                className="flex-1 py-3 rounded-2xl bg-slate-100 hover:bg-slate-200 font-medium text-sm text-gray-600 hover:bg-gray-50 transition-colors"
              >
                취소
              </button>
              <button
                onClick={handleEditSubmit}
                className="flex-1 py-2.5 rounded-2xl bg-blue-600 hover:bg-blue-700 text-white text-sm font-semibold transition-colors"
              >
                확인
              </button>
            </div>
          </div>
        </div>
      </td></tr>
    )}
    </>
  )
}

// ─── 서브 컴포넌트 ────────────────────────────────────────

function TabButton({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      onClick={onClick}
      className={`px-4 py-2 rounded-xl text-sm font-semibold transition-all ${
        active
          ? 'bg-white shadow-md shadow-slate-100 text-blue-600'
          : 'text-gray-500 hover:text-gray-700 hover:bg-white/60'
      }`}
    >
      {children}
    </button>
  )
}

function MissionBadge({ value }: { value: string | null }) {
  if (!value || !VALID_STATUSES.includes(value)) return <span className="text-xs text-gray-300">-</span>
  const styles: Record<string, string> = {
    pass: 'bg-green-100 text-green-700',
    fail: 'bg-red-100 text-red-700',
    delay: 'bg-orange-100 text-orange-600',
    word_pass: 'bg-orange-100 text-orange-600',
    sentence_pass: 'bg-orange-100 text-orange-600',
    partial_pass: 'bg-orange-100 text-orange-600',
    exempt: 'bg-teal-100 text-teal-700',
  }
  const labels: Record<string, string> = { pass: 'Pass', fail: 'Fail', delay: 'Delay', word_pass: '단어P', sentence_pass: '문장P', partial_pass: '일부P', exempt: '면제' }
  return (
    <span className={`text-xs font-semibold px-2 py-0.5 rounded-full ${styles[value] ?? 'bg-gray-100 text-gray-500'}`}>
      {labels[value] ?? value}
    </span>
  )
}

