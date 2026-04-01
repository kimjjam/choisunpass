export type AttendanceStatus = 'pending' | 'approved' | 'rejected'

export interface Term {
  id: string
  name: string
  start_date: string
  created_at: string
}
export type MissionStatus = 'pass' | 'fail' | 'delay' | null

export interface Student {
  id: string
  name: string
  code: string
  class: string
  school: string
  oral_type: string
  clinic_day: string
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
  rechecked_in_at: string | null
  word_status: MissionStatus
  oral_status: MissionStatus
  word_score: string | null
  clinic_score: string | null
  reject_reason: string | null
  homework: string | null
  notes: string | null
}

export interface AttendanceWithStudent extends Attendance {
  students: Student
}

export type StudentInsert = {
  name: string
  code: string
  class: string
  school: string
  oral_type: string
  clinic_day: string
}

export type StudentUpdate = Partial<StudentInsert>

export type AttendanceInsert = {
  student_id: string
  date: string
  status?: AttendanceStatus
  checked_in_at?: string | null
  approved_at?: string | null
  checked_out_at?: string | null
  rechecked_in_at?: string | null
  word_status?: MissionStatus
  oral_status?: MissionStatus
  word_score?: string | null
  clinic_score?: string | null
  reject_reason?: string | null
  homework?: string | null
  notes?: string | null
}

export type AttendanceUpdate = Partial<Omit<AttendanceInsert, 'student_id'>>

export type Database = {
  public: {
    Tables: {
      students: {
        Row: Student
        Insert: StudentInsert
        Update: StudentUpdate
      }
      attendances: {
        Row: Attendance
        Insert: AttendanceInsert
        Update: AttendanceUpdate
      }
    }
  }
}
