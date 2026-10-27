const definitions = {
  unauthenticated: [401, 'Silakan masuk kembali.', false],
  rate_limited: [429, 'Terlalu banyak percobaan masuk. Coba kembali nanti.', false],
  forbidden: [403, 'Anda tidak memiliki akses untuk tindakan ini.', false],
  not_found: [404, 'Data tidak ditemukan.', false],
  validation_failed: [422, 'Periksa kembali data yang dikirim.', false],
  version_conflict: [409, 'Data telah berubah. Muat data terbaru sebelum melanjutkan.', false],
  booking_schedule_conflict: [409, 'Jadwal petugas bertabrakan dengan kunjungan lain. Pilih waktu atau petugas lain.', false],
  idempotency_conflict: [409, 'Identitas permintaan telah digunakan untuk data berbeda.', false],
  dependency_unavailable: [503, 'Layanan belum tersedia. Coba muat kembali.', true],
  processing_failed: [500, 'Proses belum berhasil diselesaikan.', false],
  outcome_unknown: [502, 'Hasil permintaan belum dapat dipastikan. Periksa status sebelum mengirim ulang.', false],
  invalid_flow_output: [502, 'Hasil pemrosesan tidak dapat ditampilkan.', false],
  emergency_guidance_unavailable: [503, 'Informasi layanan darurat belum tersedia.', false],
} as const

export type ErrorCode = keyof typeof definitions
export interface Principal { id: string; role: 'patient' | 'nurse'; capabilities: readonly string[]; patientId?: string }
export interface RequestContext { principal: Principal; requestId: string; idempotencyKey?: string }
export interface Envelope<T> { data: T; requestId: string }

export class DomainError extends Error {
  readonly status: number
  readonly retryable: boolean
  readonly publicMessage: string
  constructor(readonly code: ErrorCode, readonly details: { resourceId?: string; currentVersion?: number } = {}) {
    super(code)
    this.name = 'DomainError'
    const [status, message, retryable] = definitions[code]
    this.status = status; this.publicMessage = message; this.retryable = retryable
  }
}

// New domain routers opt in; legacy Elysia responses retain their existing contract.
export function errorResponse(error: unknown, requestId: string, mutationMayHaveReachedDependency = false): Response {
  const failure = error instanceof DomainError ? error : new DomainError(mutationMayHaveReachedDependency ? 'outcome_unknown' : 'processing_failed')
  return Response.json({ error: {
    code: failure.code, message: failure.publicMessage, requestId, retryable: failure.retryable,
    ...failure.details,
  } }, { status: failure.status, headers: { 'Cache-Control': 'private, no-store' } })
}
