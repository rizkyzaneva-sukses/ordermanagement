'use client'

import { useRef, useState } from 'react'
import api from '@/lib/api'
import { apiError } from '@/lib/productDraft'
import { downloadFile, readFileError } from '@/lib/download'
import HelpTip from '@/components/HelpTip'
import { AlertTriangle, Download, FileUp, Loader2, X } from 'lucide-react'

interface RowIssue {
  row: number
  message: string
}

interface StockChange {
  row: number
  productId: string
  masterSku: string
  name: string
  from: number
  to: number
  drifted: boolean
  exported: number | null
}

interface Preview {
  rows: unknown[]
  ok: boolean
  counts: { rows: number; changes: number; unchanged: number; blank: number; drifted: number; errors: number }
  errors: RowIssue[]
  changes: StockChange[]
}

interface Props {
  /** The Daftar Stok search, so Export Stok downloads what is on screen. */
  search: string
  onClose: () => void
  /** Stock was saved; the page should reload and say so. */
  onDone: (text: string) => void
}

const n = (v: number) => v.toLocaleString('id-ID')

/**
 * Export Stok / Import Stok — a stock count in Excel. Stok Baru replaces the
 * master's stock (PRD-import-xlsx.md, decision 3).
 */
export default function ImportStockModal({ search, onClose, onDone }: Props) {
  const [downloading, setDownloading] = useState(false)
  const [reading, setReading] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [preview, setPreview] = useState<Preview | null>(null)
  const fileRef = useRef<HTMLInputElement>(null)

  const busy = downloading || reading || saving

  const exportStock = async () => {
    setDownloading(true)
    setError(null)
    try {
      await downloadFile('/products/masters/stock-export', search ? { search } : {}, 'stok-master.xlsx')
    } catch (err) {
      setError(await readFileError(err, 'Gagal mengunduh file stok'))
    } finally {
      setDownloading(false)
    }
  }

  const upload = async (file: File) => {
    if (!/\.xlsx$/i.test(file.name)) {
      setError('File harus .xlsx (Excel). Kalau dari Google Sheets: File → Download → Microsoft Excel.')
      return
    }
    setReading(true)
    setError(null)
    try {
      const form = new FormData()
      form.append('file', file)
      const res = await api.post<any>('/products/masters/stock-import/preview', form, {
        headers: { 'Content-Type': 'multipart/form-data' },
        timeout: 300_000,
      })
      setPreview(res.data as Preview)
    } catch (err) {
      setError(apiError(err, 'Gagal membaca file'))
    } finally {
      setReading(false)
      if (fileRef.current) fileRef.current.value = ''
    }
  }

  const save = async () => {
    if (!preview) return
    setSaving(true)
    setError(null)
    try {
      const res = await api.post<any>('/products/masters/stock-import', { rows: preview.rows }, { timeout: 300_000 })
      const updated: number = res.data?.updated ?? 0
      onDone(
        `Import Stok: ${n(updated)} master diubah` +
        (updated > 0 ? ' dan sedang dikirim ke Shopee. Kolom "Di Shopee" ikut berubah dalam beberapa menit.' : '.'),
      )
    } catch (err: any) {
      const fresh = err?.response?.data?.data
      if (fresh?.counts) setPreview({ ...(fresh as Preview), rows: preview.rows })
      setError(apiError(err, 'Gagal mengimpor stok'))
    } finally {
      setSaving(false)
    }
  }

  const counts = preview?.counts

  return (
    <div className="fixed inset-0 z-[70] flex items-center justify-center bg-black/40 p-4" onClick={busy ? undefined : onClose}>
      <div className="card w-full max-w-3xl p-5 space-y-4 max-h-[90vh] overflow-y-auto" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-start justify-between gap-4">
          <div className="min-w-0">
            <h2 className="text-lg font-semibold text-gray-900 dark:text-slate-100 flex items-center gap-2">
              Export & Import Stok
              <HelpTip term="btn.stockFile" />
            </h2>
            <p className="text-sm text-gray-500 dark:text-slate-400">
              Stock opname lewat Excel. Angka di Stok Baru menggantikan stok master.
            </p>
          </div>
          <button onClick={onClose} disabled={busy} className="text-gray-400 hover:text-gray-600" aria-label="Tutup">
            <X className="w-5 h-5" />
          </button>
        </div>

        {error && (
          <div className="rounded border border-red-200 dark:border-red-800 bg-red-50 dark:bg-red-900/20 px-3 py-2 text-sm text-red-800 dark:text-red-200">
            {error}
          </div>
        )}

        <input
          ref={fileRef}
          type="file"
          accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
          className="hidden"
          onChange={(e) => { const f = e.target.files?.[0]; if (f) upload(f) }}
        />

        {!preview && (
          <ol className="space-y-4 text-sm text-gray-700 dark:text-slate-300">
            <li className="space-y-2">
              <p>
                <span className="font-semibold">1. Export Stok.</span>{' '}
                {search ? <>Berisi master yang cocok dengan pencarian &ldquo;{search}&rdquo;.</> : 'Berisi semua master.'}
              </p>
              <button onClick={exportStock} disabled={busy} className="btn-secondary flex items-center gap-2">
                {downloading ? <Loader2 className="w-4 h-4 animate-spin" /> : <Download className="w-4 h-4" />}
                <span>Export Stok</span>
              </button>
            </li>
            <li>
              <p>
                <span className="font-semibold">2. Isi kolom Stok Baru</span> dengan angka hasil hitung gudang. Kosongkan SKU yang tidak dihitung.
                Tulis angka bulat tanpa titik: 1200, bukan 1.200.
              </p>
            </li>
            <li className="space-y-2">
              <p><span className="font-semibold">3. Import Stok.</span> Kamu akan melihat perubahannya dulu sebelum disimpan.</p>
              <button onClick={() => fileRef.current?.click()} disabled={busy} className="btn-primary flex items-center gap-2">
                {reading ? <Loader2 className="w-4 h-4 animate-spin" /> : <FileUp className="w-4 h-4" />}
                <span>{reading ? 'Membaca…' : 'Import Stok'}</span>
              </button>
            </li>
          </ol>
        )}

        {preview && counts && (
          <div className="space-y-3">
            <p className="text-sm font-medium text-gray-900 dark:text-slate-100">Pratinjau — {n(counts.rows)} baris dibaca</p>

            <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
              <Tile label="Akan diubah" value={counts.changes} />
              <Tile label="Sudah sama" value={counts.unchanged} note="dilewati" />
              <Tile label="Stok Baru kosong" value={counts.blank} note="dilewati" />
              <Tile label="Berubah sejak diunduh" value={counts.drifted} tone={counts.drifted > 0 ? 'warn' : 'default'} />
            </div>

            {counts.drifted > 0 && (
              <p className="text-xs text-amber-800 dark:text-amber-300">
                Ada pesanan masuk (atau perubahan lain) setelah file diunduh, jadi stok di OrderPro sudah tidak sama dengan
                kolom Stok Sekarang. Angkamu tetap akan menggantikannya. Pastikan hitunganmu sudah memperhitungkan pesanan itu.
              </p>
            )}

            {preview.errors.length > 0 && (
              <div className="rounded border border-red-200 dark:border-red-800 bg-red-50 dark:bg-red-900/20 px-3 py-2 text-xs text-red-800 dark:text-red-200 space-y-0.5">
                <p className="font-semibold text-sm">{n(counts.errors)} baris harus dibetulkan dulu</p>
                <div className="max-h-48 overflow-y-auto space-y-0.5">
                  {preview.errors.map((e, i) => <p key={i}><span className="font-mono">Baris {e.row}</span> — {e.message}</p>)}
                </div>
                {counts.errors > preview.errors.length && <p className="opacity-80">…dan {n(counts.errors - preview.errors.length)} lainnya.</p>}
              </div>
            )}

            {preview.changes.length > 0 && (
              <div className="overflow-x-auto max-h-80 overflow-y-auto rounded border border-gray-200 dark:border-slate-700">
                <table className="w-full min-w-[480px] text-sm">
                  <thead className="text-left text-xs uppercase text-gray-500 dark:text-slate-400 bg-gray-50 dark:bg-slate-800 sticky top-0">
                    <tr>
                      <th className="py-2 px-3">Master SKU</th>
                      <th className="py-2 px-3">Nama</th>
                      <th className="py-2 px-3 text-right">Lama</th>
                      <th className="py-2 px-3 text-right">Baru</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-gray-100 dark:divide-slate-700/60">
                    {preview.changes.map((c) => (
                      <tr key={c.productId}>
                        <td className="py-1.5 px-3 font-mono text-xs text-gray-900 dark:text-slate-100">{c.masterSku}</td>
                        <td className="py-1.5 px-3 text-gray-900 dark:text-slate-100">{c.name}</td>
                        <td className="py-1.5 px-3 text-right whitespace-nowrap text-gray-500 dark:text-slate-400">
                          {n(c.from)}
                          {c.drifted && (
                            <span className="flex items-center justify-end gap-1 text-xs text-amber-700 dark:text-amber-400" title="Stok di file saat diunduh">
                              <AlertTriangle className="w-3 h-3" /> di file {c.exported}
                            </span>
                          )}
                        </td>
                        <td className="py-1.5 px-3 text-right font-medium text-gray-900 dark:text-slate-100">{n(c.to)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                {counts.changes > preview.changes.length && (
                  <p className="px-3 py-2 text-xs text-gray-500 dark:text-slate-400">
                    Menampilkan {n(preview.changes.length)} dari {n(counts.changes)} perubahan. Semuanya ikut disimpan.
                  </p>
                )}
              </div>
            )}

            <div className="flex flex-wrap justify-end gap-2 pt-1">
              <button onClick={() => fileRef.current?.click()} disabled={busy} className="btn-secondary flex items-center gap-2">
                {reading ? <Loader2 className="w-4 h-4 animate-spin" /> : <FileUp className="w-4 h-4" />}
                <span>Unggah Ulang</span>
              </button>
              <button onClick={onClose} disabled={busy} className="btn-secondary">Batal</button>
              <button
                onClick={save}
                disabled={busy || !preview.ok || counts.changes === 0}
                className="btn-primary flex items-center gap-2"
                title={!preview.ok ? 'Betulkan baris yang salah di Excel, lalu unggah ulang' : undefined}
              >
                {saving && <Loader2 className="w-4 h-4 animate-spin" />}
                <span>Simpan {counts.changes > 0 && `${n(counts.changes)} perubahan`}</span>
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}

function Tile({ label, value, note, tone = 'default' }: { label: string; value: number; note?: string; tone?: 'default' | 'warn' }) {
  return (
    <div className={`rounded-lg border px-3 py-2 ${
      tone === 'warn'
        ? 'border-amber-300 dark:border-amber-800 bg-amber-50 dark:bg-amber-900/20'
        : 'border-gray-200 dark:border-slate-700'
    }`}>
      <p className="text-xs text-gray-500 dark:text-slate-400">{label}</p>
      <p className="text-lg font-semibold text-gray-900 dark:text-slate-100">{n(value)}</p>
      {note && <p className="text-xs text-gray-500 dark:text-slate-400">{note}</p>}
    </div>
  )
}
