export type AttendanceStatus = 'pending' | 'approved' | 'rejected'

export interface Term {
  id: string
  name: string
  start_date: string
  created_at: string
}
export type MissionStatus = 'pass' | 'fail' | 'delay' | 'word_pass' | 'sentence_pass' | 'partial_pass' | null

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

export type VisitType = 'clinic' | 'class_clinic'

export interface Attendance {
  id: string
  student_id: string
  date: string
  status: AttendanceStatus
  visit_type: VisitType
  checked_in_at: string | null
  approved_at: string | null
  checked_out_at: string | null
  rechecked_in_at: string | null
  next_clinic_date: string | null
  force_next_clinic: boolean
  word_status: MissionStatus
  oral_status: MissionStatus
  word_score: string | null
  clinic_score: string | null
  reject_reason: string | null
  homework: string | null
  notes: string | null
  oral_memo: string | null
  homework_memo: string | null
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
  visit_type?: VisitType
  checked_in_at?: string | null
  approved_at?: string | null
  checked_out_at?: string | null
  rechecked_in_at?: string | null
  next_clinic_date?: string | null
  word_status?: MissionStatus
  oral_status?: MissionStatus
  word_score?: string | null
  clinic_score?: string | null
  reject_reason?: string | null
  homework?: string | null
  notes?: string | null
  oral_memo?: string | null
  homework_memo?: string | null
}

export interface ClinicAbsence {
  id: string
  student_id: string
  term_id: string
  week_start_date: string
  type: '미실시' | '미재등원'
  reason: string | null
  created_at: string
}

export interface ClinicAbsenceWithStudent extends ClinicAbsence {
  students: Student
}

export type AttendanceUpdate = Partial<Omit<AttendanceInsert, 'student_id'>>

export interface OralQueue {
  id: string
  attendance_id: string
  student_id: string
  status: 'waiting' | 'called' | 'done'
  caller: string | null
  created_at: string
}

export interface OralQueueWithStudent extends OralQueue {
  students: Student
}

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
