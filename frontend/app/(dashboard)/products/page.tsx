'use client'

import { useCallback, useEffect, useState } from 'react'
import api from '@/lib/api'
import {
  Package,
  RefreshCw,
  Loader2,
  Search,
  AlertTriangle,
  Link2Off,
  Link2,
  Wand2,
  X,
} from 'lucide-react'

interface Listing {
  id: string
  platform: string
  itemId: string
  modelId: string
  sku: string | null
  name: string
  status: string
  price: number | null
  stock: number | null
  imageUrl: string | null
  lastSyncedAt: string | null
  store: { id: string; name: string; platform: string }
  product: { id: string; masterSku: string; name: string; stock: number } | null
}

interface LastPull {
  at: string
  stores: number
  listings: number
  failed: number
  errors: string[]
}

interface StockSync {
  at: string
  stores: number
  checked: number
  updated: number
  failed: number
  errors: string[]
}

interface Summary {
  listings: number
  unmapped: number
  mapped: number
  masters: number
  lastSyncedAt: string | null
  lastPull: LastPull | null
  lastStockSync: StockSync | null
}

interface Master {
  id: string
  masterSku: string
  name: string
  stock: number
  isActive: boolean
  _count?: { listings: number }
}

interface StoreOption {
  id: string
  name: string
}

const statusLabels: Record<string, string> = {
  NORMAL: 'Aktif',
  UNLIST: 'Diarsipkan',
  BANNED: 'Diblokir',
  DELETED: 'Dihapus',
}

const statusClass: Record<string, string> = {
  NORMAL: 'bg-green-100 text-green-700 dark:bg-green-950/60 dark:text-green-300',
  UNLIST: 'bg-gray-100 text-gray-600 dark:bg-slate-700 dark:text-slate-300',
  BANNED: 'bg-red-100 text-red-700 dark:bg-red-950/60 dark:text-red-300',
  DELETED: 'bg-red-100 text-red-700 dark:bg-red-950/60 dark:text-red-300',
}

const rupiah = (n: number | null) =>
  n === null ? '—' : `Rp ${n.toLocaleString('id-ID')}`

function relativeTime(iso: string): string {
  const seconds = Math.floor((Date.now() - new Date(iso).getTime()) / 1000)
  if (seconds < 60) return 'baru saja'
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes} menit lalu`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours} jam lalu`
  return `${Math.floor(hours / 24)} hari lalu`
}

export default function ProductsPage() {
  const [listings, setListings] = useState<Listing[]>([])
  const [summary, setSummary] = useState<Summary | null>(null)
  const [stores, setStores] = useState<StoreOption[]>([])
  const [loading, setLoading] = useState(true)
  const [syncing, setSyncing] = useState(false)
  const [syncingStock, setSyncingStock] = useState(false)

  // Selection lives per page on purpose. Carrying it across pagination means an
  // operator can act on rows that scrolled out of sight minutes ago, which is
  // exactly how a bulk mapping goes wrong without anyone noticing.
  const [selected, setSelected] = useState<string[]>([])
  const [modal, setModal] = useState<null | 'create' | 'map'>(null)
  const [busy, setBusy] = useState(false)

  const [newSku, setNewSku] = useState('')
  const [newName, setNewName] = useState('')
  const [newStock, setNewStock] = useState('0')

  const [masterQuery, setMasterQuery] = useState('')
  const [masterResults, setMasterResults] = useState<Master[]>([])
  const [message, setMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null)

  const [page, setPage] = useState(1)
  const [totalPages, setTotalPages] = useState(1)
  const [total, setTotal] = useState(0)
  const [search, setSearch] = useState('')
  const [searchInput, setSearchInput] = useState('')
  const [storeId, setStoreId] = useState('')
  const [status, setStatus] = useState('')
  const [mapped, setMapped] = useState('')

  const [summaryError, setSummaryError] = useState<string | null>(null)

  const fetchSummary = useCallback(async () => {
    try {
      const res = await api.get<any>('/products/summary')
      // The axios interceptor in lib/api already unwraps { success, data } — reading
      // .data.data again lands on undefined, which showed a full catalogue as 0.
      setSummary(res.data ?? null)
      setSummaryError(null)
    } catch (err: any) {
      // Swallowing this is what made an empty page unreadable: with no summary
      // the stat cards and the "catalogue is empty" note both vanish, leaving a
      // blank table that looks like a successful pull of nothing.
      setSummary(null)
      setSummaryError(err?.response?.data?.error || err?.message || 'Ringkasan produk tidak bisa dimuat')
    }
  }, [])

  const fetchListings = useCallback(async () => {
    setLoading(true)
    try {
      const params: Record<string, string | number> = { page, limit: 20 }
      if (search) params.search = search
      if (storeId) params.storeId = storeId
      if (status) params.status = status
      if (mapped) params.mapped = mapped

      const res = await api.get<any>('/products/listings', { params })
      const data = res.data
      setListings(data?.listings ?? [])
      setTotalPages(data?.totalPages ?? 1)
      setTotal(data?.total ?? 0)
    } catch (err) {
      console.error('Failed to fetch listings', err)
      setListings([])
    } finally {
      setLoading(false)
    }
  }, [page, search, storeId, status, mapped])

  useEffect(() => {
    api.get<any>('/stores')
      .then((res) => {
        const raw = Array.isArray(res.data) ? res.data : (res.data?.data ?? [])
        setStores(raw.map((s: any) => ({ id: s.id, name: s.name })))
      })
      .catch(() => setStores([]))
    fetchSummary()
  }, [fetchSummary])

  useEffect(() => { fetchListings() }, [fetchListings])

  // Any filter change invalidates the current page number — page 7 of an
  // unfiltered catalogue is usually past the end of a filtered one, which shows
  // an empty table that reads as "no results".
  useEffect(() => { setPage(1) }, [search, storeId, status, mapped])

  // Whatever was ticked belonged to the rows that were on screen; those rows are
  // gone now.
  useEffect(() => { setSelected([]) }, [page, search, storeId, status, mapped])

  const handleSync = async () => {
    setSyncing(true)
    setMessage(null)
    try {
      await api.post('/products/sync', storeId ? { storeId } : {})
      setMessage({
        type: 'success',
        text: 'Penarikan katalog dimulai. Ini bisa makan beberapa menit untuk toko besar — angka di atas akan bertambah sendiri.',
      })

      // The pull answers before it finishes, so the only honest progress signal
      // is the count climbing. Poll for a while, then leave it be.
      const until = Date.now() + 180_000
      while (Date.now() < until) {
        await new Promise((r) => setTimeout(r, 5_000))
        await fetchSummary()
        await fetchListings()
      }
    } catch (err: any) {
      setMessage({
        type: 'error',
        text: err?.response?.data?.error || 'Gagal memulai penarikan katalog',
      })
    } finally {
      setSyncing(false)
    }
  }

  // Deliberately not merged with handleSync. They differ in what they cost and
  // in what they can fix: this one re-reads listings we already hold, so it can
  // correct a stale number but can never find a product that was added since the
  // last catalogue pull.
  const handleSyncStock = async () => {
    setSyncingStock(true)
    setMessage(null)
    try {
      await api.post('/products/sync-stock', storeId ? { storeId } : {})
      setMessage({
        type: 'success',
        text: 'Penyegaran stok dimulai. Angka di kolom Stok akan berubah sendiri begitu Shopee menjawab.',
      })

      // Same polling shape as the catalogue pull, and shorter: this reads fewer
      // endpoints, so it has no business holding the button for three minutes.
      const until = Date.now() + 90_000
      while (Date.now() < until) {
        await new Promise((r) => setTimeout(r, 5_000))
        await fetchSummary()
        await fetchListings()
      }
    } catch (err: any) {
      setMessage({
        type: 'error',
        text: err?.response?.data?.error || 'Gagal memulai penyegaran stok',
      })
    } finally {
      setSyncingStock(false)
    }
  }

  const toggleRow = (id: string) =>
    setSelected((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]))

  const allOnPageSelected = listings.length > 0 && listings.every((l) => selected.includes(l.id))

  const toggleAllOnPage = () =>
    setSelected((prev) =>
      allOnPageSelected
        ? prev.filter((id) => !listings.some((l) => l.id === id))
        : [...new Set([...prev, ...listings.map((l) => l.id)])]
    )

  const afterMappingChange = async (text: string) => {
    setMessage({ type: 'success', text })
    setSelected([])
    setModal(null)
    await Promise.all([fetchSummary(), fetchListings()])
  }

  /**
   * Open the create-master dialog, pre-filling the SKU from the selection.
   *
   * PROSES KOMPLACE says the master SKU has to match the Zaneva product name,
   * and the seller SKU already on the listing is usually exactly that — so it is
   * offered as a starting point, not written for them.
   */
  const openCreateMaster = () => {
    const first = listings.find((l) => selected.includes(l.id))
    setNewSku(first?.sku ?? '')
    setNewName(first?.name ?? '')
    setNewStock('0')
    setModal('create')
  }

  const handleCreateMaster = async () => {
    setBusy(true)
    try {
      const res = await api.post<any>('/products/masters', {
        masterSku: newSku,
        name: newName,
        stock: Number(newStock) || 0,
        listingIds: selected,
      })
      const skipped = res.data?.skipped ?? 0
      await afterMappingChange(
        `Master "${newSku}" dibuat, ${res.data?.mapped ?? 0} listing terikat` +
        (skipped > 0 ? ` (${skipped} dilewati — di luar toko yang bisa kamu akses)` : '')
      )
    } catch (err: any) {
      setMessage({ type: 'error', text: err?.response?.data?.error || 'Gagal membuat master produk' })
    } finally {
      setBusy(false)
    }
  }

  const searchMasters = useCallback(async (q: string) => {
    try {
      const res = await api.get<any>('/products/masters', { params: { search: q, limit: 20 } })
      setMasterResults(res.data?.masters ?? [])
    } catch {
      setMasterResults([])
    }
  }, [])

  const openMapExisting = () => {
    setMasterQuery('')
    setModal('map')
    searchMasters('')
  }

  const handleMapExisting = async (master: Master) => {
    setBusy(true)
    try {
      const res = await api.post<any>('/products/listings/map', {
        listingIds: selected,
        productId: master.id,
      })
      await afterMappingChange(`${res.data?.mapped ?? 0} listing dipetakan ke "${master.masterSku}"`)
    } catch (err: any) {
      setMessage({ type: 'error', text: err?.response?.data?.error || 'Gagal memetakan listing' })
    } finally {
      setBusy(false)
    }
  }

  const handleUnmap = async () => {
    setBusy(true)
    try {
      const res = await api.post<any>('/products/listings/unmap', { listingIds: selected })
      await afterMappingChange(`${res.data?.unmapped ?? 0} listing dilepas dari masternya`)
    } catch (err: any) {
      setMessage({ type: 'error', text: err?.response?.data?.error || 'Gagal melepas pemetaan' })
    } finally {
      setBusy(false)
    }
  }

  /**
   * Bind every unmapped listing whose SKU already equals a master's SKU.
   *
   * Counts first and asks, because this is the one action here that touches rows
   * the operator never selected and cannot see.
   */
  const handleAutomap = async () => {
    setBusy(true)
    setMessage(null)
    try {
      const dry = await api.post<any>('/products/masters/automap', { dryRun: true })
      const matched = dry.data?.matched ?? 0
      if (matched === 0) {
        setMessage({
          type: 'success',
          text: 'Tidak ada listing yang SKU-nya sama persis dengan master mana pun. Buat masternya dulu lewat "Jadikan Master".',
        })
        return
      }
      if (!window.confirm(`${matched.toLocaleString('id-ID')} listing punya SKU yang sama persis dengan master yang sudah ada. Petakan semuanya sekarang?`)) {
        return
      }

      const res = await api.post<any>('/products/masters/automap', {})
      await afterMappingChange(
        `${(res.data?.mapped ?? 0).toLocaleString('id-ID')} listing dipetakan otomatis ke ${res.data?.masters ?? 0} master`
      )
    } catch (err: any) {
      setMessage({ type: 'error', text: err?.response?.data?.error || 'Gagal memetakan otomatis' })
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-col sm:flex-row sm:items-start sm:justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold text-gray-900 dark:text-slate-100">Produk</h1>
          <p className="text-sm text-gray-500 dark:text-slate-400">
            Katalog dari semua toko yang tersambung
          </p>
          {summary?.lastSyncedAt && (
            <p className="text-xs text-gray-500 dark:text-slate-400 mt-1">
              Katalog terakhir ditarik {relativeTime(summary.lastSyncedAt)}
            </p>
          )}
          {/* How many rows actually moved, not just that something ran — a
              refresh that changed nothing and a refresh that never reached
              Shopee look identical without it. */}
          {summary?.lastStockSync && summary.lastStockSync.errors.length === 0 && (
            <p className="text-xs text-gray-500 dark:text-slate-400">
              Stok disegarkan {relativeTime(summary.lastStockSync.at)} —{' '}
              {summary.lastStockSync.updated.toLocaleString('id-ID')} dari{' '}
              {summary.lastStockSync.checked.toLocaleString('id-ID')} listing berubah
            </p>
          )}
        </div>
        {/* Stock first, and primary, because it is the one an operator presses
            daily. Pulling the catalogue is for when the shop gains a product —
            rare, and many times the work. */}
        <div className="flex flex-wrap gap-2 self-start">
          <button
            onClick={handleSyncStock}
            disabled={syncing || syncingStock}
            className="btn-primary flex items-center gap-2"
          >
            {syncingStock ? <Loader2 className="w-4 h-4 animate-spin" /> : <RefreshCw className="w-4 h-4" />}
            <span>{storeId ? 'Sinkron Stok Toko Ini' : 'Sinkron Stok'}</span>
          </button>
          <button
            onClick={handleSync}
            disabled={syncing || syncingStock}
            className="btn-secondary flex items-center gap-2"
          >
            {syncing ? <Loader2 className="w-4 h-4 animate-spin" /> : <Package className="w-4 h-4" />}
            <span>{storeId ? 'Tarik Katalog Toko Ini' : 'Tarik Katalog'}</span>
          </button>
        </div>
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

      {summaryError && (
        <div className="rounded-lg border border-red-300 dark:border-red-800 bg-red-50 dark:bg-red-900/20 px-4 py-3 text-sm text-red-800 dark:text-red-200 flex items-start gap-2">
          <AlertTriangle className="w-4 h-4 mt-0.5 shrink-0" />
          <p><span className="font-semibold">Ringkasan produk gagal dimuat.</span> {summaryError}</p>
        </div>
      )}

      {/* Why the last pull ended the way it did. An empty catalogue has two very
          different causes — Shopee refused us, or the shop really is empty —
          and only this tells them apart. */}
      {summary?.lastPull && summary.lastPull.errors.length > 0 && (
        <div className="rounded-lg border border-red-300 dark:border-red-800 bg-red-50 dark:bg-red-900/20 px-4 py-3 text-sm text-red-800 dark:text-red-200">
          <div className="flex items-start gap-2">
            <AlertTriangle className="w-4 h-4 mt-0.5 shrink-0" />
            <div className="space-y-1">
              <p className="font-semibold">
                Penarikan katalog terakhir gagal
                {summary.lastPull.failed > 0 && ` untuk ${summary.lastPull.failed} toko`}.
              </p>
              {summary.lastPull.errors.map((e, i) => (
                <p key={i} className="text-xs break-words [overflow-wrap:anywhere]">{e}</p>
              ))}
              <p className="text-xs opacity-80">
                Kalau pesannya menyebut izin atau <span className="font-mono">no permission</span>,
                artinya aplikasi ini belum punya izin Product di Shopee Partner Console — itu
                pengajuan terpisah, bukan masalah kode.
              </p>
            </div>
          </div>
        </div>
      )}

{summary?.lastStockSync && summary.lastStockSync.errors.length > 0 && (
        <div className="rounded-lg border border-amber-300 dark:border-amber-800 bg-amber-50 dark:bg-amber-900/20 px-4 py-3 text-sm text-amber-900 dark:text-amber-200">
          <div className="flex items-start gap-2">
            <AlertTriangle className="w-4 h-4 mt-0.5 shrink-0" />
            <div className="space-y-1">
              <p className="font-semibold">
                Penyegaran stok terakhir tidak lengkap
                {summary.lastStockSync.failed > 0 && ` untuk ${summary.lastStockSync.failed} toko`}.
              </p>
              {summary.lastStockSync.errors.map((e, i) => (
                <p key={i} className="text-xs break-words [overflow-wrap:anywhere]">{e}</p>
              ))}
              <p className="text-xs opacity-80">
                Angka stok yang tidak terbaca dibiarkan seperti apa adanya — tidak ditulis nol.
              </p>
            </div>
          </div>
        </div>
      )}

      {/* Empty catalogue is the expected first state, not an error — say so
          rather than showing a bare table with nothing in it. */}
      {!loading && summary?.listings === 0 && (
        <div className="card p-6 text-center space-y-2">
          <Package className="w-8 h-8 mx-auto text-gray-400 dark:text-slate-500" />
          <p className="font-medium text-gray-900 dark:text-slate-100">Katalog masih kosong</p>
          <p className="text-sm text-gray-500 dark:text-slate-400">
            Tekan &ldquo;Tarik Katalog&rdquo; untuk mengambil produk dari Shopee. Ini hanya membaca —
            tidak ada perubahan yang dikirim ke marketplace.
          </p>
        </div>
      )}

      {summary && summary.listings > 0 && (
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
          <div className="card p-4">
            <p className="text-xs text-gray-500 dark:text-slate-400">Total Listing</p>
            <p className="text-2xl font-bold text-gray-900 dark:text-slate-100">{summary.listings.toLocaleString('id-ID')}</p>
          </div>
          <div className="card p-4">
            <p className="text-xs text-gray-500 dark:text-slate-400">Sudah Punya Master</p>
            <p className="text-2xl font-bold text-gray-900 dark:text-slate-100">{summary.mapped.toLocaleString('id-ID')}</p>
          </div>
          <div className="card p-4">
            <p className="text-xs text-gray-500 dark:text-slate-400">Belum Dipetakan</p>
            <p className="text-2xl font-bold text-amber-600 dark:text-amber-400">{summary.unmapped.toLocaleString('id-ID')}</p>
          </div>
          <div className="card p-4">
            <p className="text-xs text-gray-500 dark:text-slate-400">Master Produk</p>
            <p className="text-2xl font-bold text-gray-900 dark:text-slate-100">{summary.masters.toLocaleString('id-ID')}</p>
          </div>
        </div>
      )}

      <div className="card p-4 space-y-3">
        <div className="flex gap-2">
          <div className="relative flex-1">
            <Search className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" />
            <input
              value={searchInput}
              onChange={(e) => setSearchInput(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') setSearch(searchInput) }}
              placeholder="Cari nama produk atau SKU..."
              className="input pl-9 w-full"
            />
          </div>
          <button onClick={() => setSearch(searchInput)} className="btn-secondary flex items-center gap-2">
            <Search className="w-4 h-4" />
            <span>Cari</span>
          </button>
        </div>

        <div className="flex flex-wrap gap-2">
          <select value={storeId} onChange={(e) => setStoreId(e.target.value)} className="input">
            <option value="">Semua Toko</option>
            {stores.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
          </select>
          <select value={status} onChange={(e) => setStatus(e.target.value)} className="input">
            <option value="">Semua Status</option>
            <option value="NORMAL">Aktif</option>
            <option value="UNLIST">Diarsipkan</option>
          </select>
          <select value={mapped} onChange={(e) => setMapped(e.target.value)} className="input">
            <option value="">Semua Pemetaan</option>
            <option value="no">Belum punya master</option>
            <option value="yes">Sudah punya master</option>
          </select>
        </div>
      </div>

      {selected.length > 0 && (
        <div className="card p-3 flex flex-wrap items-center gap-2 border-blue-300 dark:border-blue-800 bg-blue-50 dark:bg-blue-900/20">
          <span className="text-sm font-medium text-blue-900 dark:text-blue-200 mr-1">
            {selected.length} listing dipilih
          </span>
          <button onClick={openCreateMaster} disabled={busy} className="btn-primary flex items-center gap-2">
            <Package className="w-4 h-4" />
            <span>Jadikan Master</span>
          </button>
          <button onClick={openMapExisting} disabled={busy} className="btn-secondary flex items-center gap-2">
            <Link2 className="w-4 h-4" />
            <span>Petakan ke Master</span>
          </button>
          <button onClick={handleUnmap} disabled={busy} className="btn-secondary flex items-center gap-2">
            <Link2Off className="w-4 h-4" />
            <span>Lepas Pemetaan</span>
          </button>
          <button onClick={() => setSelected([])} className="text-sm text-blue-800 dark:text-blue-300 underline ml-auto">
            Batal pilih
          </button>
        </div>
      )}

      <div className="card overflow-hidden">
        <div className="px-4 py-3 border-b border-gray-200 dark:border-slate-700 flex flex-wrap items-center justify-between gap-2">
          <span className="text-sm text-gray-500 dark:text-slate-400">
            {loading ? 'Memuat…' : `${total.toLocaleString('id-ID')} listing`}
          </span>
          <button onClick={handleAutomap} disabled={busy} className="btn-secondary flex items-center gap-2 text-sm">
            <Wand2 className="w-4 h-4" />
            <span>Petakan Otomatis dari SKU</span>
          </button>
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
                <th className="px-4 py-3">Produk</th>
                <th className="px-4 py-3">Toko</th>
                <th className="px-4 py-3">SKU</th>
                <th className="px-4 py-3">Master</th>
                <th className="px-4 py-3">Status</th>
                <th className="px-4 py-3 text-right">Harga</th>
                <th className="px-4 py-3 text-right">Stok</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-200 dark:divide-slate-700">
              {loading ? (
                <tr><td colSpan={8} className="px-4 py-8 text-center text-gray-500 dark:text-slate-400">Memuat…</td></tr>
              ) : listings.length === 0 ? (
                <tr><td colSpan={8} className="px-4 py-8 text-center text-gray-500 dark:text-slate-400">Tidak ada listing yang cocok dengan filter.</td></tr>
              ) : listings.map((l) => (
                <tr
                  key={l.id}
                  className={`hover:bg-gray-50 dark:hover:bg-slate-800/40 ${
                    selected.includes(l.id) ? 'bg-blue-50/60 dark:bg-blue-900/10' : ''
                  }`}
                >
                  <td className="px-4 py-3">
                    <input
                      type="checkbox"
                      checked={selected.includes(l.id)}
                      onChange={() => toggleRow(l.id)}
                      aria-label={`Pilih ${l.name}`}
                      className="rounded border-gray-300 dark:border-slate-600"
                    />
                  </td>
                  <td className="px-4 py-3">
                    <div className="flex items-center gap-3">
                      {l.imageUrl
                        // eslint-disable-next-line @next/next/no-img-element
                        ? <img src={l.imageUrl} alt="" className="w-10 h-10 rounded object-cover shrink-0" />
                        : <div className="w-10 h-10 rounded bg-gray-100 dark:bg-slate-700 shrink-0" />}
                      <span className="text-gray-900 dark:text-slate-100">{l.name}</span>
                    </div>
                  </td>
                  <td className="px-4 py-3 text-gray-600 dark:text-slate-300">{l.store?.name}</td>
                  <td className="px-4 py-3 font-mono text-xs text-gray-600 dark:text-slate-300">{l.sku || '—'}</td>
                  <td className="px-4 py-3">
                    {l.product ? (
                      <span className="font-mono text-xs text-gray-700 dark:text-slate-200">{l.product.masterSku}</span>
                    ) : (
                      <span className="inline-flex items-center gap-1 text-xs text-amber-600 dark:text-amber-400">
                        <Link2Off className="w-3 h-3" /> belum
                      </span>
                    )}
                  </td>
                  <td className="px-4 py-3">
                    <span className={`px-2 py-1 rounded text-xs font-medium ${statusClass[l.status] || statusClass.UNLIST}`}>
                      {statusLabels[l.status] || l.status}
                    </span>
                  </td>
                  <td className="px-4 py-3 text-right text-gray-700 dark:text-slate-200">{rupiah(l.price)}</td>
                  <td className="px-4 py-3 text-right">
                    {/* A blank stock is not zero. Shopee's response shape varies,
                        and showing 0 for "could not read it" reads as sold out. */}
                    {l.stock === null
                      ? <span className="inline-flex items-center gap-1 text-xs text-gray-400 dark:text-slate-500" title="Stok tidak terbaca dari Shopee">
                          <AlertTriangle className="w-3 h-3" /> ?
                        </span>
                      : <span className="text-gray-900 dark:text-slate-100">{l.stock}</span>}
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

      {modal === 'create' && (
        <div className="fixed inset-0 z-[70] flex items-center justify-center bg-black/40 p-4" onClick={() => setModal(null)}>
          <div className="card w-full max-w-lg p-5 space-y-4" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-start justify-between gap-4">
              <div>
                <h2 className="text-lg font-semibold text-gray-900 dark:text-slate-100">Jadikan Master</h2>
                <p className="text-sm text-gray-500 dark:text-slate-400">
                  {selected.length} listing akan diikat ke master ini.
                </p>
              </div>
              <button onClick={() => setModal(null)} className="text-gray-400 hover:text-gray-600">
                <X className="w-5 h-5" />
              </button>
            </div>

            <div className="space-y-3">
              <div>
                <label className="block text-sm font-medium text-gray-700 dark:text-slate-300 mb-1">
                  Nama SKU master
                </label>
                <input value={newSku} onChange={(e) => setNewSku(e.target.value)} className="input w-full font-mono text-sm" />
                <p className="text-xs text-gray-500 dark:text-slate-400 mt-1">
                  Harus sesuai nama produk Zaneva — ini yang dipakai untuk mencocokkan listing dari toko lain.
                </p>
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 dark:text-slate-300 mb-1">Nama produk</label>
                <input value={newName} onChange={(e) => setNewName(e.target.value)} className="input w-full" />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 dark:text-slate-300 mb-1">Stok</label>
                <input type="number" min={0} value={newStock} onChange={(e) => setNewStock(e.target.value)} className="input w-full" />
                <p className="text-xs text-gray-500 dark:text-slate-400 mt-1">
                  Diisi manual, seperti di Komplace. Angka ini tidak berkurang sendiri saat ada pesanan.
                </p>
              </div>
            </div>

            <div className="flex justify-end gap-2 pt-1">
              <button onClick={() => setModal(null)} className="btn-secondary">Batal</button>
              <button onClick={handleCreateMaster} disabled={busy || !newSku.trim()} className="btn-primary flex items-center gap-2">
                {busy && <Loader2 className="w-4 h-4 animate-spin" />}
                <span>Buat Master Produk</span>
              </button>
            </div>
          </div>
        </div>
      )}

      {modal === 'map' && (
        <div className="fixed inset-0 z-[70] flex items-center justify-center bg-black/40 p-4" onClick={() => setModal(null)}>
          <div className="card w-full max-w-lg p-5 space-y-4 max-h-[85vh] overflow-y-auto" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-start justify-between gap-4">
              <div>
                <h2 className="text-lg font-semibold text-gray-900 dark:text-slate-100">Petakan ke Master</h2>
                <p className="text-sm text-gray-500 dark:text-slate-400">
                  Pilih master untuk {selected.length} listing terpilih.
                </p>
              </div>
              <button onClick={() => setModal(null)} className="text-gray-400 hover:text-gray-600">
                <X className="w-5 h-5" />
              </button>
            </div>

            <div className="relative">
              <Search className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" />
              <input
                value={masterQuery}
                onChange={(e) => { setMasterQuery(e.target.value); searchMasters(e.target.value) }}
                placeholder="Cari SKU atau nama master…"
                className="input pl-9 w-full"
                autoFocus
              />
            </div>

            <div className="divide-y divide-gray-200 dark:divide-slate-700">
              {masterResults.length === 0 ? (
                <p className="py-6 text-center text-sm text-gray-500 dark:text-slate-400">
                  Belum ada master yang cocok. Pakai &ldquo;Jadikan Master&rdquo; untuk membuatnya.
                </p>
              ) : masterResults.map((m) => (
                <button
                  key={m.id}
                  onClick={() => handleMapExisting(m)}
                  disabled={busy}
                  className="w-full text-left py-3 px-1 hover:bg-gray-50 dark:hover:bg-slate-800/40 flex items-center justify-between gap-3"
                >
                  <span>
                    <span className="block font-mono text-sm text-gray-900 dark:text-slate-100">{m.masterSku}</span>
                    <span className="block text-xs text-gray-500 dark:text-slate-400">{m.name}</span>
                  </span>
                  <span className="text-xs text-gray-500 dark:text-slate-400 shrink-0">
                    stok {m.stock} · {m._count?.listings ?? 0} listing
                  </span>
                </button>
              ))}
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
