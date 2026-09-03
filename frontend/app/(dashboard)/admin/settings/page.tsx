'use client'

import { useState } from 'react'
import api from '@/lib/api'
import {
  Settings,
  Play,
  Loader2,
  CheckCircle2,
  AlertTriangle,
  XCircle,
  Copy,
  Check,
  RotateCcw,
  Info,
} from 'lucide-react'

type CheckStatus = 'ok' | 'warn' | 'fail'

interface CheckResult {
  id: string
  group: string
  name: string
  /** baca | tulis | eksternal — says whether running it changes anything. */
  kind: string
  status: CheckStatus
  /** The server's own words, shown verbatim. */
  detail: string
  durationMs: number
}

interface CheckRun {
  ranAt: string
  totalMs: number
  summary: { total: number; ok: number; warn: number; fail: number }
  results: CheckResult[]
}

const STATUS_STYLE: Record<CheckStatus, { label: string; className: string; Icon: any }> = {
  ok: {
    label: 'Sehat',
    className: 'text-emerald-700 dark:text-emerald-400',
    Icon: CheckCircle2,
  },
  warn: {
    label: 'Perhatian',
    className: 'text-amber-700 dark:text-amber-400',
    Icon: AlertTriangle,
  },
  fail: {
    label: 'Gagal',
    className: 'text-red-700 dark:text-red-400',
    Icon: XCircle,
  },
}

/** What running a given check costs, said plainly rather than hidden in code. */
const KIND_NOTE: Record<string, string> = {
  baca: 'hanya membaca',
  eksternal: 'memanggil Shopee',
  tulis: 'menulis 1 berkas sementara, lalu dihapus',
}

export default function SettingsPage() {
  const [run, setRun] = useState<CheckRun | null>(null)
  const [busy, setBusy] = useState(false)
  const [rowBusy, setRowBusy] = useState<string | null>(null)
  const [error, setError] = useState('')
  const [copied, setCopied] = useState(false)

  const runAll = async () => {
    setBusy(true)
    setError('')
    try {
      const res = await api.get<CheckRun>('/system/checks')
      setRun(res.data)
    } catch (err: any) {
      setError(err?.response?.data?.error || err?.message || 'Gagal menjalankan pemeriksaan')
    } finally {
      setBusy(false)
    }
  }

  /**
   * Re-run one row without disturbing the rest.
   *
   * A failing check is usually followed by a fix and an immediate retry, and
   * re-running the whole suite for that means waiting on Shopee again.
   */
  const runOne = async (id: string) => {
    setRowBusy(id)
    setError('')
    try {
      const res = await api.get<CheckRun>('/system/checks', { params: { only: id } })
      const fresh = res.data.results[0]
      setRun((prev) => {
        if (!prev) return res.data
        const results = prev.results.map((r) => (r.id === id ? fresh : r))
        return {
          ...prev,
          results,
          summary: {
            total: results.length,
            ok: results.filter((r) => r.status === 'ok').length,
            warn: results.filter((r) => r.status === 'warn').length,
            fail: results.filter((r) => r.status === 'fail').length,
          },
        }
      })
    } catch (err: any) {
      setError(err?.response?.data?.error || err?.message || 'Gagal menjalankan pemeriksaan')
    } finally {
      setRowBusy(null)
    }
  }

  // Groups in the order the server returned them, so related checks stay together.
  const groups = run ? [...new Set(run.results.map((r) => r.group))] : []

  /**
   * A plain-text report.
   *
   * The point of this button: whoever notices the problem is usually not the
   * person who can fix it. A screenshot loses the server's exact wording, and
   * that wording is the whole diagnosis.
   */
  const copyReport = async () => {
    if (!run) return
    const lines = [
      'LAPORAN CEK SISTEM — OrderPro',
      'Dijalankan: ' + new Date(run.ranAt).toLocaleString('id-ID'),
      `Ringkasan: ${run.summary.total} pemeriksaan · ${run.summary.ok} sehat · ${run.summary.warn} perhatian · ${run.summary.fail} gagal · ${(run.totalMs / 1000).toFixed(1)} detik`,
      '',
      'CATATAN: yang diperiksa adalah jalur dan lingkungannya, bukan kebenaran datanya.',
      '',
    ]
    for (const group of groups) {
      lines.push('== ' + group + ' ==')
      for (const r of run.results.filter((x) => x.group === group)) {
        lines.push(`[${STATUS_STYLE[r.status].label.toUpperCase()}] ${r.name} (${r.durationMs} ms)`)
        lines.push('    ' + r.detail)
      }
      lines.push('')
    }

    try {
      await navigator.clipboard.writeText(lines.join('\n'))
      setCopied(true)
      setTimeout(() => setCopied(false), 3000)
    } catch {
      setError('Browser menolak akses papan klip. Salin manual dari layar.')
    }
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-gray-900 dark:text-slate-100 flex items-center gap-2">
          <Settings className="w-6 h-6" /> Pengaturan
        </h1>
        <p className="text-sm text-gray-500 dark:text-slate-400 mt-1">
          Pengaturan dan alat bantu khusus admin
        </p>
      </div>

      <div className="card p-5 space-y-4">
        <div className="flex flex-col sm:flex-row sm:items-start justify-between gap-4">
          <div>
            <h2 className="font-semibold text-gray-900 dark:text-slate-100">Cek Sistem</h2>
            <p className="text-sm text-gray-500 dark:text-slate-400 mt-0.5">
              Memeriksa apakah aplikasi masih terhubung dengan semua yang dibutuhkannya
            </p>
          </div>
          <button onClick={runAll} disabled={busy} className="btn-primary shrink-0 flex items-center gap-2">
            {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : <Play className="w-4 h-4" />}
            Jalankan Pemeriksaan
          </button>
        </div>

        {/* Without this, "semua sehat" gets read as "aplikasi sudah benar" — and
            the sync comparison panel exists precisely because those two are not
            the same thing. */}
        <div className="rounded-lg border border-blue-200 dark:border-blue-800 bg-blue-50 dark:bg-blue-950/30 px-4 py-3 flex items-start gap-2.5 text-sm text-blue-900 dark:text-blue-200">
          <Info className="w-4 h-4 mt-0.5 shrink-0" />
          <p>
            Yang diperiksa di sini adalah <span className="font-semibold">jalur dan lingkungannya</span> —
            kredensial terisi, database terhubung, Shopee mau menjawab, folder bisa ditulis.
            Bukan kebenaran datanya. Semua bisa hijau di sini sementara daftar pesanan tetap tidak cocok
            dengan Seller Centre; untuk itu, lihat panel &ldquo;Cocok dengan Shopee&rdquo; di halaman Pesanan.
          </p>
        </div>

        {error && (
          <div className="rounded-lg border border-red-200 dark:border-red-800 bg-red-50 dark:bg-red-950/30 px-4 py-3 text-sm text-red-700 dark:text-red-300 break-words [overflow-wrap:anywhere]">
            {error}
          </div>
        )}

        {!run && !busy && (
          <p className="text-sm text-gray-500 dark:text-slate-400 py-6 text-center">
            Belum dijalankan. Tekan tombol di atas.
          </p>
        )}

        {run && (
          <>
            <div className="flex flex-wrap items-center gap-x-5 gap-y-2 rounded-lg bg-gray-50 dark:bg-slate-800/60 px-4 py-3 text-sm">
              <span className="text-gray-600 dark:text-slate-300">
                <span className="font-semibold">{run.summary.total}</span> pemeriksaan
              </span>
              <span className="text-emerald-700 dark:text-emerald-400 font-medium">{run.summary.ok} sehat</span>
              {run.summary.warn > 0 && (
                <span className="text-amber-700 dark:text-amber-400 font-medium">{run.summary.warn} perhatian</span>
              )}
              {run.summary.fail > 0 && (
                <span className="text-red-700 dark:text-red-400 font-medium">{run.summary.fail} gagal</span>
              )}
              <span className="text-gray-500 dark:text-slate-400">{(run.totalMs / 1000).toFixed(1)} detik</span>
              <button
                onClick={copyReport}
                className="btn-secondary ml-auto flex items-center gap-2 text-xs"
                title="Salin sebagai teks polos untuk dikirim ke developer"
              >
                {copied ? <Check className="w-3.5 h-3.5" /> : <Copy className="w-3.5 h-3.5" />}
                {copied ? 'Tersalin' : 'Salin Hasil'}
              </button>
            </div>

            {groups.map((group) => (
              <div key={group} className="space-y-1.5">
                <p className="text-xs font-semibold uppercase tracking-wider text-gray-400 dark:text-slate-500 pt-1">
                  {group}
                </p>
                {run.results.filter((r) => r.group === group).map((result) => {
                  const style = STATUS_STYLE[result.status]
                  const StatusIcon = style.Icon
                  return (
                    <div
                      key={result.id}
                      className="rounded-lg border border-gray-200 dark:border-slate-700 px-3 py-2.5"
                    >
                      <div className="flex items-start justify-between gap-3">
                        <div className="flex items-start gap-2 min-w-0">
                          <StatusIcon className={`w-4 h-4 mt-0.5 shrink-0 ${style.className}`} />
                          <div className="min-w-0">
                            <p className="text-sm font-medium text-gray-900 dark:text-slate-100">
                              {result.name}
                            </p>
                            {/* Verbatim. Rewriting this into "Terjadi kesalahan"
                                would throw away the only part that cannot be
                                guessed from outside. */}
                            <p className="text-xs text-gray-600 dark:text-slate-300 mt-0.5 break-words [overflow-wrap:anywhere]">
                              {result.detail}
                            </p>
                            <p className="text-[11px] text-gray-400 dark:text-slate-500 mt-1">
                              {KIND_NOTE[result.kind] || result.kind} · {result.durationMs} ms
                            </p>
                          </div>
                        </div>
                        <button
                          onClick={() => runOne(result.id)}
                          disabled={rowBusy === result.id || busy}
                          className="btn-ghost p-1.5 shrink-0 text-gray-500"
                          title="Jalankan ulang pemeriksaan ini saja"
                        >
                          {rowBusy === result.id ? (
                            <Loader2 className="w-3.5 h-3.5 animate-spin" />
                          ) : (
                            <RotateCcw className="w-3.5 h-3.5" />
                          )}
                        </button>
                      </div>
                    </div>
                  )
                })}
              </div>
            ))}
          </>
        )}
      </div>
    </div>
  )
}
