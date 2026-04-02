import { useState, useEffect } from 'react'
import * as XLSX from 'xlsx'
import { useNavigate } from 'react-router-dom'
import { supabase } from '../lib/supabase'
import { useCurrentUser } from '../hooks/useCurrentUser'
import type { Student, AttendanceWithStudent, Term } from '../lib/database.types'
import EditStudentModal from '../components/EditStudentModal'

type AdminTab = 'students' | 'weekly' | 'stats'

const ORAL_TYPES = ['빈칸 구두', '별구두', '해석 구두', '별 빈칸 구두', '기타']
const CLINIC_DAYS = ['월', '화', '수', '목', '금']

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

  // 학생 등록 폼
  const [form, setForm] = useState({ name: '', class: '', school: '', oral_type: '', clinic_day: '' })
  const [formError, setFormError] = useState('')
  const [formLoading, setFormLoading] = useState(false)

  const [editTarget, setEditTarget] = useState<Student | null>(null)

  const [search, setSearch] = useState('')
  const [dayFilter, setDayFilter] = useState<string>('')
  const [schoolFilter, setSchoolFilter] = useState<string>('')

  // 주차별 탭에서 선택된 주차
  const [selectedWeek, setSelectedWeek] = useState<string>('')

  // 누적 통계 정렬
  const [statsSort, setStatsSort] = useState<{ col: string; dir: 'asc' | 'desc' }>({ col: '', dir: 'desc' })

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

  // 4자리 숫자 랜덤 코드 생성
  function generateCode(): string {
    return String(Math.floor(Math.random() * 10000)).padStart(4, '0')
  }

  async function handleRegister(e: React.FormEvent) {
    e.preventDefault()
    setFormError('')
    if (!form.class.trim()) { setFormError('반(선생님)을 입력하세요.'); return }
    if (!form.school.trim()) { setFormError('학교를 입력하세요.'); return }
    if (!form.name.trim()) { setFormError('이름을 입력하세요.'); return }

    setFormLoading(true)
    let code = generateCode()
    while (true) {
      const { data } = await supabase.from('students').select('id').eq('code', code).single()
      if (!data) break
      code = generateCode()
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
    } else {
      setForm({ name: '', class: '', school: '', oral_type: '', clinic_day: '' })
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
      <div className="px-6 pt-4 flex gap-2 mb-4">
        <TabButton active={tab === 'students'} onClick={() => setTab('students')}>학생 관리</TabButton>
        <TabButton active={tab === 'weekly'} onClick={() => setTab('weekly')}>주차별 현황</TabButton>
        <TabButton active={tab === 'stats'} onClick={() => { setTab('stats'); fetchAllRecords() }}>누적 통계</TabButton>
      </div>

      {/* ── 학생 관리 탭 ── */}
      {tab === 'students' && (
        <div className="px-6 space-y-4 pb-8 max-w-screen-2xl mx-auto">
          <div className="bg-white rounded-2xl border border-gray-100 shadow-sm p-4">
            <h2 className="font-semibold text-gray-800 mb-3 text-sm">새 학생 등록</h2>
            <form onSubmit={handleRegister}>
              <div className="flex gap-2 flex-wrap items-end">
                <input
                  value={form.class}
                  onChange={(e) => setForm({ ...form, class: e.target.value })}
                  placeholder="반(선생님)"
                  className="border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-blue-400 w-36"
                />
                <input
                  value={form.school}
                  onChange={(e) => setForm({ ...form, school: e.target.value })}
                  placeholder="학교"
                  className="border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-blue-400 w-40"
                />
                <input
                  value={form.name}
                  onChange={(e) => setForm({ ...form, name: e.target.value })}
                  placeholder="이름"
                  className="border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-blue-400 w-28"
                />
                <select
                  value={form.oral_type}
                  onChange={(e) => setForm({ ...form, oral_type: e.target.value })}
                  className="border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-blue-400 text-gray-700 w-40"
                >
                  <option value="">구두 방식 선택</option>
                  {ORAL_TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
                </select>
                <select
                  value={form.clinic_day}
                  onChange={(e) => setForm({ ...form, clinic_day: e.target.value })}
                  className="border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-blue-400 text-gray-700 w-32"
                >
                  <option value="">요일 선택</option>
                  {CLINIC_DAYS.map((d) => <option key={d} value={d}>{d}요일</option>)}
                </select>
                <button
                  type="submit"
                  disabled={formLoading}
                  className="bg-blue-600 hover:bg-blue-700 disabled:bg-gray-300 text-white font-semibold py-2 px-4 rounded-lg text-sm transition-colors whitespace-nowrap"
                >
                  {formLoading ? '등록 중...' : '+ 등록'}
                </button>
              </div>
              {formError && <p className="text-xs text-red-500 mt-2">{formError}</p>}
            </form>
          </div>

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
                        <div className="font-medium text-gray-900 text-sm">{s.name}</div>
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
                    <button
                      onClick={() => handleExcelDownload(selectedWeek, weekRecords, weekLabel(selectedWeek, selectedTerm?.start_date ?? selectedWeek))}
                      disabled={weekRecords.length === 0}
                      className="bg-green-600 hover:bg-green-700 disabled:bg-gray-300 text-white font-semibold px-4 py-2 rounded-xl text-sm transition-colors"
                    >
                      엑셀 다운로드
                    </button>
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

function WeeklyRow({ record, onUpdate }: { record: AttendanceWithStudent; onUpdate: () => void }) {
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
      <td className="px-3 py-2.5 font-medium text-gray-900 whitespace-nowrap">{record.students.name}</td>
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

