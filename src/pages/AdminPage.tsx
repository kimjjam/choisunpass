import { useState, useEffect } from 'react'
import * as XLSX from 'xlsx'
import { useNavigate } from 'react-router-dom'
import { BarChart, Bar, XAxis, YAxis, Tooltip, Legend, ResponsiveContainer } from 'recharts'
import { supabase } from '../lib/supabase'
import { useCurrentUser } from '../hooks/useCurrentUser'
import type { Student, AttendanceWithStudent, Term, ClinicAbsenceWithStudent } from '../lib/database.types'
import EditStudentModal from '../components/EditStudentModal'

type AdminTab = 'students' | 'weekly' | 'stats' | 'absence'

const ORAL_TYPES = ['빈칸 구두', '별구두', '해석 구두', '별 빈칸 구두', '기타']
const CLINIC_DAYS = ['월', '화', '수', '목', '금']
const GOOGLE_SCRIPT_URL = 'https://script.google.com/macros/s/AKfycbzSDoISgOqu2b0vWtXmvCsvSVlLIA90DQFkRcgU2mcmRcmj8HL9HIVoLmof9RUETfdknw/exec'

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

  const [editTarget, setEditTarget] = useState<Student | null>(null)

  const [search, setSearch] = useState('')
  const [dayFilter, setDayFilter] = useState<string>('')
  const [schoolFilter, setSchoolFilter] = useState<string>('')

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
  // 미실시 학생 (이번 선택 주차에 출석 없는 학생)
  const [noShowStudents, setNoShowStudents] = useState<Student[]>([])
  // 미재등원 학생 (next_clinic_date 지났는데 미등원)
  const [overdueStudents, setOverdueStudents] = useState<AttendanceWithStudent[]>([])

  // 학생 히스토리 모달
  const [historyTarget, setHistoryTarget] = useState<Student | null>(null)
  const [historyRecords, setHistoryRecords] = useState<AttendanceWithStudent[]>([])
  const [historyAbsences, setHistoryAbsences] = useState<ClinicAbsenceWithStudent[]>([])

  // 학기 관리
  const [terms, setTerms] = useState<Term[]>([])
  const [selectedTermId, setSelectedTermId] = useState<string>('')
  const [newTermName, setNewTermName] = useState('')
  const [newTermDate, setNewTermDate] = useState('')
  const [termFormError, setTermFormError] = useState('')


  useEffect(() => {
    fetchStudents()
    fetchTerms()
  }, [])

  useEffect(() => {
    if (tab === 'weekly' || tab === 'stats') fetchAllRecords()
    if (tab === 'absence') { fetchAbsences(); fetchNoShowData() }
  }, [tab])

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

  async function fetchAllRecords() {
    setLoading(true)
    const { data } = await supabase
      .from('attendances')
      .select('*, students(*)')
      .order('date', { ascending: true })
    if (data) {
      const records = data as AttendanceWithStudent[]
      setAllRecords(records)
      // 기본 선택: 가장 최근 주차
      if (records.length > 0) {
        const starts = getWeekStarts(records)
        setSelectedWeek(starts[starts.length - 1])
      }
    }
    setLoading(false)
  }

  function getWeekStarts(records: AttendanceWithStudent[]): string[] {
    const set = new Set(records.map((r) => getWeekStart(r.date)))
    return Array.from(set).sort()
  }

  async function fetchAbsences() {
    const { data } = await supabase
      .from('clinic_absences')
      .select('*, students(*)')
      .order('week_start_date', { ascending: false })
    if (data) setAbsences(data as ClinicAbsenceWithStudent[])
  }

  async function fetchNoShowData() {
    // 직전 주 월요일 계산
    const today = new Date()
    const day = today.getDay()
    const diff = day === 0 ? -6 : 1 - day
    const thisMonday = new Date(today)
    thisMonday.setDate(today.getDate() + diff)
    const lastMonday = new Date(thisMonday)
    lastMonday.setDate(thisMonday.getDate() - 7)
    const lastFriday = new Date(lastMonday)
    lastFriday.setDate(lastMonday.getDate() + 4)
    const weekStart = lastMonday.toISOString().split('T')[0]
    const weekEnd = lastFriday.toISOString().split('T')[0]
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
    const todayStr = today.toISOString().split('T')[0]
    const { data: overdueData } = await supabase
      .from('attendances')
      .select('*, students(*)')
      .not('next_clinic_date', 'is', null)
      .lt('next_clinic_date', todayStr)
    if (overdueData) {
      // next_clinic_date 이후 출석이 없는 경우만 필터
      const overdue = (overdueData as AttendanceWithStudent[]).filter(r => {
        const hasLaterAttendance = (overdueData as AttendanceWithStudent[]).some(
          r2 => r2.student_id === r.student_id && r2.date > r.next_clinic_date!
        )
        return !hasLaterAttendance
      })
      setOverdueStudents(overdue)
    }
  }

  async function handleAddAbsence(studentId: string, type: '미실시' | '미재등원') {
    if (!absenceReasonModal || !selectedTermId) return
    setAbsenceLoading(true)
    await supabase.from('clinic_absences').insert({
      student_id: studentId,
      term_id: selectedTermId,
      week_start_date: absenceWeek,
      type,
      reason: absenceReason.trim() || null,
    })
    setAbsenceReasonModal(null)
    setAbsenceReason('')
    setAbsenceLoading(false)
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
      '구두': r.oral_status === 'pass' ? 'Pass' : r.oral_status === 'fail' ? 'Fail' : r.oral_status === 'delay' ? 'Delay' : '',
      '기타': r.notes ?? '',
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

    // 학교 → 반(선생님)별로 이중 그룹핑
    const schools: Record<string, Record<string, object[]>> = {}
    for (const r of weekRecords) {
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
        oral: r.oral_status === 'pass' ? 'Pass' : r.oral_status === 'fail' ? 'Fail' : r.oral_status === 'delay' ? 'Delay' : '',
        notes: r.notes ?? '',
      })
    }

    // 디버그: 전송 데이터 확인 (콘솔에서 확인 후 삭제 예정)
    console.log('구글시트 전송 데이터:', JSON.stringify({ weekLabel: label, schools }, null, 2))

    try {
      const res = await fetch(GOOGLE_SCRIPT_URL, {
        method: 'POST',
        body: JSON.stringify({ weekLabel: label, schools }),
      })
      const json = await res.json()
      setGsResult(json.success ? 'success' : 'error')
    } catch {
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
    .filter((r) => r.students.name.includes(search.trim()))
    .filter((r) => !dayFilter || r.students.clinic_day === dayFilter)
    .filter((r) => !schoolFilter || r.students.school === schoolFilter)

  const schools = [...new Set(students.map(s => s.school))].filter(Boolean).sort()

  const filteredStudents = students
    .filter((s) => s.name.includes(search.trim()))
    .filter((s) => !dayFilter || s.clinic_day === dayFilter)
    .filter((s) => !schoolFilter || s.school === schoolFilter)

  // 반별로 그룹핑
  const groupedByClass = weekRecords.reduce<Record<string, AttendanceWithStudent[]>>((acc, r) => {
    const key = `${r.students.school} (${r.students.class})`
    if (!acc[key]) acc[key] = []
    acc[key].push(r)
    return acc
  }, {})

  return (
    <div className="min-h-screen bg-gray-50">
      {/* 헤더 */}
      <header className="bg-white border-b border-gray-200 px-6 py-3 flex items-center justify-between">
        <div className="flex items-center gap-6">
          <div>
            <div className="text-base font-bold text-gray-900">관리자 페이지</div>
            <div className="text-xs text-gray-400">최선어학원 클리닉</div>
          </div>
          {/* 검색 + 요일 필터 인라인 */}
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="학생 이름 검색..."
            className="border border-gray-200 rounded-lg px-3 py-1.5 text-sm focus:outline-none focus:border-blue-400 w-44"
          />
          <select
            value={schoolFilter}
            onChange={(e) => setSchoolFilter(e.target.value)}
            className="border border-gray-200 rounded-lg px-3 py-1.5 text-sm focus:outline-none focus:border-blue-400 text-gray-700 w-36"
          >
            <option value="">전체 학교</option>
            {schools.map(s => <option key={s} value={s}>{s}</option>)}
          </select>
          <div className="flex gap-1">
            {['', '월', '화', '수', '목', '금'].map((d) => (
              <button
                key={d}
                onClick={() => setDayFilter(d)}
                className={`px-3 py-1.5 rounded-lg text-xs font-medium transition-colors ${
                  dayFilter === d ? 'bg-blue-600 text-white' : 'bg-white border border-gray-200 text-gray-500 hover:border-blue-300'
                }`}
              >
                {d || '전체'}
              </button>
            ))}
          </div>
        </div>
        <div className="flex items-center gap-3">
          <button
            onClick={() => navigate('/dashboard')}
            className="text-xs text-blue-600 hover:text-blue-800 border border-blue-200 hover:border-blue-400 rounded-lg px-3 py-1.5 transition-colors"
          >
            조교 대시보드
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

      {/* 탭 */}
      <div className="px-6 pt-4 flex items-center justify-between mb-4">
        <div className="flex gap-2 flex-wrap">
          <TabButton active={tab === 'students'} onClick={() => setTab('students')}>학생 관리</TabButton>
          <TabButton active={tab === 'weekly'} onClick={() => setTab('weekly')}>주차별 현황</TabButton>
          <TabButton active={tab === 'stats'} onClick={() => { setTab('stats'); fetchAllRecords() }}>누적 통계</TabButton>
          <TabButton active={tab === 'absence'} onClick={() => setTab('absence')}>재등원 관리</TabButton>
        </div>
        <button
          onClick={() => { setShowRegisterModal(true); setShowRegisterConfirm(false); setFormError('') }}
          className="bg-blue-600 hover:bg-blue-700 text-white text-sm font-semibold px-4 py-1.5 rounded-lg transition-colors whitespace-nowrap"
        >
          + 학생 등록
        </button>
      </div>

      {/* ── 학생 관리 탭 ── */}
      {tab === 'students' && (
        <div className="px-6 space-y-4 pb-8 max-w-screen-2xl mx-auto">
          {/* 학생 목록 */}
          <div className="bg-white rounded-2xl border border-gray-100 shadow-sm overflow-hidden max-w-screen-2xl">
            <div className="px-4 py-3 border-b border-gray-100 flex items-center justify-between">
              <span className="font-semibold text-gray-800 text-sm">
                전체 학생 ({filteredStudents.length}명{search && ` / 검색결과`})
              </span>
              <button
                onClick={() => handlePrintCodes(filteredStudents)}
                className="text-xs text-gray-500 hover:text-blue-600 border border-gray-200 rounded-lg px-2.5 py-1 transition-colors"
              >
                코드 목록 인쇄
              </button>
            </div>
            {filteredStudents.length === 0 ? (
              <div className="py-10 text-center text-gray-400 text-sm">
                {search ? `"${search}" 검색 결과가 없습니다.` : '등록된 학생이 없습니다.'}
              </div>
            ) : (
              <div className="divide-y divide-gray-50">
                {filteredStudents.map((s) => (
                  <div key={s.id} className="px-4 py-3 flex items-center justify-between">
                    <div className="flex items-center gap-3">
                      <div className="w-9 h-9 bg-blue-100 rounded-full flex items-center justify-center text-blue-700 font-bold text-sm">
                        {s.name[0]}
                      </div>
                      <div>
                        <div
                          className="font-medium text-gray-900 text-sm cursor-pointer hover:text-blue-600 transition-colors"
                          onClick={() => openStudentHistory(s)}
                        >{s.name}</div>
                        <div className="text-xs text-gray-400">
                          {s.class} · {s.school}
                          {s.oral_type && <span> · {s.oral_type}</span>}
                          {s.clinic_day && <span> · {s.clinic_day}요일</span>}
                        </div>
                      </div>
                    </div>
                    <div className="flex items-center gap-2">
                      <button
                        onClick={() => navigator.clipboard.writeText(s.code)}
                        title="코드 복사"
                        className="font-mono text-sm font-bold text-blue-600 bg-blue-50 hover:bg-blue-100 px-2.5 py-1 rounded-lg transition-colors"
                      >
                        {s.code}
                      </button>
                      <button
                        onClick={() => setEditTarget(s)}
                        className="text-xs text-gray-400 hover:text-blue-500 transition-colors px-1"
                        title="정보 수정"
                      >
                        ✎
                      </button>
                      <button
                        onClick={() => handleDeleteStudent(s.id, s.name)}
                        className="text-xs text-gray-300 hover:text-red-400 transition-colors px-1"
                        title="학생 삭제"
                      >
                        ✕
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      )}

      {/* ── 주차별 현황 탭 ── */}
      {tab === 'weekly' && (
        <div className="px-6 space-y-4 pb-8 max-w-screen-2xl mx-auto">
          {/* 학기 관리 */}
          <div className="bg-white rounded-2xl border border-gray-100 shadow-sm p-4 space-y-3">
            <div className="flex items-center justify-between">
              <span className="text-sm font-semibold text-gray-800">학기 선택</span>
            </div>
            {/* 학기 선택 버튼 */}
            {terms.length === 0 ? (
              <p className="text-xs text-gray-400">등록된 학기가 없습니다. 아래에서 추가하세요.</p>
            ) : (
              <div className="flex gap-2 flex-wrap">
                {terms.map(t => (
                  <div key={t.id} className="flex items-center gap-1">
                    <button
                      onClick={() => { setSelectedTermId(t.id); setSelectedWeek('') }}
                      className={`px-3 py-1.5 rounded-lg text-sm font-medium transition-colors ${
                        selectedTermId === t.id ? 'bg-blue-600 text-white' : 'bg-gray-100 text-gray-600 hover:bg-gray-200'
                      }`}
                    >
                      {t.name}
                      <span className="ml-1.5 text-xs opacity-60">{t.start_date}</span>
                    </button>
                    <button
                      onClick={() => handleDeleteTerm(t.id, t.name)}
                      className="text-xs text-gray-300 hover:text-red-400 transition-colors px-1"
                    >
                      ✕
                    </button>
                  </div>
                ))}
              </div>
            )}
            {/* 새 학기 추가 */}
            <form onSubmit={handleCreateTerm} className="flex gap-2 items-center flex-wrap pt-1 border-t border-gray-100">
              <span className="text-xs text-gray-500 font-medium whitespace-nowrap">새 학기 추가</span>
              <input
                value={newTermName}
                onChange={(e) => setNewTermName(e.target.value)}
                placeholder="학기 이름 (예: 2026 중간고사 후)"
                className="border border-gray-200 rounded-lg px-3 py-1.5 text-sm focus:outline-none focus:border-blue-400 w-56"
              />
              <input
                type="date"
                value={newTermDate}
                onChange={(e) => setNewTermDate(e.target.value)}
                className="border border-gray-200 rounded-lg px-3 py-1.5 text-sm focus:outline-none focus:border-blue-400"
              />
              <button
                type="submit"
                className="bg-blue-600 hover:bg-blue-700 text-white text-xs font-semibold px-3 py-1.5 rounded-lg transition-colors whitespace-nowrap"
              >
                + 추가
              </button>
              {termFormError && <span className="text-xs text-red-500">{termFormError}</span>}
            </form>
          </div>

          {loading ? (
            <div className="py-16 text-center text-gray-400 text-sm">불러오는 중...</div>
          ) : weekStarts.length === 0 ? (
            <div className="py-16 text-center text-gray-400 text-sm">출석 기록이 없습니다.</div>
          ) : (
            <>
              {/* 주차 선택 */}
              <div className="flex gap-2 flex-wrap">
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

              {/* 주차 헤더 + 엑셀 버튼 */}
              {selectedWeek && (
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
                      <div key={classKey} className="bg-white rounded-2xl border border-gray-100 shadow-sm overflow-hidden">
                        <div className="px-4 py-3 border-b border-gray-100 bg-gray-50">
                          <span className="font-semibold text-gray-800 text-sm">{classKey}</span>
                          <span className="ml-2 text-xs text-gray-400">{classRecords.length}명</span>
                        </div>
                        <div className="overflow-x-auto">
                          <table className="w-full text-sm">
                            <thead>
                              <tr className="border-b border-gray-100">
                                <th className="px-3 py-2.5 text-left text-xs font-semibold text-gray-500">이름</th>
                                <th className="px-3 py-2.5 text-left text-xs font-semibold text-gray-500">구두 방식</th>
                                <th className="px-3 py-2.5 text-center text-xs font-semibold text-gray-500">요일</th>
                                <th className="px-3 py-2.5 text-center text-xs font-semibold text-gray-500">출석</th>
                                <th className="px-3 py-2.5 text-center text-xs font-semibold text-gray-500">등원</th>
                                <th className="px-3 py-2.5 text-center text-xs font-semibold text-gray-500">하원</th>
                                <th className="px-3 py-2.5 text-center text-xs font-semibold text-gray-500">단어</th>
                                <th className="px-3 py-2.5 text-center text-xs font-semibold text-gray-500">클리닉</th>
                                <th className="px-3 py-2.5 text-center text-xs font-semibold text-gray-500">구두</th>
                                <th className="px-3 py-2.5 text-left text-xs font-semibold text-gray-500">미완료 과제</th>
                                <th className="px-3 py-2.5 text-left text-xs font-semibold text-gray-500">기타</th>
                              </tr>
                            </thead>
                            <tbody className="divide-y divide-gray-50">
                              {classRecords.map((r) => (
                                <WeeklyRow
                                  key={r.id}
                                  record={r}
                                  onUpdate={fetchAllRecords}
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
      {/* ── 누적 통계 탭 ── */}
      {tab === 'stats' && (
        <div className="px-6 pb-8 space-y-3 max-w-screen-2xl mx-auto">
          {/* 학기 선택 */}
          {terms.length > 0 && (
            <div className="flex gap-2 flex-wrap">
              {terms.map(t => (
                <button
                  key={t.id}
                  onClick={() => setSelectedTermId(t.id)}
                  className={`px-3 py-1.5 rounded-lg text-sm font-medium transition-colors ${
                    selectedTermId === t.id ? 'bg-blue-600 text-white' : 'bg-white border border-gray-200 text-gray-600 hover:bg-gray-50'
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
                <div className="bg-white rounded-2xl border border-gray-100 shadow-sm overflow-hidden">
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
                          <tr key={s.id} className="hover:bg-gray-50 transition-colors">
                            <td className="px-4 py-3 font-medium text-gray-900">{s.name}</td>
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
        <div className="px-6 pb-8 max-w-screen-xl mx-auto space-y-4">
          <p className="text-xs text-gray-400">기준 주차: {absenceWeek ? `${absenceWeek} 주` : '계산 중...'}</p>

          {/* 미실시 학생 */}
          <div className="bg-white rounded-2xl border border-gray-100 shadow-sm overflow-hidden">
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
                          className="text-xs bg-red-50 hover:bg-red-100 text-red-600 px-2.5 py-1 rounded-lg transition-colors"
                        >사유 입력</button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>

          {/* 미재등원 학생 */}
          <div className="bg-white rounded-2xl border border-gray-100 shadow-sm overflow-hidden">
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
                          className="text-xs bg-orange-50 hover:bg-orange-100 text-orange-600 px-2.5 py-1 rounded-lg transition-colors"
                        >사유 입력</button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>

          {/* 처리된 기록 */}
          <div className="bg-white rounded-2xl border border-gray-100 shadow-sm overflow-hidden">
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

      {/* 학생 등록 모달 */}
      {showRegisterModal && (
        <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 p-4">
          <div className="bg-white rounded-2xl w-full max-w-sm shadow-xl">
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
                    className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-blue-400"
                  />
                </div>
                <div>
                  <label className="text-xs text-gray-500 font-medium mb-1 block">반(선생님) *</label>
                  <input
                    value={form.class}
                    onChange={(e) => setForm({ ...form, class: e.target.value })}
                    placeholder="김선생님반"
                    className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-blue-400"
                  />
                </div>
                <div>
                  <label className="text-xs text-gray-500 font-medium mb-1 block">학교 *</label>
                  <input
                    value={form.school}
                    onChange={(e) => setForm({ ...form, school: e.target.value })}
                    placeholder="신봉고등학교"
                    className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-blue-400"
                  />
                </div>
                <div>
                  <label className="text-xs text-gray-500 font-medium mb-1 block">전화번호 * <span className="text-gray-400 font-normal">(코드 자동 생성)</span></label>
                  <input
                    value={form.phone}
                    onChange={(e) => setForm({ ...form, phone: e.target.value })}
                    placeholder="010-0000-0000"
                    inputMode="numeric"
                    className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-blue-400"
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
                    className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-blue-400 text-gray-700"
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
                    className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-blue-400 text-gray-700"
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
                    className="flex-1 py-2.5 rounded-xl border border-gray-200 text-sm text-gray-500 hover:bg-gray-50 transition-colors"
                  >
                    취소
                  </button>
                  <button
                    type="submit"
                    className="flex-1 py-2.5 rounded-xl bg-blue-600 hover:bg-blue-700 text-white font-semibold text-sm transition-colors"
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
                    className="flex-1 py-2.5 rounded-xl border border-gray-200 text-sm text-gray-500 hover:bg-gray-50 transition-colors"
                  >
                    ← 수정
                  </button>
                  <button
                    onClick={handleRegisterSubmit}
                    disabled={formLoading}
                    className="flex-1 py-2.5 rounded-xl bg-blue-600 hover:bg-blue-700 disabled:bg-gray-300 text-white font-semibold text-sm transition-colors"
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
        <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 p-4">
          <div className="bg-white rounded-2xl w-full max-w-sm p-5 shadow-xl">
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
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
          <div className="bg-white rounded-2xl w-full max-w-2xl max-h-[90vh] overflow-y-auto shadow-2xl">
            <div className="sticky top-0 bg-white border-b border-gray-100 px-6 py-4 flex items-center justify-between">
              <div>
                <h3 className="font-bold text-gray-800 text-lg">{historyTarget.name}</h3>
                <p className="text-xs text-gray-400">{historyTarget.school} · {historyTarget.class} · 코드: {historyTarget.code}</p>
              </div>
              <button onClick={() => setHistoryTarget(null)} className="text-gray-400 hover:text-gray-600 text-xl">✕</button>
            </div>
            <div className="p-6 space-y-6">
              {/* 출석 히스토리 */}
              <div>
                <h4 className="font-semibold text-gray-700 text-sm mb-3">출석 기록 ({historyRecords.length}건)</h4>
                {historyRecords.length === 0 ? <p className="text-sm text-gray-400">기록 없음</p> : (
                  <table className="w-full text-xs">
                    <thead><tr className="border-b border-gray-100 bg-gray-50">
                      <th className="px-3 py-2 text-left text-gray-500">날짜</th>
                      <th className="px-2 py-2 text-center text-gray-500">구분</th>
                      <th className="px-2 py-2 text-center text-gray-500">상태</th>
                      <th className="px-2 py-2 text-center text-gray-500">단어</th>
                      <th className="px-2 py-2 text-center text-gray-500">클리닉</th>
                      <th className="px-2 py-2 text-center text-gray-500">구두</th>
                      <th className="px-2 py-2 text-left text-gray-500">다음 예정</th>
                    </tr></thead>
                    <tbody>
                      {historyRecords.map(r => (
                        <tr key={r.id} className="border-b border-gray-50">
                          <td className="px-3 py-2 text-gray-700">{r.date}</td>
                          <td className="px-2 py-2 text-center">
                            <span className={`px-1.5 py-0.5 rounded text-xs ${r.visit_type === 'class_clinic' ? 'bg-green-100 text-green-600' : 'bg-blue-100 text-blue-600'}`}>
                              {r.visit_type === 'class_clinic' ? '수업+클리닉' : '클리닉'}
                            </span>
                          </td>
                          <td className="px-2 py-2 text-center">
                            {r.status === 'approved' ? <span className="text-green-600">✓</span> : r.status === 'rejected' ? <span className="text-red-400">✕</span> : <span className="text-yellow-500">대기</span>}
                          </td>
                          <td className="px-2 py-2 text-center text-gray-700">{r.word_score || '-'}</td>
                          <td className="px-2 py-2 text-center text-gray-700">{r.clinic_score || '-'}</td>
                          <td className="px-2 py-2 text-center">
                            {r.oral_status === 'pass' ? <span className="text-green-500">P</span> : r.oral_status === 'fail' ? <span className="text-red-400">F</span> : r.oral_status === 'delay' ? <span className="text-yellow-500">D</span> : <span className="text-gray-300">-</span>}
                          </td>
                          <td className="px-2 py-2 text-blue-500">{r.next_clinic_date || '-'}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
              </div>

              {/* 성적 차트 */}
              {historyRecords.filter(r => r.word_score || r.clinic_score).length > 0 && (
                <div>
                  <h4 className="font-semibold text-gray-700 text-sm mb-3">성적 히스토리</h4>
                  <ResponsiveContainer width="100%" height={200}>
                    <BarChart data={[...historyRecords].filter(r => r.word_score || r.clinic_score).reverse().map(r => ({
                      date: r.date.slice(5),
                      단어: r.word_score ? Number(r.word_score) : null,
                      클리닉: r.clinic_score ? Number(r.clinic_score) : null,
                    }))}>
                      <XAxis dataKey="date" tick={{ fontSize: 11 }} />
                      <YAxis tick={{ fontSize: 11 }} />
                      <Tooltip />
                      <Legend />
                      <Bar dataKey="단어" fill="#3b82f6" radius={[3,3,0,0]} />
                      <Bar dataKey="클리닉" fill="#8b5cf6" radius={[3,3,0,0]} />
                    </BarChart>
                  </ResponsiveContainer>
                </div>
              )}

              {/* 결석 사유 기록 */}
              {historyAbsences.length > 0 && (
                <div>
                  <h4 className="font-semibold text-gray-700 text-sm mb-3">결석 사유 기록</h4>
                  <table className="w-full text-xs">
                    <thead><tr className="border-b border-gray-100 bg-gray-50">
                      <th className="px-3 py-2 text-left text-gray-500">주차</th>
                      <th className="px-2 py-2 text-center text-gray-500">구분</th>
                      <th className="px-2 py-2 text-left text-gray-500">사유</th>
                    </tr></thead>
                    <tbody>
                      {historyAbsences.map(a => (
                        <tr key={a.id} className="border-b border-gray-50">
                          <td className="px-3 py-2 text-gray-700">{a.week_start_date}</td>
                          <td className="px-2 py-2 text-center">
                            <span className={`px-1.5 py-0.5 rounded text-xs ${a.type === '미실시' ? 'bg-red-100 text-red-600' : 'bg-orange-100 text-orange-600'}`}>{a.type}</span>
                          </td>
                          <td className="px-2 py-2 text-gray-500">{a.reason || '-'}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      {/* 학생 수정 모달 */}
      {editTarget && (
        <EditStudentModal
          student={editTarget}
          onClose={() => setEditTarget(null)}
          onSaved={fetchStudents}
        />
      )}
    </div>
  )
}

// ── 주차별 행 (과제/기타 인라인 편집) ──────────────────────

const VALID_STATUSES = ['pass', 'fail', 'delay']

function WeeklyRow({ record, onUpdate, onNameClick }: { record: AttendanceWithStudent; onUpdate: () => void; onNameClick?: () => void }) {
  const [notes, setNotes] = useState(record.notes ?? '')
  const [saving, setSaving] = useState(false)

  async function handleBlur(field: 'notes', value: string) {
    const original = record.notes ?? ''
    if (value === original) return
    setSaving(true)
    await supabase.from('attendances').update({ [field]: value || null }).eq('id', record.id)
    setSaving(false)
    onUpdate()
  }

  const homeworkIsStatus = VALID_STATUSES.includes(record.homework as string)

  const checkinTime = record.approved_at
    ? new Date(record.approved_at).toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit' })
    : '-'
  const checkoutTime = record.checked_out_at
    ? new Date(record.checked_out_at).toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit' })
    : '-'

  return (
    <tr className={`hover:bg-gray-50 transition-colors ${saving ? 'opacity-60' : ''}`}>
      <td className="px-3 py-2.5 font-medium text-gray-900 whitespace-nowrap">
        <span onClick={onNameClick} className={onNameClick ? 'cursor-pointer hover:text-blue-600 transition-colors' : ''}>{record.students.name}</span>
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
          : record.status === 'rejected'
          ? <span className="text-red-400 text-xs">거절</span>
          : <span className="text-gray-300">-</span>}
      </td>
      <td className="px-3 py-2.5 text-center text-xs text-gray-500 whitespace-nowrap">{checkinTime}</td>
      <td className="px-3 py-2.5 text-center text-xs text-indigo-500 whitespace-nowrap">{checkoutTime}</td>
      <td className="px-3 py-2.5 text-center text-xs text-gray-700">{record.word_score || '-'}</td>
      <td className="px-3 py-2.5 text-center text-xs text-gray-700">{record.clinic_score || '-'}</td>
      <td className="px-3 py-2.5 text-center"><MissionBadge value={record.oral_status} /></td>
      <td className="px-3 py-2.5 text-center">
        {homeworkIsStatus
          ? <MissionBadge value={record.homework} />
          : <span className="text-xs text-gray-400">{record.homework || '-'}</span>}
      </td>
      <td className="px-3 py-2.5">
        <input
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
          onBlur={(e) => handleBlur('notes', e.target.value)}
          placeholder="입력..."
          className="w-full min-w-[80px] text-xs border-0 border-b border-dashed border-gray-200 focus:border-blue-400 focus:outline-none py-0.5 bg-transparent"
        />
      </td>
    </tr>
  )
}

// ─── 서브 컴포넌트 ────────────────────────────────────────

function TabButton({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      onClick={onClick}
      className={`px-4 py-2 rounded-full text-sm font-medium transition-colors ${
        active ? 'bg-blue-600 text-white' : 'bg-white border border-gray-200 text-gray-600'
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
  }
  const labels: Record<string, string> = { pass: 'Pass', fail: 'Fail', delay: 'Delay' }
  return (
    <span className={`text-xs font-semibold px-2 py-0.5 rounded-full ${styles[value]}`}>
      {labels[value]}
    </span>
  )
}

