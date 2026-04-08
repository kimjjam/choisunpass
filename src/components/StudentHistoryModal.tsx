import { useState } from 'react'
import { BarChart, Bar, XAxis, YAxis, Tooltip, Legend, ResponsiveContainer } from 'recharts'
import type { Student, AttendanceWithStudent, ClinicAbsenceWithStudent } from '../lib/database.types'

interface Props {
  student: Student
  records: AttendanceWithStudent[]
  onClose: () => void
  showChart?: boolean
  absences?: ClinicAbsenceWithStudent[]
}

function ScoreBadge({ value }: { value: string | null }) {
  if (!value) return <span className="text-gray-300">-</span>
  const isDelay = value === '00' || value === '--'
  return <span className={isDelay ? 'text-orange-500 font-semibold' : 'text-gray-700'}>{value}</span>
}

function StatusBadge({ value }: { value: string | null }) {
  if (value === 'pass') return <span className="text-green-500 font-medium">P</span>
  if (value === 'fail') return <span className="text-red-400 font-medium">F</span>
  if (value === 'delay') return <span className="text-yellow-500 font-medium">D</span>
  if (value === 'word_pass') return <span className="text-orange-500 font-medium">단어P</span>
  if (value === 'sentence_pass') return <span className="text-orange-500 font-medium">문장P</span>
  if (value === 'partial_pass') return <span className="text-orange-500 font-medium">일부P</span>
  return <span className="text-gray-300">-</span>
}

export default function StudentHistoryModal({ student, records, onClose, showChart = false, absences }: Props) {
  const [popover, setPopover] = useState<{ text: string; x: number; y: number } | null>(null)

  function handleNoteClick(e: React.MouseEvent, text: string) {
    if (!text) return
    if (popover) { setPopover(null); return }
    // getBoundingClientRect()는 뷰포트 기준 → 스크롤과 무관하게 정확한 위치
    const rect = (e.target as HTMLElement).getBoundingClientRect()
    setPopover({ text, x: rect.left, y: rect.bottom + 6 })
  }

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4" onClick={() => setPopover(null)}>
      {/* 기타 말풍선 팝오버 */}
      {popover && (
        <div
          className="fixed z-[60] bg-gray-800 text-white text-xs rounded-xl px-3 py-2 max-w-xs shadow-xl whitespace-pre-wrap"
          style={{ left: popover.x, top: popover.y }}
          onClick={(e) => e.stopPropagation()}
        >
          {popover.text}
          <div className="absolute -top-1.5 left-4 w-3 h-3 bg-gray-800 rotate-45" />
        </div>
      )}
      <div className="bg-white rounded-2xl w-full max-w-3xl max-h-[90vh] overflow-y-auto shadow-2xl" onClick={(e) => e.stopPropagation()} onScroll={() => setPopover(null)}>
        {/* 헤더 */}
        <div className="sticky top-0 bg-white border-b border-gray-100 px-6 py-4 flex items-center justify-between">
          <div>
            <h3 className="font-bold text-gray-800 text-lg">{student.name}</h3>
            <p className="text-xs text-gray-400">{student.school} · {student.class} · 코드: {student.code}</p>
          </div>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600 text-xl">✕</button>
        </div>

        <div className="p-6 space-y-6">
          {/* 출석 기록 */}
          <div>
            <h4 className="font-semibold text-gray-700 text-sm mb-3">출석 기록 ({records.length}건)</h4>
            {records.length === 0 ? (
              <p className="text-sm text-gray-400">기록 없음</p>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-xs">
                  <thead>
                    <tr className="border-b border-gray-100 bg-gray-50">
                      <th className="px-3 py-2 text-left text-gray-500 whitespace-nowrap">날짜</th>
                      <th className="px-2 py-2 text-center text-gray-500">구분</th>
                      <th className="px-2 py-2 text-center text-gray-500">상태</th>
                      <th className="px-2 py-2 text-center text-gray-500">단어</th>
                      <th className="px-2 py-2 text-center text-gray-500">클리닉</th>
                      <th className="px-2 py-2 text-center text-gray-500">구두</th>
                      <th className="px-2 py-2 text-center text-gray-500">과제</th>
                      <th className="px-2 py-2 text-left text-gray-500">기타</th>
                      <th className="px-2 py-2 text-left text-gray-500 whitespace-nowrap">재등원 예정</th>
                    </tr>
                  </thead>
                  <tbody>
                    {records.map(r => (
                      <tr key={r.id} className="border-b border-gray-50 hover:bg-gray-50">
                        <td className="px-3 py-2 text-gray-700 whitespace-nowrap">{r.date}</td>
                        <td className="px-2 py-2 text-center">
                          <span className={`px-1.5 py-0.5 rounded text-xs ${r.visit_type === 'class_clinic' ? 'bg-green-100 text-green-600' : 'bg-blue-100 text-blue-600'}`}>
                            {r.visit_type === 'class_clinic' ? '수업+클리닉' : '클리닉'}
                          </span>
                        </td>
                        <td className="px-2 py-2 text-center">
                          {r.status === 'approved'
                            ? <span className="text-green-600">✓</span>
                            : r.status === 'rejected'
                            ? <span className="text-red-400">✕</span>
                            : <span className="text-yellow-500">대기</span>}
                        </td>
                        <td className="px-2 py-2 text-center"><ScoreBadge value={r.word_score} /></td>
                        <td className="px-2 py-2 text-center"><ScoreBadge value={r.clinic_score} /></td>
                        <td className="px-2 py-2 text-center"><StatusBadge value={r.oral_status} /></td>
                        <td className="px-2 py-2 text-center"><StatusBadge value={r.homework} /></td>
                        <td className="px-2 py-2 max-w-[140px]">
                          {(r.oral_memo || r.homework_memo || r.notes) ? (
                            <div className="flex flex-col gap-0.5 cursor-pointer" onClick={(e) => {
                              const parts = []
                              if (r.oral_memo) parts.push(`[구두] ${r.oral_memo}`)
                              if (r.homework_memo) parts.push(`[과제] ${r.homework_memo}`)
                              if (r.notes) parts.push(`[기타] ${r.notes}`)
                              handleNoteClick(e, parts.join('\n'))
                            }}>
                              {r.oral_memo && <span className="text-blue-500 truncate text-xs max-w-[130px] block">구두: {r.oral_memo}</span>}
                              {r.homework_memo && <span className="text-purple-500 truncate text-xs max-w-[130px] block">과제: {r.homework_memo}</span>}
                              {r.notes && <span className="text-gray-500 truncate text-xs max-w-[130px] block">기타: {r.notes}</span>}
                            </div>
                          ) : (
                            <span className="text-gray-300">-</span>
                          )}
                        </td>
                        <td className="px-2 py-2 text-blue-500 whitespace-nowrap">{r.next_clinic_date || '-'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>

          {/* 성적 차트 (optional) */}
          {showChart && records.filter(r => r.word_score || r.clinic_score).length > 0 && (
            <div>
              <h4 className="font-semibold text-gray-700 text-sm mb-3">성적 히스토리</h4>
              <ResponsiveContainer width="100%" height={200}>
                <BarChart data={[...records].filter(r => r.word_score || r.clinic_score).reverse().map(r => ({
                  date: r.date.slice(5),
                  단어: r.word_score ? Number(r.word_score) : null,
                  클리닉: r.clinic_score ? Number(r.clinic_score) : null,
                }))}>
                  <XAxis dataKey="date" tick={{ fontSize: 11 }} />
                  <YAxis tick={{ fontSize: 11 }} />
                  <Tooltip />
                  <Legend />
                  <Bar dataKey="단어" fill="#3b82f6" radius={[3, 3, 0, 0]} />
                  <Bar dataKey="클리닉" fill="#8b5cf6" radius={[3, 3, 0, 0]} />
                </BarChart>
              </ResponsiveContainer>
            </div>
          )}

          {/* 결석 사유 기록 (optional) */}
          {absences && absences.length > 0 && (
            <div>
              <h4 className="font-semibold text-gray-700 text-sm mb-3">결석 사유 기록</h4>
              <table className="w-full text-xs">
                <thead>
                  <tr className="border-b border-gray-100 bg-gray-50">
                    <th className="px-3 py-2 text-left text-gray-500">주차</th>
                    <th className="px-2 py-2 text-center text-gray-500">구분</th>
                    <th className="px-2 py-2 text-left text-gray-500">사유</th>
                  </tr>
                </thead>
                <tbody>
                  {absences.map(a => (
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
  )
}
