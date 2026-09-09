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

interface Summary {
  listings: number
  unmapped: number
  mapped: number
  masters: number
  lastSyncedAt: string | null
  lastPull: LastPull | null
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
        </div>
        <button
          onClick={handleSync}
          disabled={syncing}
          className="btn-primary self-start flex items-center gap-2"
        >
          {syncing ? <Loader2 className="w-4 h-4 animate-spin" /> : <RefreshCw className="w-4 h-4" />}
          <span>{storeId ? 'Tarik Katalog Toko Ini' : 'Tarik Katalog'}</span>
        </button>
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

      <div className="card overflow-hidden">
        <div className="px-4 py-3 border-b border-gray-200 dark:border-slate-700 text-sm text-gray-500 dark:text-slate-400">
          {loading ? 'Memuat…' : `${total.toLocaleString('id-ID')} listing`}
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-gray-50 dark:bg-slate-800/60 text-left text-xs uppercase text-gray-500 dark:text-slate-400">
              <tr>
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
                <tr><td colSpan={7} className="px-4 py-8 text-center text-gray-500 dark:text-slate-400">Memuat…</td></tr>
              ) : listings.length === 0 ? (
                <tr><td colSpan={7} className="px-4 py-8 text-center text-gray-500 dark:text-slate-400">Tidak ada listing yang cocok dengan filter.</td></tr>
              ) : listings.map((l) => (
                <tr key={l.id} className="hover:bg-gray-50 dark:hover:bg-slate-800/40">
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
    </div>
  )
}
