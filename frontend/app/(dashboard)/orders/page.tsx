'use client'

import { useEffect, useState, useCallback } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import api from '@/lib/api'
import {
  RefreshCw,
  Search,
  Printer,
  ChevronLeft,
  ChevronRight,
  Loader2,
  Package,
  Filter,
  X,
} from 'lucide-react'

interface Order {
  id: string
  orderId: string
  storeId: string
  storeName: string
  platform: 'SHOPEE' | 'TIKTOK'
  buyerName: string
  courier: string
  trackingNumber?: string
  status: string
  printed: boolean
  createdAt: string
}

interface OrdersResponse {
  data: Order[]
  total: number
  page: number
  limit: number
  counts: {
    belumDicetak: number
    sudahDicetak: number
    semua: number
  }
}

interface Store {
  id: string
  name: string
  platform: string
}

type PrintFilter = 'belum' | 'sudah' | 'semua'

const statusBadgeClass: Record<string, string> = {
  PENDING: 'badge-pending',
  PROCESSING: 'badge-processing',
  READY_TO_SHIP: 'badge-ready-to-ship',
  SHIPPED: 'badge-shipped',
  CANCELLED: 'badge-cancelled',
}

const platformBadgeClass: Record<string, string> = {
  SHOPEE: 'badge-shopee',
  TIKTOK: 'badge-tiktok',
}

export default function OrdersPage() {
  const router = useRouter()
  const searchParams = useSearchParams()

  const [orders, setOrders] = useState<Order[]>([])
  const [total, setTotal] = useState(0)
  const [counts, setCounts] = useState({ belumDicetak: 0, sudahDicetak: 0, semua: 0 })
  const [loading, setLoading] = useState(true)
  const [syncing, setSyncing] = useState(false)
  const [stores, setStores] = useState<Store[]>([])
  const [selected, setSelected] = useState<Set<string>>(new Set())

  // Filters
  const [printFilter, setPrintFilter] = useState<PrintFilter>(
    (searchParams.get('printFilter') as PrintFilter) || 'belum'
  )
  const [page, setPage] = useState(1)
  const [search, setSearch] = useState('')
  const [platform, setPlatform] = useState('')
  const [storeId, setStoreId] = useState('')
  const [status, setStatus] = useState('')
  const [courier, setCourier] = useState('')
  const [dateFrom, setDateFrom] = useState('')
  const [dateTo, setDateTo] = useState('')

  const limit = 20

  const fetchOrders = useCallback(async () => {
    setLoading(true)
    try {
      const params: any = {
        page,
        limit,
        printFilter,
      }
      if (search) params.search = search
      if (platform) params.platform = platform
      if (storeId) params.storeId = storeId
      if (status) params.status = status
      if (courier) params.courier = courier
      if (dateFrom) params.dateFrom = dateFrom
      if (dateTo) params.dateTo = dateTo

      const res = await api.get<any>('/orders', { params })
      const data = res.data || {}
      const rawOrders = Array.isArray(data) ? data : (data.orders || data.data || [])
      const totalCount = data.pagination?.total ?? data.total ?? rawOrders.length ?? 0
      const rawCounts = data.counts || {}
      const normalizedCounts = {
        belumDicetak: rawCounts.unprinted ?? rawCounts.belumDicetak ?? 0,
        sudahDicetak: rawCounts.printed ?? rawCounts.sudahDicetak ?? 0,
        semua: rawCounts.all ?? rawCounts.semua ?? ((rawCounts.unprinted || 0) + (rawCounts.printed || 0)),
      }

      const formattedOrders = rawOrders.map((o: any) => ({
        ...o,
        storeName: o.storeName || o.store?.name || 'Toko',
        platform: o.platform || o.store?.platform || 'SHOPEE',
        courier: o.courier || o.shippingCourier || '-',
        printed: o.printed !== undefined ? o.printed : Boolean(o.printedAt),
      }))

      setOrders(formattedOrders)
      setTotal(totalCount)
      setCounts(normalizedCounts)
    } catch (err) {
      console.error('Failed to fetch orders', err)
      setOrders([])
    } finally {
      setLoading(false)
    }
  }, [page, printFilter, search, platform, storeId, status, courier, dateFrom, dateTo])

  const fetchStores = async () => {
    try {
      const res = await api.get<any>('/stores')
      const storeData = Array.isArray(res.data) ? res.data : (res.data?.data || [])
      setStores(Array.isArray(storeData) ? storeData : [])
    } catch {
      setStores([])
    }
  }

  useEffect(() => {
    fetchStores()
  }, [])

  useEffect(() => {
    fetchOrders()
  }, [fetchOrders])

  useEffect(() => {
    setSelected(new Set())
  }, [printFilter, page])

  const handleSync = async () => {
    setSyncing(true)
    try {
      await api.post('/orders/sync')
      await fetchOrders()
    } catch (err) {
      console.error('Sync failed', err)
    } finally {
      setSyncing(false)
    }
  }

  const handlePrintFilterChange = (filter: PrintFilter) => {
    setPrintFilter(filter)
    setPage(1)
    const params = new URLSearchParams(searchParams.toString())
    params.set('printFilter', filter)
    router.push(`/orders?${params.toString()}`)
  }

  const isCheckboxEnabled = (order: Order) => {
    if (printFilter === 'belum') return !!order.trackingNumber
    if (printFilter === 'sudah') return false
    return !order.printed
  }

  const toggleSelect = (orderId: string) => {
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(orderId)) next.delete(orderId)
      else next.add(orderId)
      return next
    })
  }

  const toggleSelectAll = () => {
    const enabledOrders = orders.filter(isCheckboxEnabled)
    if (enabledOrders.length === 0) return

    const allSelected = enabledOrders.every((o) => selected.has(o.id))
    if (allSelected) {
      setSelected(new Set())
    } else {
      setSelected(new Set(enabledOrders.map((o) => o.id)))
    }
  }

  const selectedOrders = orders.filter((o) => selected.has(o.id))
  const selectedPlatforms = new Set(selectedOrders.map((o) => o.platform))
  const shopeeCount = selectedOrders.filter((o) => o.platform === 'SHOPEE').length
  const tiktokCount = selectedOrders.filter((o) => o.platform === 'TIKTOK').length

  const handlePrint = (platformFilter: string) => {
    const ids = selectedOrders
      .filter((o) => o.platform === platformFilter)
      .map((o) => o.id)
    router.push(`/print?ids=${ids.join(',')}`)
  }

  const handleSearch = (e: React.FormEvent) => {
    e.preventDefault()
    setPage(1)
    fetchOrders()
  }

  const clearFilters = () => {
    setSearch('')
    setPlatform('')
    setStoreId('')
    setStatus('')
    setCourier('')
    setDateFrom('')
    setDateTo('')
    setPage(1)
  }

  const hasActiveFilters = platform || storeId || status || courier || dateFrom || dateTo || search
  const totalPages = Math.ceil(total / limit)

  return (
    <div className="space-y-4">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold text-gray-900 dark:text-slate-100">Pesanan</h1>
          <p className="text-sm text-gray-500 dark:text-slate-400 mt-0.5">Kelola semua pesanan dari berbagai marketplace</p>
        </div>
        <button onClick={handleSync} disabled={syncing} className="btn-primary self-start sm:self-auto flex items-center gap-2">
          {syncing ? (
            <Loader2 className="w-4 h-4 animate-spin" />
          ) : (
            <RefreshCw className="w-4 h-4" />
          )}
          <span>Sync Pesanan</span>
        </button>
      </div>

      {/* Print Filter Tabs */}
      <div className="card p-1">
        <div className="flex gap-1 overflow-x-auto">
          {([
            { key: 'belum' as PrintFilter, label: 'Belum Dicetak', count: counts.belumDicetak },
            { key: 'sudah' as PrintFilter, label: 'Sudah Dicetak', count: counts.sudahDicetak },
            { key: 'semua' as PrintFilter, label: 'Semua', count: counts.semua },
          ]).map((tab) => (
            <button
              key={tab.key}
              onClick={() => handlePrintFilterChange(tab.key)}
              className={`flex-1 py-2.5 px-3 sm:px-4 rounded-lg text-xs sm:text-sm font-medium transition-colors whitespace-nowrap ${
                printFilter === tab.key
                  ? 'bg-primary-600 text-white shadow-sm dark:bg-primary-600'
                  : 'text-gray-600 dark:text-slate-300 hover:bg-gray-50 dark:hover:bg-slate-700/60'
              }`}
            >
              {tab.label}
              <span className={`ml-2 px-2 py-0.5 rounded-full text-xs ${
                printFilter === tab.key
                  ? 'bg-white/20 text-white'
                  : 'bg-gray-100 dark:bg-slate-700 text-gray-600 dark:text-slate-300'
              }`}>
                {tab.count}
              </span>
            </button>
          ))}
        </div>
      </div>

      {/* Filters */}
      <div className="card p-4">
        <form onSubmit={handleSearch} className="space-y-3">
          {/* Search bar */}
          <div className="flex flex-col sm:flex-row gap-2 sm:gap-3">
            <div className="flex-1 relative">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400 dark:text-slate-500" />
              <input
                type="text"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Cari order ID, nama buyer..."
                className="input pl-10"
              />
            </div>
            <div className="flex gap-2">
              <button type="submit" className="btn-secondary flex-1 sm:flex-none">
                <Search className="w-4 h-4" />
                Cari
              </button>
              {hasActiveFilters && (
                <button type="button" onClick={clearFilters} className="btn-ghost text-red-600 dark:text-red-400 flex-1 sm:flex-none">
                  <X className="w-4 h-4" />
                  Reset
                </button>
              )}
            </div>
          </div>

          {/* Filter row */}
          <div className="grid grid-cols-2 sm:grid-cols-3 lg:flex lg:flex-wrap gap-2.5">
            <select value={platform} onChange={(e) => { setPlatform(e.target.value); setPage(1) }} className="input w-full lg:w-auto min-w-[130px]">
              <option value="">Semua Platform</option>
              <option value="SHOPEE">Shopee</option>
              <option value="TIKTOK">TikTok</option>
            </select>

            <select value={storeId} onChange={(e) => { setStoreId(e.target.value); setPage(1) }} className="input w-full lg:w-auto min-w-[150px]">
              <option value="">Semua Toko</option>
              {stores.map((s) => (
                <option key={s.id} value={s.id}>{s.name}</option>
              ))}
            </select>

            <select value={status} onChange={(e) => { setStatus(e.target.value); setPage(1) }} className="input w-full lg:w-auto min-w-[140px]">
              <option value="">Semua Status</option>
              <option value="PENDING">Pending</option>
              <option value="PROCESSING">Diproses</option>
              <option value="READY_TO_SHIP">Siap Kirim</option>
              <option value="SHIPPED">Dikirim</option>
              <option value="CANCELLED">Dibatalkan</option>
            </select>

            <input
              type="text"
              value={courier}
              onChange={(e) => { setCourier(e.target.value); setPage(1) }}
              placeholder="Kurir"
              className="input w-full lg:w-auto min-w-[110px]"
            />

            <input
              type="date"
              value={dateFrom}
              onChange={(e) => { setDateFrom(e.target.value); setPage(1) }}
              className="input w-full lg:w-auto"
              placeholder="Dari"
            />

            <input
              type="date"
              value={dateTo}
              onChange={(e) => { setDateTo(e.target.value); setPage(1) }}
              className="input w-full lg:w-auto"
              placeholder="Sampai"
            />
          </div>
        </form>
      </div>

      {/* Table */}
      <div className="card overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full">
            <thead className="bg-gray-50 dark:bg-slate-800/80 border-b border-gray-200 dark:border-slate-700">
              <tr>
                <th className="table-header w-10">
                  <input
                    type="checkbox"
                    checked={
                      orders.filter(isCheckboxEnabled).length > 0 &&
                      orders.filter(isCheckboxEnabled).every((o) => selected.has(o.id))
                    }
                    onChange={toggleSelectAll}
                    className="rounded border-gray-300 text-primary-600 focus:ring-primary-500"
                  />
                </th>
                <th className="table-header">Order ID</th>
                <th className="table-header">Toko</th>
                <th className="table-header">Platform</th>
                <th className="table-header">Pembeli</th>
                <th className="table-header">Kurir</th>
                <th className="table-header">Status</th>
                <th className="table-header">Tanggal</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100 dark:divide-slate-700/60">
              {loading ? (
                <tr>
                  <td colSpan={8} className="px-4 py-16 text-center">
                    <Loader2 className="w-8 h-8 animate-spin text-primary-600 mx-auto" />
                    <p className="text-sm text-gray-500 dark:text-slate-400 mt-2">Memuat pesanan...</p>
                  </td>
                </tr>
              ) : orders.length === 0 ? (
                <tr>
                  <td colSpan={8} className="px-4 py-16 text-center">
                    <Package className="w-12 h-12 text-gray-300 dark:text-slate-600 mx-auto mb-3" />
                    <p className="font-medium text-gray-900 dark:text-slate-200">Tidak ada pesanan</p>
                    <p className="text-sm text-gray-500 dark:text-slate-400 mt-1">
                      {hasActiveFilters
                        ? 'Coba ubah filter atau kata kunci pencarian'
                        : 'Klik "Sync" untuk mengambil pesanan terbaru'}
                    </p>
                  </td>
                </tr>
              ) : (
                orders.map((order) => {
                  const enabled = isCheckboxEnabled(order)
                  return (
                    <tr key={order.id} className="hover:bg-gray-50 dark:hover:bg-slate-700/40 transition-colors">
                      <td className="table-cell">
                        {printFilter === 'sudah' && order.printed ? (
                          <div className="flex items-center gap-2">
                            <span className="text-xs text-gray-400">Sudah dicetak</span>
                            <button
                              onClick={() => router.push(`/print?ids=${order.id}&reprint=true`)}
                              className="text-xs text-primary-600 hover:text-primary-700 underline"
                            >
                              Cetak ulang
                            </button>
                          </div>
                        ) : (
                          <input
                            type="checkbox"
                            checked={selected.has(order.id)}
                            onChange={() => toggleSelect(order.id)}
                            disabled={!enabled}
                            className="rounded border-gray-300 text-primary-600 focus:ring-primary-500 disabled:opacity-40"
                          />
                        )}
                      </td>
                      <td className="table-cell font-mono text-sm font-medium text-gray-900 dark:text-slate-100">
                        {order.orderId}
                      </td>
                      <td className="table-cell">{order.storeName}</td>
                      <td className="table-cell">
                        <span className={platformBadgeClass[order.platform] || 'badge'}>
                          {order.platform}
                        </span>
                      </td>
                      <td className="table-cell">{order.buyerName}</td>
                      <td className="table-cell">
                        <div>
                          <p>{order.courier}</p>
                          {order.trackingNumber && (
                            <p className="text-xs text-gray-400 dark:text-slate-500 font-mono">{order.trackingNumber}</p>
                          )}
                        </div>
                      </td>
                      <td className="table-cell">
                        <span className={statusBadgeClass[order.status] || 'badge'}>
                          {order.status.replace(/_/g, ' ')}
                        </span>
                      </td>
                      <td className="table-cell text-gray-500 dark:text-slate-400">
                        {new Date(order.createdAt).toLocaleDateString('id-ID', {
                          day: '2-digit',
                          month: 'short',
                          year: 'numeric',
                        })}
                      </td>
                    </tr>
                  )
                })
              )}
            </tbody>
          </table>
        </div>

        {/* Pagination */}
        {totalPages > 1 && (
          <div className="px-4 py-3 border-t border-gray-200 dark:border-slate-700 flex items-center justify-between bg-gray-50 dark:bg-slate-800/80">
            <p className="text-sm text-gray-500 dark:text-slate-400">
              Menampilkan {(page - 1) * limit + 1}–{Math.min(page * limit, total)} dari {total} pesanan
            </p>
            <div className="flex items-center gap-1">
              <button
                onClick={() => setPage((p) => Math.max(1, p - 1))}
                disabled={page === 1}
                className="btn-ghost p-2"
              >
                <ChevronLeft className="w-4 h-4" />
              </button>
              {Array.from({ length: Math.min(5, totalPages) }, (_, i) => {
                const pageNum = Math.max(1, Math.min(page - 2, totalPages - 4)) + i
                if (pageNum > totalPages) return null
                return (
                  <button
                    key={pageNum}
                    onClick={() => setPage(pageNum)}
                    className={`w-9 h-9 rounded-lg text-sm font-medium transition-colors ${
                      page === pageNum
                        ? 'bg-primary-600 text-white'
                        : 'text-gray-600 dark:text-slate-400 hover:bg-gray-100 dark:hover:bg-slate-700'
                    }`}
                  >
                    {pageNum}
                  </button>
                )
              })}
              <button
                onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
                disabled={page === totalPages}
                className="btn-ghost p-2"
              >
                <ChevronRight className="w-4 h-4" />
              </button>
            </div>
          </div>
        )}
      </div>

      {/* Selection Bar */}
      {selected.size > 0 && (
        <div className="fixed bottom-0 left-64 right-0 bg-white dark:bg-slate-800 border-t border-gray-200 dark:border-slate-700 shadow-lg px-6 py-4 z-20">
          <div className="flex items-center justify-between">
            <div className="text-sm text-gray-700 dark:text-slate-300">
              <span className="font-semibold">{selected.size} pesanan</span> dipilih
              {selectedPlatforms.size > 0 && (
                <span className="text-gray-500 dark:text-slate-400">
                  {' '}({Array.from(selectedPlatforms).join(', ')})
                </span>
              )}
            </div>
            <div className="flex items-center gap-3">
              {shopeeCount > 0 && (
                <button onClick={() => handlePrint('SHOPEE')} className="btn bg-shopee text-white hover:bg-orange-600">
                  <Printer className="w-4 h-4" />
                  Cetak Resi Shopee ({shopeeCount})
                </button>
              )}
              {tiktokCount > 0 && (
                <button onClick={() => handlePrint('TIKTOK')} className="btn bg-tiktok text-white hover:bg-gray-800">
                  <Printer className="w-4 h-4" />
                  Cetak Resi TikTok ({tiktokCount})
                </button>
              )}
              <button onClick={() => setSelected(new Set())} className="btn-ghost text-gray-500 dark:text-slate-400">
                <X className="w-4 h-4" />
                Batal
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
