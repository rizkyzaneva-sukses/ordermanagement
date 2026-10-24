'use client'

import { useRef, useState, type RefObject } from 'react'
import api from '@/lib/api'
import { apiError } from '@/lib/productDraft'
import { downloadFile, readFileError } from '@/lib/download'
import HelpTip from '@/components/HelpTip'
import { AlertTriangle, Download, FileUp, Loader2, X } from 'lucide-react'

interface StoreOption {
  id: string
  name: string
}

interface RowIssue {
  row: number
  message: string
  code?: string
}

interface PlannedCreate {
  parent: string
  masterSku: string
  variantName: string | null
  stock: number
  typed: boolean
  spread: { min: number; max: number } | null
  listings: number
  stores: number
  rows: number[]
}

interface Preview {
  ok: boolean
  counts: {
    rows: number
    parents: number
    creates: number
    createdListings: number
    binds: number
    skipped: number
    unreadStock: number
    spread: number
    push: number
    errors: number
    warnings: number
  }
  errors: RowIssue[]
  warnings: RowIssue[]
  sharedConflicts: number
  skippedReasons: Record<string, number>
  creates: PlannedCreate[]
}

interface ImportResult {
  parents: number
  masters: number
  bound: number
  skipped: number
  unreadStock: number
  failures: { name: string; reason: string; rows: number[] }[]
  push: { masters: number; mode: 'none' | 'queue' | 'inline' }
}

interface Props {
  stores: StoreOption[]
  /** The shop the Produk page is filtered to, if any — the template starts there. */
  defaultStoreId: string
  onClose: () => void
  /** Masters were made; the page should reload and say so. */
  onDone: (text: string) => void
}

const n = (v: number) => v.toLocaleString('id-ID')

/** "baris 4, 7, 9 dan 3 lainnya" — enough to find them in Excel, not a wall. */
const rowList = (rows: number[]) =>
  rows.length <= 4 ? rows.join(', ') : `${rows.slice(0, 3).join(', ')} dan ${rows.length - 3} lainnya`

/**
 * Import Master: download the template, fix it up in Excel, upload, read the
 * preview, save. PRD-import-xlsx.md.
 */
export default function ImportMasterModal({ stores, defaultStoreId, onClose, onDone }: Props) {
  const [storeId, setStoreId] = useState(defaultStoreId)
  const [downloading, setDownloading] = useState(false)
  const [reading, setReading] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [rows, setRows] = useState<unknown[] | null>(null)
  const [preview, setPreview] = useState<Preview | null>(null)
  const [shareSku, setShareSku] = useState(false)
  const [result, setResult] = useState<ImportResult | null>(null)
  const fileRef = useRef<HTMLInputElement>(null)

  const busy = downloading || reading || saving

  const downloadTemplate = async () => {
    setDownloading(true)
    setError(null)
    try {
      await downloadFile('/products/masters/import-template', storeId ? { storeId } : {}, 'template-master.xlsx')
    } catch (err) {
      setError(await readFileError(err, 'Gagal mengunduh template'))
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
      form.append('shareSku', String(shareSku))
      const res = await api.post<any>('/products/masters/import/preview', form, {
        headers: { 'Content-Type': 'multipart/form-data' },
        timeout: 300_000,
      })
      setRows(res.data.rows)
      setPreview(res.data as Preview)
    } catch (err) {
      setError(apiError(err, 'Gagal membaca file'))
    } finally {
      setReading(false)
      if (fileRef.current) fileRef.current.value = ''
    }
  }

  /** Re-plan the rows already read, with "Stok dipakai bersama" flipped. */
  const toggleShare = async (next: boolean) => {
    if (!rows) return
    setShareSku(next)
    setReading(true)
    setError(null)
    try {
      const res = await api.post<any>('/products/masters/import/preview', { rows, shareSku: next }, { timeout: 300_000 })
      setPreview(res.data as Preview)
    } catch (err) {
      setShareSku(!next)
      setError(apiError(err, 'Gagal memperbarui pratinjau'))
    } finally {
      setReading(false)
    }
  }

  const save = async () => {
    if (!rows) return
    setSaving(true)
    setError(null)
    try {
      const res = await api.post<any>('/products/masters/import', { rows, shareSku }, { timeout: 300_000 })
      setResult(res.data as ImportResult)
    } catch (err: any) {
      // 409: something changed since the preview; show the fresh one.
      const fresh = err?.response?.data?.data
      if (fresh?.counts) setPreview(fresh as Preview)
      setError(apiError(err, 'Gagal mengimpor master'))
    } finally {
      setSaving(false)
    }
  }

  const finish = () => {
    if (!result) return onClose()
    const parts = [`${n(result.masters)} master dibuat dalam ${n(result.parents)} produk`]
    if (result.bound > 0) parts.push(`${n(result.bound)} listing digabung ke master yang sudah ada`)
    if (result.failures.length > 0) parts.push(`${result.failures.length} produk gagal`)
    if (result.push.masters > 0) parts.push(`stok ${n(result.push.masters)} master sedang dikirim ke Shopee`)
    onDone(`Import Master: ${parts.join(', ')}.`)
  }

  const nothingToDo = preview !== null && preview.counts.creates + preview.counts.binds === 0

  return (
    <div className="fixed inset-0 z-[70] flex items-center justify-center bg-black/40 p-4" onClick={busy ? undefined : (result ? finish : onClose)}>
      <div className="card w-full max-w-3xl p-5 space-y-4 max-h-[90vh] overflow-y-auto" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-start justify-between gap-4">
          <div className="min-w-0">
            <h2 className="text-lg font-semibold text-gray-900 dark:text-slate-100 flex items-center gap-2">
              Import Master
              <HelpTip term="btn.importMaster" />
            </h2>
            <p className="text-sm text-gray-500 dark:text-slate-400">
              Buat banyak master sekaligus dari file Excel.
            </p>
          </div>
          <button onClick={result ? finish : onClose} disabled={busy} className="text-gray-400 hover:text-gray-600" aria-label="Tutup">
            <X className="w-5 h-5" />
          </button>
        </div>

        {error && (
          <div className="rounded border border-red-200 dark:border-red-800 bg-red-50 dark:bg-red-900/20 px-3 py-2 text-sm text-red-800 dark:text-red-200">
            {error}
          </div>
        )}

        {result ? (
          <ResultView result={result} onClose={finish} />
        ) : (
          <>
            {!preview && (
              <ol className="space-y-4 text-sm text-gray-700 dark:text-slate-300">
                <li className="space-y-2">
                  <p><span className="font-semibold">1. Unduh template.</span> Isinya semua listing yang belum punya master, satu baris per varian.</p>
                  <div className="flex flex-wrap items-center gap-2">
                    <select value={storeId} onChange={(e) => setStoreId(e.target.value)} disabled={busy} className="input w-auto">
                      <option value="">Semua toko</option>
                      {stores.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
                    </select>
                    <button onClick={downloadTemplate} disabled={busy} className="btn-secondary flex items-center gap-2">
                      {downloading ? <Loader2 className="w-4 h-4 animate-spin" /> : <Download className="w-4 h-4" />}
                      <span>Unduh Template</span>
                    </button>
                  </div>
                </li>
                <li>
                  <p className="flex items-center gap-1 flex-wrap">
                    <span className="font-semibold">2. Rapikan di Excel.</span>{' '}
                    Ubah kolom kuning saja: Master SKU, Nama Master Produk, Stok Awal. Kosongkan Master SKU untuk melewati baris.
                    <HelpTip term="import.template" />
                  </p>
                </li>
                <li className="space-y-2">
                  <p><span className="font-semibold">3. Unggah file.</span> Kamu akan melihat pratinjau dulu. Belum ada yang tersimpan sebelum kamu menekan Simpan.</p>
                  <UploadButton fileRef={fileRef} reading={reading} disabled={busy} onFile={upload} label="Unggah File" />
                </li>
              </ol>
            )}

            {preview && (
              <PreviewView
                preview={preview}
                shareSku={shareSku}
                busy={busy}
                onToggleShare={toggleShare}
              />
            )}

            {preview && (
              <div className="flex flex-wrap justify-end gap-2 pt-1">
                <UploadButton fileRef={fileRef} reading={reading} disabled={busy} onFile={upload} label="Unggah Ulang" secondary />
                <button onClick={onClose} disabled={busy} className="btn-secondary">Batal</button>
                <button
                  onClick={save}
                  disabled={busy || !preview.ok || nothingToDo}
                  className="btn-primary flex items-center gap-2"
                  title={!preview.ok ? 'Betulkan baris yang salah di Excel, lalu unggah ulang' : undefined}
                >
                  {saving && <Loader2 className="w-4 h-4 animate-spin" />}
                  <span>Simpan</span>
                </button>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  )
}

function UploadButton({ fileRef, reading, disabled, onFile, label, secondary }: {
  fileRef: RefObject<HTMLInputElement>
  reading: boolean
  disabled: boolean
  onFile: (file: File) => void
  label: string
  secondary?: boolean
}) {
  return (
    <>
      <input
        ref={fileRef}
        type="file"
        accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
        className="hidden"
        onChange={(e) => { const f = e.target.files?.[0]; if (f) onFile(f) }}
      />
      <button
        onClick={() => fileRef.current?.click()}
        disabled={disabled}
        className={`${secondary ? 'btn-secondary' : 'btn-primary'} flex items-center gap-2`}
      >
        {reading ? <Loader2 className="w-4 h-4 animate-spin" /> : <FileUp className="w-4 h-4" />}
        <span>{reading ? 'Membaca…' : label}</span>
      </button>
    </>
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

function IssueList({ title, issues, total, tone }: { title: string; issues: RowIssue[]; total: number; tone: 'error' | 'warn' }) {
  if (issues.length === 0) return null
  return (
    <div className={`rounded border px-3 py-2 text-xs space-y-0.5 ${
      tone === 'error'
        ? 'border-red-200 dark:border-red-800 bg-red-50 dark:bg-red-900/20 text-red-800 dark:text-red-200'
        : 'border-amber-200 dark:border-amber-800 bg-amber-50 dark:bg-amber-900/20 text-amber-900 dark:text-amber-200'
    }`}>
      <p className="font-semibold text-sm">{title}</p>
      <div className="max-h-48 overflow-y-auto space-y-0.5">
        {issues.map((e, i) => <p key={i}><span className="font-mono">Baris {e.row}</span> — {e.message}</p>)}
      </div>
      {total > issues.length && <p className="opacity-80">…dan {n(total - issues.length)} lainnya.</p>}
    </div>
  )
}

function PreviewView({ preview, shareSku, busy, onToggleShare }: {
  preview: Preview
  shareSku: boolean
  busy: boolean
  onToggleShare: (next: boolean) => void
}) {
  const { counts } = preview
  const skippedText = Object.entries(preview.skippedReasons).map(([reason, count]) => `${n(count)} ${reason.toLowerCase()}`).join(', ')

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-1 text-sm font-medium text-gray-900 dark:text-slate-100">
        Pratinjau — {n(counts.rows)} baris dibaca
        <HelpTip term="import.preview" />
      </div>

      <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
        <Tile label="Master baru" value={counts.creates} note={`dalam ${n(counts.parents)} produk induk`} />
        <Tile label="Digabung ke master lama" value={counts.binds} note="stoknya tidak diubah" />
        <Tile label="Dilewati" value={counts.skipped} />
        <Tile label="Dikirim ke Shopee" value={counts.push} note="setelah disimpan" />
      </div>

      {(counts.spread > 0 || counts.unreadStock > 0 || skippedText) && (
        <ul className="text-xs text-gray-600 dark:text-slate-400 space-y-0.5">
          {counts.spread > 0 && <li>• {n(counts.spread)} Master SKU stoknya beda antartoko — dipakai yang paling kecil (lihat tabel).</li>}
          {counts.unreadStock > 0 && <li>• {n(counts.unreadStock)} Master SKU stoknya tidak terbaca dari Shopee dan akan diisi 0. Cek di Daftar Stok setelahnya.</li>}
          {skippedText && <li>• Dilewati: {skippedText}.</li>}
        </ul>
      )}

      {(preview.sharedConflicts > 0 || shareSku) && (
        <div className="rounded-lg border border-amber-300 dark:border-amber-800 bg-amber-50 dark:bg-amber-900/20 px-3 py-2.5 text-xs text-amber-900 dark:text-amber-200 space-y-2">
          {preview.sharedConflicts > 0 && (
            <p><span className="font-semibold">{n(preview.sharedConflicts)} Master SKU dipakai lebih dari satu varian di produk yang sama.</span></p>
          )}
          <label className="flex items-start gap-2 cursor-pointer">
            <input
              type="checkbox"
              checked={shareSku}
              onChange={(e) => onToggleShare(e.target.checked)}
              disabled={busy}
              className="mt-0.5 rounded border-gray-300 dark:border-slate-600"
            />
            <span>
              <span className="font-semibold">Stok dipakai bersama.</span>{' '}
              Varian dengan SKU sama diikat ke satu master dan berbagi satu angka stok. Pakai ini kalau memang barangnya sama,
              misalnya jaket dan paket jaket + jogger. Kalau SKU kembar itu kesalahan, betulkan di Excel.
            </span>
            <HelpTip term="masterForm.shared" />
          </label>
        </div>
      )}

      <IssueList title={`${n(counts.errors)} baris harus dibetulkan dulu`} issues={preview.errors} total={counts.errors} tone="error" />
      <IssueList title={`${n(counts.warnings)} catatan`} issues={preview.warnings} total={counts.warnings} tone="warn" />

      {preview.creates.length > 0 && (
        <div className="overflow-x-auto max-h-80 overflow-y-auto rounded border border-gray-200 dark:border-slate-700">
          <table className="w-full min-w-[560px] text-sm">
            <thead className="text-left text-xs uppercase text-gray-500 dark:text-slate-400 bg-gray-50 dark:bg-slate-800 sticky top-0">
              <tr>
                <th className="py-2 px-3">Master SKU</th>
                <th className="py-2 px-3">Produk / Varian</th>
                <th className="py-2 px-3">Listing</th>
                <th className="py-2 px-3 text-right">Stok Awal</th>
                <th className="py-2 px-3">Baris</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100 dark:divide-slate-700/60">
              {preview.creates.map((c) => (
                <tr key={c.masterSku}>
                  <td className="py-1.5 px-3 font-mono text-xs text-gray-900 dark:text-slate-100">{c.masterSku}</td>
                  <td className="py-1.5 px-3 text-gray-900 dark:text-slate-100">
                    {c.parent}{c.variantName && <span className="text-gray-500 dark:text-slate-400"> — {c.variantName}</span>}
                  </td>
                  <td className="py-1.5 px-3 text-xs text-gray-600 dark:text-slate-300 whitespace-nowrap">
                    {c.listings} listing{c.stores > 1 && `, ${c.stores} toko`}
                  </td>
                  <td className="py-1.5 px-3 text-right whitespace-nowrap">
                    <span className="text-gray-900 dark:text-slate-100">{n(c.stock)}</span>
                    {c.typed && <span className="block text-xs text-gray-500 dark:text-slate-400">diisi di file</span>}
                    {!c.typed && c.spread && (
                      <span className="flex items-center justify-end gap-1 text-xs text-amber-700 dark:text-amber-400" title="Stok di toko-toko berbeda; dipakai yang paling kecil">
                        <AlertTriangle className="w-3 h-3" /> {c.spread.min}–{c.spread.max}
                      </span>
                    )}
                  </td>
                  <td className="py-1.5 px-3 text-xs text-gray-500 dark:text-slate-400 whitespace-nowrap">{rowList(c.rows)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {counts.creates > preview.creates.length && (
            <p className="px-3 py-2 text-xs text-gray-500 dark:text-slate-400">
              Menampilkan {n(preview.creates.length)} dari {n(counts.creates)} master baru. Semuanya ikut disimpan.
            </p>
          )}
        </div>
      )}
    </div>
  )
}

function ResultView({ result, onClose }: { result: ImportResult; onClose: () => void }) {
  return (
    <div className="space-y-3 text-sm text-gray-700 dark:text-slate-300">
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
        <Tile label="Master dibuat" value={result.masters} note={`dalam ${n(result.parents)} produk`} />
        <Tile label="Digabung ke master lama" value={result.bound} />
        <Tile label="Dilewati" value={result.skipped} />
        <Tile label="Gagal" value={result.failures.length} tone={result.failures.length > 0 ? 'warn' : 'default'} />
      </div>
      {result.push.masters > 0 && (
        <p>
          Stok {n(result.push.masters)} master sedang dikirim ke Shopee di latar belakang. Hasilnya terlihat di kolom
          &ldquo;Di Shopee&rdquo; di Daftar Stok dalam beberapa menit.
        </p>
      )}
      {result.unreadStock > 0 && (
        <p className="text-amber-700 dark:text-amber-400">
          {n(result.unreadStock)} master stoknya tidak terbaca dari Shopee dan diisi 0. Perbaiki lewat Daftar Stok.
        </p>
      )}
      {result.failures.length > 0 && (
        <div className="rounded border border-red-200 dark:border-red-800 bg-red-50 dark:bg-red-900/20 px-3 py-2 text-xs text-red-800 dark:text-red-200 space-y-0.5">
          <p className="font-semibold text-sm">Produk yang gagal (yang lain tetap tersimpan):</p>
          {result.failures.map((f, i) => (
            <p key={i}>{f.name} — {f.reason} <span className="opacity-80">(baris {rowList(f.rows)})</span></p>
          ))}
          <p className="opacity-80">Unduh template lagi untuk mencobanya ulang. Yang sudah berhasil tidak muncul lagi di sana.</p>
        </div>
      )}
      <div className="flex justify-end">
        <button onClick={onClose} className="btn-primary">Selesai</button>
      </div>
    </div>
  )
}
