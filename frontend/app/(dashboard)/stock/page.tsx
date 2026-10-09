'use client'

import { useCallback, useEffect, useState } from 'react'
import Link from 'next/link'
import api from '@/lib/api'
import { getMe } from '@/lib/auth'
import Pagination from '@/components/Pagination'
import {
  Boxes,
  Search,
  Loader2,
  Check,
  X,
  Pencil,
  AlertTriangle,
  Trash2,
} from 'lucide-react'

interface Master {
  id: string
  masterSku: string
  name: string
  stock: number
  isActive: boolean
  _count?: { listings: number }
  // What the bound listings hold on Shopee, as of the last refresh or push.
  listingStock?: { min: number; max: number } | null
}

interface PushFailure {
  store: string
  name: string
  reason: string
}

interface PushResult {
  listings: number
  pushed: number
  failed: PushFailure[]
  skipped: PushFailure[]
  error?: string
}

type Message = { type: 'success' | 'error'; text: string; details?: string[] }

/** Masters per request, so a 500-row page does not outrun the 90s request timeout. */
const BULK_CHUNK = 50

/** True when every bound listing already holds the master's number. */
const inSync = (m: Master) =>
  !m.listingStock || (m.listingStock.min === m.stock && m.listingStock.max === m.stock)

/** "17", or "17–42" when the shops disagree. */
const formatRange = (r: { min: number; max: number }) => (r.min === r.max ? `${r.min}` : `${r.min}–${r.max}`)

/** Merge the push results of several chunked requests into one. */
function mergePush(results: PushResult[]): PushResult {
  const out: PushResult = { listings: 0, pushed: 0, failed: [], skipped: [] }
  for (const r of results) {
    out.listings += r.listings
    out.pushed += r.pushed
    out.failed.push(...r.failed)
    out.skipped.push(...r.skipped)
    if (r.error) out.error = r.error
  }
  return out
}

/**
 * Turn a save + push outcome into the banner above the table. The save itself
 * already succeeded when this runs; what is left to say is whether Shopee took it.
 */
function describePush(saved: string, push: PushResult | null | undefined): Message {
  if (!push || push.listings === 0) {
    return { type: 'success', text: `${saved}. Belum terikat ke listing Shopee, jadi tidak ada yang dikirim.` }
  }
  if (push.error) {
    return { type: 'error', text: `${saved}. ${push.error} — simpan lagi untuk mencoba ulang.` }
  }

  const details = [
    ...push.failed.map((f) => `Gagal — ${f.store}: ${f.name} (${f.reason})`),
    ...push.skipped.map((f) => `Dilewati — ${f.store}: ${f.name} (${f.reason})`),
  ]
  const shown = details.slice(0, 10)
  if (details.length > shown.length) shown.push(`…dan ${details.length - shown.length} lainnya`)

  if (push.failed.length > 0) {
    return {
      type: 'error',
      text: `${saved}. Terkirim ke ${push.pushed} listing Shopee, ${push.failed.length} gagal — simpan lagi untuk mencoba ulang, atau ubah langsung di Seller Centre.`,
      details: shown,
    }
  }
  return {
    type: 'success',
    text: `${saved} dan terkirim ke ${push.pushed} listing Shopee.` +
      (push.skipped.length > 0 ? ` ${push.skipped.length} listing dilewati.` : ''),
    details: push.skipped.length > 0 ? shown : undefined,
  }
}

type BulkMode = 'set' | 'add' | 'subtract'

const modeLabels: Record<BulkMode, string> = {
  set: 'Ganti jadi',
  add: 'Tambah',
  subtract: 'Kurangi',
}

export default function StockPage() {
  const [masters, setMasters] = useState<Master[]>([])
  const [loading, setLoading] = useState(true)
  const [message, setMessage] = useState<Message | null>(null)

  const [page, setPage] = useState(1)
  const [limit, setLimit] = useState(20)
  const [totalPages, setTotalPages] = useState(1)
  const [total, setTotal] = useState(0)
  const [search, setSearch] = useState('')
  const [searchInput, setSearchInput] = useState('')

  const [selected, setSelected] = useState<string[]>([])
  const [busy, setBusy] = useState(false)

  // Which row is being edited inline, and the value being typed into it. Held as
  // a string so a half-typed field (empty, or just "-") does not become 0 and
  // write itself to the database on the next render.
  const [editingId, setEditingId] = useState<string | null>(null)
  const [editValue, setEditValue] = useState('')

  // The bulk dialog lists every ticked master with its own "Stok baru" field,
  // keyed by master id. Blank means "leave this one alone". The mode + value
  // pair above the list only fills those fields; nothing is saved until Simpan.
  const [bulkOpen, setBulkOpen] = useState(false)
  const [bulkValues, setBulkValues] = useState<Record<string, string>>({})
  const [bulkMode, setBulkMode] = useState<BulkMode>('set')
  const [bulkValue, setBulkValue] = useState('')
  const [bulkFloored, setBulkFloored] = useState(0)
  // "50/120" while chunked requests are going out.
  const [bulkProgress, setBulkProgress] = useState<string | null>(null)

  // Deleting a master is admin-only on the server; the button follows suit so
  // staff are not offered an action that can only answer "forbidden".
  const [isAdmin, setIsAdmin] = useState(false)
  const [deleteOpen, setDeleteOpen] = useState(false)

  useEffect(() => {
    getMe().then((u) => setIsAdmin(u?.role === 'ADMIN')).catch(() => setIsAdmin(false))
  }, [])

  const fetchMasters = useCallback(async () => {
    setLoading(true)
    try {
      const params: Record<string, string | number> = { page, limit }
      if (search) params.search = search

      const res = await api.get<any>('/products/masters', { params })
      setMasters(res.data?.masters ?? [])
      setTotalPages(res.data?.totalPages ?? 1)
      setTotal(res.data?.total ?? 0)
    } catch (err: any) {
      setMasters([])
      setMessage({
        type: 'error',
        text: err?.response?.data?.error || 'Daftar master produk tidak bisa dimuat',
      })
    } finally {
      setLoading(false)
    }
  }, [page, limit, search])

  useEffect(() => { fetchMasters() }, [fetchMasters])

  // Ticks belonged to rows that are no longer on screen.
  useEffect(() => { setSelected([]) }, [page, limit, search])

  const toggleRow = (id: string) =>
    setSelected((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]))

  const allOnPageSelected = masters.length > 0 && masters.every((m) => selected.includes(m.id))

  const toggleAllOnPage = () =>
    setSelected((prev) =>
      allOnPageSelected
        ? prev.filter((id) => !masters.some((m) => m.id === id))
        : [...new Set([...prev, ...masters.map((m) => m.id)])]
    )

  const selectedMasters = masters.filter((m) => selected.includes(m.id))

  const startEdit = (master: Master) => {
    setEditingId(master.id)
    setEditValue(String(master.stock))
  }

  const cancelEdit = () => {
    setEditingId(null)
    setEditValue('')
  }

  const saveEdit = async (master: Master) => {
    const next = Number(editValue)
    if (!Number.isFinite(next) || next < 0) {
      setMessage({ type: 'error', text: 'Stok harus angka bulat, minimal 0' })
      return
    }
    // The same number is still worth saving when Shopee holds something else:
    // that is how a push that failed, or a shop that drifted, gets re-sent.
    if (next === master.stock && inSync(master)) {
      cancelEdit()
      return
    }

    const stock = Math.trunc(next)
    setBusy(true)
    try {
      const res = await api.patch<any>(`/products/masters/${master.id}`, { stock })
      const push: PushResult | null = res.data?.push ?? null
      const allPushed = !!push && !push.error && push.failed.length === 0 && push.pushed > 0
      // Patched in place rather than refetching the page: a refetch would reorder
      // nothing but would blank the table for a moment on every single edit, and
      // this screen is used one row after another.
      setMasters((prev) =>
        prev.map((m) => (m.id === master.id
          ? { ...m, stock, listingStock: allPushed ? { min: stock, max: stock } : m.listingStock }
          : m))
      )
      setMessage(describePush(`Stok "${master.masterSku}" jadi ${stock}`, push))
      cancelEdit()
    } catch (err: any) {
      setMessage({ type: 'error', text: err?.response?.data?.error || 'Gagal mengubah stok' })
    } finally {
      setBusy(false)
    }
  }

  const openBulk = () => {
    setBulkValues({})
    setBulkValue('')
    setBulkFloored(0)
    setBulkOpen(true)
  }

  const closeBulk = () => {
    if (!busy) setBulkOpen(false)
  }

  /** Untick a master from inside the dialog — the "×" on its row. */
  const removeFromBulk = (id: string) => {
    const left = selected.filter((x) => x !== id)
    setSelected(left)
    setBulkValues((prev) => {
      const next = { ...prev }
      delete next[id]
      return next
    })
    if (left.length === 0) setBulkOpen(false)
  }

  /**
   * Fill every row's "Stok baru" from the mode + value pair, counted from each
   * master's own current stock. Rows can still be changed one by one after.
   * "Kurangi 30" is friendlier to type than "-30", so the sign is applied here.
   */
  const fillAll = () => {
    const raw = Number(bulkValue)
    if (bulkValue === '' || !Number.isFinite(raw) || raw < 0) {
      setMessage({ type: 'error', text: 'Isi angkanya dulu, minimal 0' })
      return
    }
    const amount = Math.trunc(raw)
    let floored = 0
    const next: Record<string, string> = {}
    for (const m of selectedMasters) {
      let value = bulkMode === 'set' ? amount : bulkMode === 'add' ? m.stock + amount : m.stock - amount
      if (value < 0) {
        floored++
        value = 0
      }
      next[m.id] = String(value)
    }
    setBulkValues(next)
    setBulkFloored(floored)
  }

  const isBadStock = (raw: string) => raw !== '' && (!Number.isFinite(Number(raw)) || Number(raw) < 0)

  // Rows holding a number different from the master's stock are sent, and so are
  // rows whose number Shopee does not hold yet — saving those re-sends the push.
  const bulkChanges = selectedMasters
    .filter((m) => (bulkValues[m.id] ?? '') !== '' && (Number(bulkValues[m.id]) !== m.stock || !inSync(m)))
    .map((m) => ({ productId: m.id, stock: Math.trunc(Number(bulkValues[m.id])) }))

  const bulkInvalid = selectedMasters.some((m) => isBadStock(bulkValues[m.id] ?? ''))

  const handleBulk = async () => {
    if (bulkInvalid || bulkChanges.length === 0) return

    setBusy(true)
    let updated = 0
    const pushes: PushResult[] = []
    try {
      for (let i = 0; i < bulkChanges.length; i += BULK_CHUNK) {
        const chunk = bulkChanges.slice(i, i + BULK_CHUNK)
        if (bulkChanges.length > BULK_CHUNK) setBulkProgress(`${i + chunk.length}/${bulkChanges.length}`)
        const res = await api.post<any>('/products/masters/stock', { items: chunk })
        updated += res.data?.updated ?? 0
        if (res.data?.push) pushes.push(res.data.push)
      }
      setMessage(describePush(`${updated} master diubah`, mergePush(pushes)))
      setBulkOpen(false)
      setSelected([])
      await fetchMasters()
    } catch (err: any) {
      const reason = err?.response?.data?.error || 'Gagal mengubah stok massal'
      // Chunks before the failing one are already saved and pushed. Saying so
      // keeps the operator from retrying the lot believing nothing happened.
      setMessage({
        type: 'error',
        text: updated > 0 ? `${updated} master sudah diubah, sisanya gagal: ${reason}` : reason,
      })
      if (updated > 0) await fetchMasters()
    } finally {
      setBusy(false)
      setBulkProgress(null)
    }
  }

  const handleDelete = async () => {
    setBusy(true)
    try {
      const res = await api.post<any>('/products/masters/delete', { productIds: selected })
      setMessage({
        type: 'success',
        text:
          `${res.data?.deleted ?? 0} master dihapus — ${res.data?.unmapped ?? 0} listing kembali ` +
          'belum dipetakan dan bisa dijadikan master lagi dari halaman Produk.',
      })
      setDeleteOpen(false)
      setSelected([])
      await fetchMasters()
    } catch (err: any) {
      setMessage({ type: 'error', text: err?.response?.data?.error || 'Gagal menghapus master' })
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-2xl font-bold text-gray-900 dark:text-slate-100">Daftar Stok</h1>
        <p className="text-sm text-gray-500 dark:text-slate-400">
          Stok master produk. Diisi manual — angka ini tidak berkurang sendiri saat ada pesanan.
          Saat disimpan, angkanya langsung dikirim ke semua listing Shopee yang terikat.
        </p>
      </div>

      {message && (
        <div className={`rounded-lg border px-4 py-3 text-sm ${
          message.type === 'success'
            ? 'border-blue-200 dark:border-blue-800 bg-blue-50 dark:bg-blue-900/20 text-blue-800 dark:text-blue-200'
            : 'border-red-200 dark:border-red-800 bg-red-50 dark:bg-red-900/20 text-red-800 dark:text-red-200'
        }`}>
          <p>{message.text}</p>
          {message.details && message.details.length > 0 && (
            <ul className="mt-2 space-y-0.5 text-xs">
              {message.details.map((d, i) => <li key={i}>• {d}</li>)}
            </ul>
          )}
        </div>
      )}

      <div className="card p-4">
        <div className="flex gap-2">
          <div className="relative flex-1">
            <Search className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" />
            <input
              value={searchInput}
              onChange={(e) => setSearchInput(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') { setSearch(searchInput); setPage(1) } }}
              placeholder="Cari SKU atau nama master…"
              className="input pl-9 w-full"
            />
          </div>
          <button
            onClick={() => { setSearch(searchInput); setPage(1) }}
            className="btn-secondary flex items-center gap-2"
          >
            <Search className="w-4 h-4" />
            <span>Cari</span>
          </button>
        </div>
      </div>

      {selected.length > 0 && (
        <div className="card p-3 flex flex-wrap items-center gap-2 border-blue-300 dark:border-blue-800 bg-blue-50 dark:bg-blue-900/20">
          <span className="text-sm font-medium text-blue-900 dark:text-blue-200 mr-1">
            {selected.length} master dipilih
          </span>
          <button onClick={openBulk} disabled={busy} className="btn-primary flex items-center gap-2">
            <Boxes className="w-4 h-4" />
            <span>Edit Stok Massal</span>
          </button>
          {isAdmin && (
            <button
              onClick={() => setDeleteOpen(true)}
              disabled={busy}
              className="btn-secondary flex items-center gap-2 text-red-600 dark:text-red-400 border-red-200 dark:border-red-900"
            >
              <Trash2 className="w-4 h-4" />
              <span>Hapus Master</span>
            </button>
          )}
          <button onClick={() => setSelected([])} className="text-sm text-blue-800 dark:text-blue-300 underline ml-auto">
            Batal pilih
          </button>
        </div>
      )}

      {!loading && total === 0 && !search && (
        <div className="card p-6 text-center space-y-2">
          <Boxes className="w-8 h-8 mx-auto text-gray-400 dark:text-slate-500" />
          <p className="font-medium text-gray-900 dark:text-slate-100">Belum ada master produk</p>
          <p className="text-sm text-gray-500 dark:text-slate-400">
            Master dibuat dari katalog: buka{' '}
            <Link href="/products" className="text-primary-600 dark:text-primary-400 underline">Produk</Link>,
            pilih listing yang sama, lalu tekan &ldquo;Jadikan Master&rdquo;.
          </p>
        </div>
      )}

      <div className="card overflow-hidden">
        <Pagination
          page={page}
          totalPages={totalPages}
          total={total}
          limit={limit}
          loading={loading}
          unit="master produk"
          onPageChange={setPage}
          onLimitChange={(n) => { setLimit(n); setPage(1) }}
        />
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-gray-50 dark:bg-slate-800/60 text-left text-xs uppercase text-gray-500 dark:text-slate-400">
              <tr>
                <th className="px-4 py-3 w-10">
                  <input
                    type="checkbox"
                    checked={allOnPageSelected}
                    onChange={toggleAllOnPage}
                    aria-label="Pilih semua di halaman ini"
                    className="rounded border-gray-300 dark:border-slate-600"
                  />
                </th>
                <th className="px-4 py-3">SKU Master</th>
                <th className="px-4 py-3">Nama Produk</th>
                <th className="px-4 py-3 text-right">Listing Terikat</th>
                <th className="px-4 py-3 text-right">Stok</th>
                <th className="px-4 py-3 text-right" title="Stok yang dipegang listing Shopee, per penyegaran atau pengiriman terakhir">Di Shopee</th>
                <th className="px-4 py-3 w-24"></th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-200 dark:divide-slate-700">
              {loading ? (
                <tr><td colSpan={7} className="px-4 py-8 text-center text-gray-500 dark:text-slate-400">Memuat…</td></tr>
              ) : masters.length === 0 ? (
                <tr><td colSpan={7} className="px-4 py-8 text-center text-gray-500 dark:text-slate-400">Tidak ada master yang cocok.</td></tr>
              ) : masters.map((m) => (
                <tr
                  key={m.id}
                  className={`hover:bg-gray-50 dark:hover:bg-slate-800/40 ${
                    selected.includes(m.id) ? 'bg-blue-50/60 dark:bg-blue-900/10' : ''
                  }`}
                >
                  <td className="px-4 py-3">
                    <input
                      type="checkbox"
                      checked={selected.includes(m.id)}
                      onChange={() => toggleRow(m.id)}
                      aria-label={`Pilih ${m.masterSku}`}
                      className="rounded border-gray-300 dark:border-slate-600"
                    />
                  </td>
                  <td className="px-4 py-3 font-mono text-xs text-gray-900 dark:text-slate-100">{m.masterSku}</td>
                  <td className="px-4 py-3 text-gray-700 dark:text-slate-200">{m.name}</td>
                  <td className="px-4 py-3 text-right">
                    {(m._count?.listings ?? 0) === 0 ? (
                      // A master bound to nothing changes nothing anywhere. Worth
                      // flagging on the screen where its number is being typed.
                      <span className="inline-flex items-center gap-1 text-xs text-amber-600 dark:text-amber-400" title="Master ini belum terikat ke listing mana pun">
                        <AlertTriangle className="w-3 h-3" /> 0
                      </span>
                    ) : (
                      <span className="text-gray-600 dark:text-slate-300">{m._count?.listings}</span>
                    )}
                  </td>
                  <td className="px-4 py-3 text-right">
                    {editingId === m.id ? (
                      <input
                        type="number"
                        min={0}
                        value={editValue}
                        onChange={(e) => setEditValue(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') saveEdit(m)
                          if (e.key === 'Escape') cancelEdit()
                        }}
                        autoFocus
                        className="input w-24 text-right py-1"
                      />
                    ) : (
                      <span className="font-medium text-gray-900 dark:text-slate-100">{m.stock}</span>
                    )}
                  </td>
                  <td className="px-4 py-3 text-right">
                    {!m.listingStock ? (
                      <span className="text-gray-500 dark:text-slate-400">—</span>
                    ) : inSync(m) ? (
                      <span className="text-gray-600 dark:text-slate-300">{formatRange(m.listingStock)}</span>
                    ) : (
                      // Shopee holds a different number — usually sales since the
                      // last save. Worth seeing before typing a new count.
                      <span
                        className="inline-flex items-center gap-1 text-amber-700 dark:text-amber-400"
                        title="Beda dengan stok master. Simpan stok untuk mengirim angka master ke Shopee."
                      >
                        <AlertTriangle className="w-3 h-3" /> {formatRange(m.listingStock)}
                      </span>
                    )}
                  </td>
                  <td className="px-4 py-3">
                    {editingId === m.id ? (
                      <div className="flex items-center gap-1 justify-end">
                        <button
                          onClick={() => saveEdit(m)}
                          disabled={busy}
                          className="p-1.5 rounded text-green-600 hover:bg-green-50 dark:hover:bg-green-900/30"
                          aria-label="Simpan"
                        >
                          {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : <Check className="w-4 h-4" />}
                        </button>
                        <button
                          onClick={cancelEdit}
                          className="p-1.5 rounded text-gray-500 hover:bg-gray-100 dark:hover:bg-slate-700"
                          aria-label="Batal"
                        >
                          <X className="w-4 h-4" />
                        </button>
                      </div>
                    ) : (
                      <div className="flex justify-end">
                        <button
                          onClick={() => startEdit(m)}
                          className="inline-flex items-center gap-1 text-xs text-primary-600 dark:text-primary-400 hover:underline"
                        >
                          <Pencil className="w-3 h-3" /> Edit Stok
                        </button>
                      </div>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        {/* Repeated below the rows: at 100+ a page the bar above is a long
            scroll back up. */}
        {totalPages > 1 && (
          <div className="[&>div]:border-b-0 border-t border-gray-200 dark:border-slate-700">
            <Pagination
              page={page}
              totalPages={totalPages}
              total={total}
              limit={limit}
              loading={loading}
              unit="master produk"
              onPageChange={(p) => { setPage(p); window.scrollTo({ top: 0 }) }}
              onLimitChange={(n) => { setLimit(n); setPage(1) }}
            />
          </div>
        )}
      </div>

      {deleteOpen && (
        <div className="fixed inset-0 z-[70] flex items-center justify-center bg-black/40 p-4" onClick={() => !busy && setDeleteOpen(false)}>
          <div className="card w-full max-w-md p-5 space-y-4" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-start justify-between gap-4">
              <div>
                <h2 className="text-lg font-semibold text-gray-900 dark:text-slate-100">
                  Hapus {selected.length} master?
                </h2>
                <p className="text-sm text-gray-500 dark:text-slate-400">
                  Untuk mengatur ulang: produknya kembali seperti belum pernah dijadikan master.
                </p>
              </div>
              <button onClick={() => setDeleteOpen(false)} disabled={busy} className="text-gray-400 hover:text-gray-600">
                <X className="w-5 h-5" />
              </button>
            </div>

            <ul className="text-sm space-y-1.5 text-gray-700 dark:text-slate-200">
              <li>• Listing yang terikat kembali ke &ldquo;belum dipetakan&rdquo; dan bisa dijadikan master lagi dari halaman Produk.</li>
              <li className="text-red-700 dark:text-red-300">• Angka stok yang sudah diketik untuk master ini hilang.</li>
              <li>• Produk di Shopee tidak berubah sama sekali.</li>
            </ul>

            {selectedMasters.length > 0 && (
              <div className="max-h-40 overflow-y-auto rounded-lg border border-gray-200 dark:border-slate-700 divide-y divide-gray-100 dark:divide-slate-700/60">
                {selectedMasters.map((m) => (
                  <div key={m.id} className="px-3 py-1.5 flex justify-between gap-3 text-xs">
                    <span className="font-mono text-gray-900 dark:text-slate-100 truncate">{m.masterSku}</span>
                    <span className="text-gray-500 dark:text-slate-400 shrink-0">stok {m.stock}</span>
                  </div>
                ))}
              </div>
            )}

            <div className="flex justify-end gap-2 pt-1">
              <button onClick={() => setDeleteOpen(false)} disabled={busy} className="btn-secondary">Batal</button>
              <button
                onClick={handleDelete}
                disabled={busy}
                className="btn-primary bg-red-600 hover:bg-red-700 flex items-center gap-2"
              >
                {busy && <Loader2 className="w-4 h-4 animate-spin" />}
                <span>Ya, Hapus</span>
              </button>
            </div>
          </div>
        </div>
      )}

      {bulkOpen && (
        <div className="fixed inset-0 z-[70] flex items-center justify-center bg-black/40 p-4" onClick={closeBulk}>
          <div className="card w-full max-w-2xl p-5 flex flex-col gap-4 max-h-[90vh]" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-start justify-between gap-4">
              <div>
                <h2 className="text-lg font-semibold text-gray-900 dark:text-slate-100">Edit Stok Massal</h2>
                <p className="text-sm text-gray-500 dark:text-slate-400">
                  {selectedMasters.length} master. Isi &ldquo;Stok baru&rdquo; per SKU — yang dikosongkan tidak diubah.
                </p>
              </div>
              <button onClick={closeBulk} disabled={busy} className="text-gray-400 hover:text-gray-600">
                <X className="w-5 h-5" />
              </button>
            </div>

            {/* Only fills the fields below; nothing is saved until Simpan. */}
            <div className="rounded-lg border border-gray-200 dark:border-slate-700 p-3 space-y-2">
              <p className="text-xs font-medium text-gray-500 dark:text-slate-400">Isi semua sekaligus</p>
              <div className="flex flex-wrap gap-2">
                <div className="flex gap-1">
                  {(Object.keys(modeLabels) as BulkMode[]).map((mode) => (
                    <button
                      key={mode}
                      onClick={() => setBulkMode(mode)}
                      className={`px-3 py-1.5 rounded-lg text-sm border ${
                        bulkMode === mode
                          ? 'border-primary-500 bg-primary-50 dark:bg-primary-900/30 text-primary-700 dark:text-primary-300 font-medium'
                          : 'border-gray-200 dark:border-slate-700 text-gray-600 dark:text-slate-300'
                      }`}
                    >
                      {modeLabels[mode]}
                    </button>
                  ))}
                </div>
                <input
                  type="number"
                  min={0}
                  value={bulkValue}
                  onChange={(e) => setBulkValue(e.target.value)}
                  onKeyDown={(e) => { if (e.key === 'Enter') fillAll() }}
                  placeholder="0"
                  className="input w-28 text-right py-1.5"
                />
                <button onClick={fillAll} disabled={bulkValue === ''} className="btn-secondary py-1.5">
                  Isi ke semua
                </button>
              </div>
              {bulkFloored > 0 && (
                <p className="text-xs text-red-700 dark:text-red-300">
                  {bulkFloored} master jadi minus dan diisi 0. Cek angkanya.
                </p>
              )}
            </div>

            <div className="flex-1 min-h-0 overflow-y-auto space-y-2 pr-1">
              {selectedMasters.map((m) => {
                const raw = bulkValues[m.id] ?? ''
                return (
                  <div
                    key={m.id}
                    className="relative rounded-lg border border-gray-200 dark:border-slate-700 p-3 flex flex-col sm:flex-row sm:items-center gap-3"
                  >
                    <button
                      onClick={() => removeFromBulk(m.id)}
                      disabled={busy}
                      className="absolute top-1.5 right-1.5 p-0.5 rounded text-gray-400 hover:text-gray-600 hover:bg-gray-100 dark:hover:bg-slate-700"
                      aria-label={`Keluarkan ${m.masterSku}`}
                      title="Keluarkan dari edit ini"
                    >
                      <X className="w-3.5 h-3.5" />
                    </button>
                    <div className="flex-1 min-w-0 pr-5">
                      <p className="text-sm text-gray-900 dark:text-slate-100 truncate" title={m.name}>{m.name}</p>
                      <p className="text-xs font-mono text-gray-500 dark:text-slate-400 truncate">MSKU {m.masterSku}</p>
                    </div>
                    <div className="flex gap-3 sm:pr-5">
                      <div>
                        <label className="block text-xs text-gray-500 dark:text-slate-400 mb-1">Stok lama</label>
                        <input
                          value={m.stock}
                          readOnly
                          tabIndex={-1}
                          className="input w-24 py-1 text-right bg-gray-50 dark:bg-slate-800/60 text-gray-500 dark:text-slate-400"
                        />
                      </div>
                      <div>
                        <label className="block text-xs text-gray-500 dark:text-slate-400 mb-1">Di Shopee</label>
                        <input
                          value={m.listingStock ? formatRange(m.listingStock) : '—'}
                          readOnly
                          tabIndex={-1}
                          className={`input w-24 py-1 text-right bg-gray-50 dark:bg-slate-800/60 ${
                            inSync(m) ? 'text-gray-500 dark:text-slate-400' : 'text-amber-700 dark:text-amber-400'
                          }`}
                        />
                      </div>
                      <div>
                        <label className="block text-xs text-gray-500 dark:text-slate-400 mb-1">Stok baru</label>
                        <input
                          type="number"
                          min={0}
                          value={raw}
                          onChange={(e) => setBulkValues((prev) => ({ ...prev, [m.id]: e.target.value }))}
                          placeholder="Stok"
                          className={`input w-24 py-1 text-right ${isBadStock(raw) ? 'border-red-400 dark:border-red-700' : ''}`}
                        />
                      </div>
                    </div>
                  </div>
                )
              })}
            </div>

            <div className="flex items-center justify-end gap-2 pt-1">
              <span className="text-xs text-gray-500 dark:text-slate-400 mr-auto">
                {bulkInvalid
                  ? 'Ada stok yang minus atau bukan angka'
                  : busy
                    ? `Menyimpan & mengirim ke Shopee…${bulkProgress ? ` ${bulkProgress}` : ''}`
                    : `${bulkChanges.length} master akan diubah dan dikirim ke Shopee`}
              </span>
              <button onClick={closeBulk} disabled={busy} className="btn-secondary">Batal</button>
              <button
                onClick={handleBulk}
                disabled={busy || bulkInvalid || bulkChanges.length === 0}
                className="btn-primary flex items-center gap-2"
              >
                {busy && <Loader2 className="w-4 h-4 animate-spin" />}
                <span>Simpan</span>
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
