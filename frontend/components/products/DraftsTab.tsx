'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import Link from 'next/link'
import api from '@/lib/api'
import Pagination from '@/components/Pagination'
import {
  DraftSummary, ValidationError, STATUS_CLASS, STATUS_LABEL, apiError, rupiah,
} from '@/lib/productDraft'
import { AlertTriangle, ChevronDown, ChevronUp, Copy, FileWarning, Loader2, MoreVertical, Pencil, Send, Trash2, X } from 'lucide-react'

interface Props {
  storeId: string
  search: string
  /** Called whenever the list changes, so the tab label can follow. */
  onChanged: () => void
}

const priceRange = (d: DraftSummary) =>
  d.priceMin === null ? '—'
    : d.priceMin === d.priceMax ? rupiah(d.priceMin)
      : `${rupiah(d.priceMin)} – ${rupiah(d.priceMax)}`

/**
 * The Draf tab of Produk: copies waiting to be published, as Komplace shows them.
 */
export default function DraftsTab({ storeId, search, onChanged }: Props) {
  const [drafts, setDrafts] = useState<DraftSummary[]>([])
  const [loading, setLoading] = useState(true)
  const [status, setStatus] = useState('OPEN')
  const [page, setPage] = useState(1)
  const [limit, setLimit] = useState(20)
  const [total, setTotal] = useState(0)
  const [totalPages, setTotalPages] = useState(1)

  const [expanded, setExpanded] = useState<string[]>([])
  const [menuFor, setMenuFor] = useState<string | null>(null)
  const [busyId, setBusyId] = useState<string | null>(null)
  const [message, setMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null)
  const [errorView, setErrorView] = useState<DraftSummary | null>(null)
  const [blocked, setBlocked] = useState<{ draft: DraftSummary; errors: ValidationError[] } | null>(null)
  const [copied, setCopied] = useState(false)

  const fetchDrafts = useCallback(async (quiet = false) => {
    if (!quiet) setLoading(true)
    try {
      const params: Record<string, string | number> = { page, limit, status }
      if (storeId) params.storeId = storeId
      if (search) params.search = search
      const res = await api.get<any>('/products/drafts', { params })
      setDrafts(res.data?.drafts ?? [])
      setTotal(res.data?.total ?? 0)
      setTotalPages(res.data?.totalPages ?? 1)
    } catch (err) {
      if (!quiet) setMessage({ type: 'error', text: apiError(err, 'Gagal memuat draf') })
    } finally {
      if (!quiet) setLoading(false)
    }
  }, [page, limit, status, storeId, search])

  useEffect(() => { fetchDrafts() }, [fetchDrafts])
  useEffect(() => { setPage(1) }, [limit, status, storeId, search])

  // Publishing answers before it finishes; keep the badges honest while any
  // draft on screen is still going.
  const publishing = drafts.some((d) => d.status === 'PUBLISHING')
  const wasPublishing = useRef(false)
  useEffect(() => {
    if (!publishing) {
      if (wasPublishing.current) onChanged()
      wasPublishing.current = false
      return
    }
    wasPublishing.current = true
    const t = setInterval(() => fetchDrafts(true), 4000)
    return () => clearInterval(t)
  }, [publishing, fetchDrafts, onChanged])

  useEffect(() => {
    if (!menuFor) return
    const close = () => setMenuFor(null)
    window.addEventListener('click', close)
    return () => window.removeEventListener('click', close)
  }, [menuFor])

  const toggleExpand = (id: string) =>
    setExpanded((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]))

  const handlePublish = async (d: DraftSummary) => {
    setBusyId(d.id)
    setMessage(null)
    try {
      await api.post(`/products/drafts/${d.id}/publish`)
      setMessage({ type: 'success', text: `"${d.name}" sedang dipublish ke ${d.targetStore.name}.` })
      await fetchDrafts(true)
    } catch (err: any) {
      const errors: ValidationError[] | undefined = err?.response?.data?.errors
      if (errors?.length) setBlocked({ draft: d, errors })
      else setMessage({ type: 'error', text: apiError(err, 'Gagal memulai Publish') })
    } finally {
      setBusyId(null)
    }
  }

  const handleDelete = async (d: DraftSummary) => {
    const leftBehind = d.publishedItemId && d.status !== 'PUBLISHED'
      ? `\n\nProduk ini sudah sempat dibuat di Shopee (item ${d.publishedItemId}, belum tayang) dan TIDAK ikut terhapus — hapus manual di Seller Centre kalau tidak dipakai.`
      : ''
    const what = d.status === 'PUBLISHED' ? 'Hapus catatan draf ini? Produk yang sudah tayang di Shopee tidak terpengaruh.' : `Hapus draf "${d.name}"?`
    if (!window.confirm(what + leftBehind)) return
    setBusyId(d.id)
    try {
      await api.delete(`/products/drafts/${d.id}`)
      setMessage({ type: 'success', text: 'Draf dihapus.' })
      await fetchDrafts(true)
      onChanged()
    } catch (err) {
      setMessage({ type: 'error', text: apiError(err, 'Gagal menghapus draf') })
    } finally {
      setBusyId(null)
    }
  }

  const copyError = async (d: DraftSummary) => {
    const text = [
      `Draf ${d.id} — ${d.name}`,
      `Toko tujuan: ${d.targetStore.name}`,
      `Error: ${d.lastError}`,
      d.lastErrorRaw ? JSON.stringify(d.lastErrorRaw, null, 2) : '',
    ].join('\n')
    try {
      await navigator.clipboard.writeText(text)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    } catch {
      window.prompt('Salin teks ini:', text)
    }
  }

  return (
    <div className="space-y-3">
      {message && (
        <div className={`rounded-lg border px-4 py-3 text-sm ${
          message.type === 'success'
            ? 'border-blue-200 dark:border-blue-800 bg-blue-50 dark:bg-blue-900/20 text-blue-800 dark:text-blue-200'
            : 'border-red-200 dark:border-red-800 bg-red-50 dark:bg-red-900/20 text-red-800 dark:text-red-200'
        }`}>
          {message.text}
        </div>
      )}

      <div className="flex flex-wrap items-center gap-2">
        <select value={status} onChange={(e) => setStatus(e.target.value)} className="input w-auto">
          <option value="OPEN">Belum terbit</option>
          <option value="DRAFT">Draf</option>
          <option value="PUBLISHING">Sedang Publish</option>
          <option value="FAILED">Gagal</option>
          <option value="PUBLISHED">Terbit</option>
          <option value="">Semua</option>
        </select>
        <p className="text-xs text-gray-500 dark:text-slate-400">
          Filter toko di atas berlaku untuk <span className="font-medium">toko tujuan</span>.
        </p>
      </div>

      <div className="card overflow-hidden">
        <Pagination
          page={page}
          totalPages={totalPages}
          total={total}
          limit={limit}
          loading={loading}
          unit="draf"
          onPageChange={setPage}
          onLimitChange={(n) => { setLimit(n); setPage(1) }}
        />

        {loading ? (
          <p className="px-4 py-8 text-center text-sm text-gray-500 dark:text-slate-400">Memuat…</p>
        ) : drafts.length === 0 ? (
          <div className="px-4 py-10 text-center space-y-1">
            <p className="font-medium text-gray-900 dark:text-slate-100">Belum ada draf</p>
            <p className="text-sm text-gray-500 dark:text-slate-400">
              Di tab Aktif, centang varian dari satu produk lalu tekan &ldquo;Salin Produk&rdquo;.
            </p>
          </div>
        ) : (
          <div className="divide-y divide-gray-200 dark:divide-slate-700">
            {drafts.map((d) => {
              const open = expanded.includes(d.id)
              const canEdit = d.status === 'DRAFT' || d.status === 'FAILED'
              return (
                <div key={d.id} className="px-4 py-3 space-y-2">
                  <div className="flex items-start gap-3">
                    {d.imageUrl
                      // eslint-disable-next-line @next/next/no-img-element
                      ? <img src={d.imageUrl} alt="" className="w-12 h-12 rounded object-cover shrink-0" />
                      : <div className="w-12 h-12 rounded bg-gray-100 dark:bg-slate-700 shrink-0" />}

                    <div className="flex-1 min-w-0">
                      <p className="text-sm text-gray-900 dark:text-slate-100 break-words">{d.name}</p>
                      <div className="flex flex-wrap items-center gap-x-2 gap-y-1 mt-1 text-xs">
                        <span className="px-1.5 py-0.5 rounded bg-orange-100 text-orange-800 dark:bg-orange-950/50 dark:text-orange-300">
                          {d.targetStore.name}
                        </span>
                        <span className="text-gray-500 dark:text-slate-400">SKU: {d.itemSku || '—'}</span>
                        <span className="text-gray-500 dark:text-slate-400">dari {d.sourceStore.name}</span>
                        <span className="sm:hidden text-gray-700 dark:text-slate-300">
                          {priceRange(d)} · stok {d.stockTotal.toLocaleString('id-ID')}
                        </span>
                        <span className={`px-1.5 py-0.5 rounded font-medium ${STATUS_CLASS[d.status]}`}>
                          {d.status === 'PUBLISHING' && <Loader2 className="w-3 h-3 inline animate-spin mr-1" />}
                          {STATUS_LABEL[d.status]}
                        </span>
                      </div>
                    </div>

                    <div className="hidden sm:block w-28 text-xs text-gray-500 dark:text-slate-400 shrink-0">
                      <p>Master SKU</p>
                      <p className="text-gray-900 dark:text-slate-100">{d.status === 'PUBLISHED' ? 'terikat otomatis' : '—'}</p>
                    </div>
                    <div className="hidden sm:block w-36 text-right text-sm text-gray-900 dark:text-slate-100 shrink-0">{priceRange(d)}</div>
                    <div className="hidden sm:block w-16 text-right text-sm text-gray-900 dark:text-slate-100 shrink-0">{d.stockTotal.toLocaleString('id-ID')}</div>

                    <div className="relative shrink-0">
                      <button
                        onClick={(e) => { e.stopPropagation(); setMenuFor(menuFor === d.id ? null : d.id) }}
                        disabled={busyId === d.id}
                        className="btn-secondary px-2 py-1 text-xs flex items-center gap-1"
                        aria-label="Atur"
                      >
                        {busyId === d.id ? <Loader2 className="w-3 h-3 animate-spin" /> : <MoreVertical className="w-3 h-3" />}
                        Atur
                      </button>
                      {menuFor === d.id && (
                        <div
                          className="absolute right-0 mt-1 w-44 z-20 card py-1 shadow-lg"
                          onClick={(e) => e.stopPropagation()}
                        >
                          <button
                            onClick={() => { setMenuFor(null); handlePublish(d) }}
                            disabled={!canEdit}
                            className="w-full text-left px-3 py-2 text-sm flex items-center gap-2 hover:bg-gray-50 dark:hover:bg-slate-700 disabled:opacity-40"
                          >
                            <Send className="w-4 h-4" /> Publish Produk
                          </button>
                          <Link
                            href={`/products/drafts/edit?id=${d.id}`}
                            className="w-full text-left px-3 py-2 text-sm flex items-center gap-2 hover:bg-gray-50 dark:hover:bg-slate-700"
                          >
                            <Pencil className="w-4 h-4" /> {canEdit ? 'Edit Produk' : 'Lihat Produk'}
                          </Link>
                          <button
                            onClick={() => { setMenuFor(null); handleDelete(d) }}
                            disabled={d.status === 'PUBLISHING'}
                            className="w-full text-left px-3 py-2 text-sm flex items-center gap-2 text-red-600 dark:text-red-400 hover:bg-gray-50 dark:hover:bg-slate-700 disabled:opacity-40"
                          >
                            <Trash2 className="w-4 h-4" /> Hapus Draf
                          </button>
                        </div>
                      )}
                    </div>
                  </div>

                  {d.variants.length > 0 && (
                    <div className="sm:ml-[3.75rem]">
                      <button
                        onClick={() => toggleExpand(d.id)}
                        className="w-full flex items-center justify-between rounded bg-gray-50 dark:bg-slate-800/60 px-3 py-1.5 text-xs text-gray-600 dark:text-slate-300"
                      >
                        <span>Lihat Varian Produk ({d.variants.length})</span>
                        {open ? <ChevronUp className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
                      </button>
                      {open && (
                        <div className="overflow-x-auto">
                          <table className="w-full text-xs mt-1">
                            <tbody className="divide-y divide-gray-100 dark:divide-slate-700/60">
                              {d.variants.map((v, i) => (
                                <tr key={i}>
                                  <td className="py-1.5 pr-3 text-gray-900 dark:text-slate-100">{v.name}</td>
                                  <td className="py-1.5 pr-3 font-mono text-gray-500 dark:text-slate-400">{v.sku || '—'}</td>
                                  <td className="py-1.5 pr-3 text-right text-gray-900 dark:text-slate-100">{rupiah(v.price)}</td>
                                  <td className="py-1.5 text-right text-gray-900 dark:text-slate-100">{v.stock ?? '—'}</td>
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        </div>
                      )}
                    </div>
                  )}

                  {d.lastError && (
                    <div className={`rounded px-3 py-2 text-xs flex items-start gap-2 ${
                      d.status === 'PUBLISHED'
                        ? 'bg-amber-50 dark:bg-amber-900/20 text-amber-900 dark:text-amber-200'
                        : 'bg-red-50 dark:bg-red-900/20 text-red-800 dark:text-red-200'
                    }`}>
                      <AlertTriangle className="w-4 h-4 shrink-0" />
                      <p className="flex-1 break-words [overflow-wrap:anywhere]">
                        {d.status === 'PUBLISHED' ? '' : 'Produk tidak diterbitkan: '}{d.lastError}
                      </p>
                      <button onClick={() => setErrorView(d)} className="underline shrink-0">Lihat Error</button>
                    </div>
                  )}
                </div>
              )
            })}
          </div>
        )}
      </div>

      {errorView && (
        <div className="fixed inset-0 z-[70] flex items-center justify-center bg-black/40 p-4" onClick={() => setErrorView(null)}>
          <div className="card w-full max-w-2xl p-5 space-y-3 max-h-[85vh] overflow-y-auto" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-start justify-between gap-4">
              <h2 className="text-lg font-semibold text-gray-900 dark:text-slate-100 flex items-center gap-2">
                <FileWarning className="w-5 h-5 text-red-600" /> Detail Error
              </h2>
              <button onClick={() => setErrorView(null)} className="text-gray-400 hover:text-gray-600"><X className="w-5 h-5" /></button>
            </div>
            <p className="text-sm text-gray-900 dark:text-slate-100 break-words">{errorView.lastError}</p>
            {errorView.publishedItemId && errorView.status !== 'PUBLISHED' && (
              <p className="text-xs text-amber-800 dark:text-amber-300">
                Produk sudah terbuat di Shopee (item {errorView.publishedItemId}, belum tayang). Publish ulang akan melanjutkan produk itu, bukan membuat baru.
              </p>
            )}
            {errorView.lastErrorRaw && (
              <pre className="text-xs bg-gray-50 dark:bg-slate-900 rounded p-3 overflow-x-auto text-gray-800 dark:text-slate-200">
                {JSON.stringify(errorView.lastErrorRaw, null, 2)}
              </pre>
            )}
            <div className="flex justify-end gap-2">
              <button onClick={() => copyError(errorView)} className="btn-secondary flex items-center gap-2">
                <Copy className="w-4 h-4" /> {copied ? 'Tersalin' : 'Salin untuk developer'}
              </button>
              <button onClick={() => setErrorView(null)} className="btn-primary">Tutup</button>
            </div>
          </div>
        </div>
      )}

      {blocked && (
        <div className="fixed inset-0 z-[70] flex items-center justify-center bg-black/40 p-4" onClick={() => setBlocked(null)}>
          <div className="card w-full max-w-lg p-5 space-y-3 max-h-[85vh] overflow-y-auto" onClick={(e) => e.stopPropagation()}>
            <h2 className="text-lg font-semibold text-gray-900 dark:text-slate-100">Belum bisa Publish</h2>
            <p className="text-sm text-gray-600 dark:text-slate-300">Perbaiki dulu di Edit Produk:</p>
            <ul className="list-disc pl-5 space-y-1 text-sm text-red-700 dark:text-red-300">
              {blocked.errors.map((e, i) => <li key={i}>{e.message}</li>)}
            </ul>
            <div className="flex justify-end gap-2">
              <button onClick={() => setBlocked(null)} className="btn-secondary">Tutup</button>
              <Link href={`/products/drafts/edit?id=${blocked.draft.id}`} className="btn-primary">Edit Produk</Link>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
