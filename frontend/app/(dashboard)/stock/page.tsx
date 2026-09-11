'use client'

import { useCallback, useEffect, useState } from 'react'
import Link from 'next/link'
import api from '@/lib/api'
import {
  Boxes,
  Search,
  Loader2,
  Check,
  X,
  Pencil,
  AlertTriangle,
} from 'lucide-react'

interface Master {
  id: string
  masterSku: string
  name: string
  stock: number
  isActive: boolean
  _count?: { listings: number }
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
  const [message, setMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null)

  const [page, setPage] = useState(1)
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

  const [bulkOpen, setBulkOpen] = useState(false)
  const [bulkMode, setBulkMode] = useState<BulkMode>('set')
  const [bulkValue, setBulkValue] = useState('')

  const fetchMasters = useCallback(async () => {
    setLoading(true)
    try {
      const params: Record<string, string | number> = { page, limit: 20 }
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
  }, [page, search])

  useEffect(() => { fetchMasters() }, [fetchMasters])

  // Ticks belonged to rows that are no longer on screen.
  useEffect(() => { setSelected([]) }, [page, search])

  const toggleRow = (id: string) =>
    setSelected((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]))

  const allOnPageSelected = masters.length > 0 && masters.every((m) => selected.includes(m.id))

  const toggleAllOnPage = () =>
    setSelected((prev) =>
      allOnPageSelected
        ? prev.filter((id) => !masters.some((m) => m.id === id))
        : [...new Set([...prev, ...masters.map((m) => m.id)])]
    )

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
    if (next === master.stock) {
      cancelEdit()
      return
    }

    setBusy(true)
    try {
      await api.patch(`/products/masters/${master.id}`, { stock: Math.trunc(next) })
      // Patched in place rather than refetching the page: a refetch would reorder
      // nothing but would blank the table for a moment on every single edit, and
      // this screen is used one row after another.
      setMasters((prev) =>
        prev.map((m) => (m.id === master.id ? { ...m, stock: Math.trunc(next) } : m))
      )
      setMessage({ type: 'success', text: `Stok "${master.masterSku}" jadi ${Math.trunc(next)}` })
      cancelEdit()
    } catch (err: any) {
      setMessage({ type: 'error', text: err?.response?.data?.error || 'Gagal mengubah stok' })
    } finally {
      setBusy(false)
    }
  }

  const handleBulk = async () => {
    const raw = Number(bulkValue)
    if (!Number.isFinite(raw)) {
      setMessage({ type: 'error', text: 'Isi angkanya dulu' })
      return
    }

    // "Kurangi 30" is friendlier to type than "adjust by -30", so the sign is
    // applied here rather than asked for.
    const mode = bulkMode === 'set' ? 'set' : 'adjust'
    const value = bulkMode === 'subtract' ? -Math.abs(Math.trunc(raw)) : Math.trunc(raw)

    setBusy(true)
    try {
      const res = await api.post<any>('/products/masters/stock', {
        productIds: selected,
        mode,
        value,
      })
      const clamped = res.data?.clamped ?? 0
      setMessage({
        type: clamped > 0 ? 'error' : 'success',
        text:
          `${res.data?.updated ?? 0} master diubah` +
          (clamped > 0
            ? ` — tapi ${clamped} di antaranya jadi minus dan dibulatkan ke 0. Cek angkanya.`
            : ''),
      })
      setBulkOpen(false)
      setBulkValue('')
      setSelected([])
      await fetchMasters()
    } catch (err: any) {
      setMessage({ type: 'error', text: err?.response?.data?.error || 'Gagal mengubah stok massal' })
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
        </p>
      </div>

      {message && (
        <div className={`rounded-lg border px-4 py-3 text-sm ${
          message.type === 'success'
            ? 'border-blue-200 dark:border-blue-800 bg-blue-50 dark:bg-blue-900/20 text-blue-800 dark:text-blue-200'
            : 'border-red-200 dark:border-red-800 bg-red-50 dark:bg-red-900/20 text-red-800 dark:text-red-200'
        }`}>
          {message.text}
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
          <button onClick={() => setBulkOpen(true)} disabled={busy} className="btn-primary flex items-center gap-2">
            <Boxes className="w-4 h-4" />
            <span>Edit Stok Massal</span>
          </button>
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
        <div className="px-4 py-3 border-b border-gray-200 dark:border-slate-700 text-sm text-gray-500 dark:text-slate-400">
          {loading ? 'Memuat…' : `${total.toLocaleString('id-ID')} master produk`}
        </div>
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
                <th className="px-4 py-3 w-24"></th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-200 dark:divide-slate-700">
              {loading ? (
                <tr><td colSpan={6} className="px-4 py-8 text-center text-gray-500 dark:text-slate-400">Memuat…</td></tr>
              ) : masters.length === 0 ? (
                <tr><td colSpan={6} className="px-4 py-8 text-center text-gray-500 dark:text-slate-400">Tidak ada master yang cocok.</td></tr>
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

        {totalPages > 1 && (
          <div className="px-4 py-3 border-t border-gray-200 dark:border-slate-700 flex items-center justify-between text-sm">
            <span className="text-gray-500 dark:text-slate-400">Halaman {page} dari {totalPages}</span>
            <div className="flex gap-2">
              <button onClick={() => setPage((p) => Math.max(1, p - 1))} disabled={page === 1} className="btn-secondary">
                Sebelumnya
              </button>
              <button onClick={() => setPage((p) => Math.min(totalPages, p + 1))} disabled={page >= totalPages} className="btn-secondary">
                Berikutnya
              </button>
            </div>
          </div>
        )}
      </div>

      {bulkOpen && (
        <div className="fixed inset-0 z-[70] flex items-center justify-center bg-black/40 p-4" onClick={() => setBulkOpen(false)}>
          <div className="card w-full max-w-md p-5 space-y-4" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-start justify-between gap-4">
              <div>
                <h2 className="text-lg font-semibold text-gray-900 dark:text-slate-100">Edit Stok Massal</h2>
                <p className="text-sm text-gray-500 dark:text-slate-400">
                  Berlaku untuk {selected.length} master terpilih.
                </p>
              </div>
              <button onClick={() => setBulkOpen(false)} className="text-gray-400 hover:text-gray-600">
                <X className="w-5 h-5" />
              </button>
            </div>

            <div className="flex gap-2">
              {(Object.keys(modeLabels) as BulkMode[]).map((mode) => (
                <button
                  key={mode}
                  onClick={() => setBulkMode(mode)}
                  className={`flex-1 px-3 py-2 rounded-lg text-sm border ${
                    bulkMode === mode
                      ? 'border-primary-500 bg-primary-50 dark:bg-primary-900/30 text-primary-700 dark:text-primary-300 font-medium'
                      : 'border-gray-200 dark:border-slate-700 text-gray-600 dark:text-slate-300'
                  }`}
                >
                  {modeLabels[mode]}
                </button>
              ))}
            </div>

            <div>
              <input
                type="number"
                min={0}
                value={bulkValue}
                onChange={(e) => setBulkValue(e.target.value)}
                placeholder="0"
                autoFocus
                className="input w-full text-right"
              />
              <p className="text-xs text-gray-500 dark:text-slate-400 mt-1">
                {bulkMode === 'set'
                  ? 'Semua master terpilih akan bernilai persis angka ini.'
                  : bulkMode === 'add'
                    ? 'Ditambahkan ke stok yang sekarang, per master.'
                    : 'Dikurangi dari stok yang sekarang. Yang jadi minus dibulatkan ke 0 dan dilaporkan.'}
              </p>
            </div>

            <div className="flex justify-end gap-2 pt-1">
              <button onClick={() => setBulkOpen(false)} className="btn-secondary">Batal</button>
              <button onClick={handleBulk} disabled={busy || bulkValue === ''} className="btn-primary flex items-center gap-2">
                {busy && <Loader2 className="w-4 h-4 animate-spin" />}
                <span>Terapkan</span>
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
