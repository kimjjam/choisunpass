import { useState } from 'react'
import { supabase } from '../lib/supabase'
import type { Student } from '../lib/database.types'

const ORAL_TYPES = ['빈칸 구두', '별구두', '해석 구두', '별 빈칸 구두', '기타']
const CLINIC_DAYS = ['월', '화', '수', '목', '금']

export default function EditStudentModal({
  student,
  onClose,
  onSaved,
}: {
  student: Student
  onClose: () => void
  onSaved: () => void
}) {
  const [form, setForm] = useState({
    name: student.name,
    class: student.class,
    school: student.school,
    oral_type: student.oral_type,
    clinic_day: student.clinic_day,
  })
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)

  async function handleSave(e: React.FormEvent) {
    e.preventDefault()
    setError('')
    if (!form.name.trim()) { setError('이름을 입력하세요.'); return }
    if (!form.class.trim()) { setError('반(선생님)을 입력하세요.'); return }
    if (!form.school.trim()) { setError('학교를 입력하세요.'); return }

    setLoading(true)
    const { error } = await supabase.from('students').update({
      name: form.name.trim(),
      class: form.class.trim(),
      school: form.school.trim(),
      oral_type: form.oral_type.trim(),
      clinic_day: form.clinic_day,
    }).eq('id', student.id)

    if (error) {
      setError('저장 실패. 다시 시도해주세요.')
    } else {
      onSaved()
      onClose()
    }
    setLoading(false)
  }

  return (
    <div className="fixed inset-0 bg-black/40 flex items-end justify-center z-50 p-4">
      <div className="bg-white rounded-2xl w-full max-w-sm p-5">
        <h3 className="font-semibold text-gray-800 mb-4">학생 정보 수정</h3>
        <form onSubmit={handleSave} className="space-y-2.5">
          <div className="grid grid-cols-2 gap-2">
            <input
              value={form.class}
              onChange={(e) => setForm({ ...form, class: e.target.value })}
              placeholder="반(선생님)"
              className="border border-gray-200 rounded-xl px-3 py-2.5 text-sm focus:outline-none focus:border-blue-400"
            />
            <input
              value={form.school}
              onChange={(e) => setForm({ ...form, school: e.target.value })}
              placeholder="학교"
              className="border border-gray-200 rounded-xl px-3 py-2.5 text-sm focus:outline-none focus:border-blue-400"
            />
          </div>
          <input
            value={form.name}
            onChange={(e) => setForm({ ...form, name: e.target.value })}
            placeholder="이름"
            className="w-full border border-gray-200 rounded-xl px-3 py-2.5 text-sm focus:outline-none focus:border-blue-400"
          />
          <div className="grid grid-cols-2 gap-2">
            <select
              value={form.oral_type}
              onChange={(e) => setForm({ ...form, oral_type: e.target.value })}
              className="border border-gray-200 rounded-xl px-3 py-2.5 text-sm focus:outline-none focus:border-blue-400 text-gray-700"
            >
              <option value="">구두 방식 선택</option>
              {ORAL_TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
            </select>
            <select
              value={form.clinic_day}
              onChange={(e) => setForm({ ...form, clinic_day: e.target.value })}
              className="border border-gray-200 rounded-xl px-3 py-2.5 text-sm focus:outline-none focus:border-blue-400 text-gray-700"
            >
              <option value="">요일 선택</option>
              {CLINIC_DAYS.map((d) => <option key={d} value={d}>{d}요일</option>)}
            </select>
          </div>
          {error && <p className="text-xs text-red-500">{error}</p>}
          <div className="flex gap-2 pt-1">
            <button
              type="button"
              onClick={onClose}
              className="flex-1 py-3 rounded-xl border border-gray-200 text-sm text-gray-600 font-medium"
            >
              취소
            </button>
            <button
              type="submit"
              disabled={loading}
              className="flex-1 py-3 rounded-xl bg-blue-600 hover:bg-blue-700 disabled:bg-gray-300 text-white text-sm font-semibold transition-colors"
            >
              {loading ? '저장 중...' : '저장'}
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}
