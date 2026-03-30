export type AttendanceStatus = 'pending' | 'approved' | 'rejected'
export type MissionStatus = 'pass' | 'fail' | null

export interface Student {
  id: string
  name: string
  code: string
  class: string
  school: string
  oral_type: string   // 구두 진행 방식 (빈칸 구두, 별구두 등)
  clinic_day: string  // 클리닉 요일 (월/화/수/목/금)
  created_at: string
}

export interface Attendance {
  id: string
  student_id: string
  date: string
  status: AttendanceStatus
  checked_in_at: string | null
  approved_at: string | null
  checked_out_at: string | null
  word_status: MissionStatus
  oral_status: MissionStatus
  reject_reason: string | null
  homework: string | null   // 미완료 과제 입력
  notes: string | null      // 기타
}

export interface AttendanceWithStudent extends Attendance {
  students: Student
}

export type Database = {
  public: {
    Tables: {
      students: {
        Row: Student
        Insert: Omit<Student, 'id' | 'created_at'>
        Update: Partial<Omit<Student, 'id' | 'created_at'>>
      }
      attendances: {
        Row: Attendance
        Insert: Omit<Attendance, 'id'>
        Update: Partial<Omit<Attendance, 'id'>>
      }
    }
  }
}
