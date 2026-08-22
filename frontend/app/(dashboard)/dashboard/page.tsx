'use client'

import { useEffect, useState, useCallback } from 'react'
import api from '@/lib/api'
import {
  Package,
  PackageCheck,
  Truck,
  AlertTriangle,
  RefreshCw,
  Store,
  Loader2,
  ShoppingBag,
  Ban,
  Info,
} from 'lucide-react'

interface DashboardStats {
  toShip: number
  awaitingPickup: number
  shipped: number
  needsAttention: number
  cancelled: number
  unpaid: number
  completed: number
}

interface StoreInfo {
  id: string
  name: string
  platform: 'SHOPEE' | 'TIKTOK'
  orderCount: number
  packageCount: number
  status: 'ACTIVE' | 'PARTIAL' | 'EXPIRED' | 'ERROR'
  tokenExpiry: string | null
  lastSyncAt: string | null
  lastSyncError: string | null
}

type StatsBasis = 'created' | 'paid' | 'completed'

/** Which orders a statistics run counts — mirrors Shopee's "Status Pesanan". */
const BASIS_OPTIONS: { key: StatsBasis; label: string; hint: string }[] = [
  { key: 'created',   label: 'Pesanan Dibuat',       hint: 'Semua pesanan yang masuk di periode ini' },
  { key: 'paid',      label: 'Pesanan Siap Dikirim', hint: 'Sudah dibayar — tanpa yang belum bayar & dibatalkan' },
  { key: 'completed', label: 'Pesanan Selesai',      hint: 'Hanya pesanan yang sudah selesai' },
]

/** Labels for the status breakdown, in the order an order moves through them. */
const BUCKET_LABELS: { key: keyof Statistics['breakdown']; label: string }[] = [
  { key: 'unpaid',         label: 'Belum Bayar' },
  { key: 'toShip',         label: 'Siap Kirim' },
  { key: 'awaitingPickup', label: 'Menunggu Pickup' },
  { key: 'needsAttention', label: 'Perlu Tindakan' },
  { key: 'shipped',        label: 'Dikirim' },
  { key: 'completed',      label: 'Selesai' },
  { key: 'cancelled',      label: 'Dibatalkan' },
]

interface Statistics {
  basis: StatsBasis
  /** What each basis would report, so the panel can show the alternatives. */
  basisCounts: Record<StatsBasis, number>
  breakdown: {
    toShip: number
    awaitingPickup: number
    shipped: number
    needsAttention: number
    cancelled: number
    unpaid: number
    completed: number
  }
  orderCount: number
  packageCount: number
  readyToShipCount: number
  shippedCount: number
  cancelledCount: number
  completedCount: number
  totalValue: number
  completedValue: number
  cancelledValue: number
  averageOrderValue: number
  valueBasis: string
}

const rupiah = (value: number) =>
  new Intl.NumberFormat('id-ID', {
    style: 'currency',
    currency: 'IDR',
    maximumFractionDigits: 0,
  }).format(value || 0)

/** YYYY-MM-DD in local time — `toISOString` would shift a WIB date back a day. */
const isoDate = (d: Date) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`

const statusColors: Record<string, string> = {
  ACTIVE: 'bg-green-100 text-green-700 dark:bg-green-950/60 dark:text-green-300',
  PARTIAL: 'bg-amber-100 text-amber-700 dark:bg-amber-950/60 dark:text-amber-300',
  EXPIRED: 'bg-yellow-100 text-yellow-700 dark:bg-yellow-950/60 dark:text-yellow-300',
  ERROR: 'bg-red-100 text-red-700 dark:bg-red-950/60 dark:text-red-300',
}

const statusLabels: Record<string, string> = {
  ACTIVE: 'AKTIF',
  // The run finished; some statuses simply were not refreshed
  PARTIAL: 'SYNC SEBAGIAN',
  EXPIRED: 'PERLU HUBUNGKAN ULANG',
  ERROR: 'SYNC GAGAL',
}

export default function DashboardPage() {
  const [stats, setStats] = useState<DashboardStats | null>(null)
  const [stores, setStores] = useState<StoreInfo[]>([])
  const [loading, setLoading] = useState(true)
  const [syncing, setSyncing] = useState(false)

  // Statistics panel — filtered independently of the operational tiles above,
  // which always describe the whole backlog rather than a period.
  const today = isoDate(new Date())
  const [statsFrom, setStatsFrom] = useState(today)
  const [statsTo, setStatsTo] = useState(today)
  const [statsPlatform, setStatsPlatform] = useState('')
  const [statsStoreId, setStatsStoreId] = useState('')
  // Defaults to the paid orders: that is the number the team treats as real,
  // since an unpaid order can still evaporate.
  const [statsBasis, setStatsBasis] = useState<StatsBasis>('paid')
  // Optional cut-off on the last day, so a partial day can be compared against
  // Seller Centre's own real-time window ("Hari Ini - Pk 15:00"). Empty means
  // the whole day.
  const [statsUntil, setStatsUntil] = useState('')
  const [statistics, setStatistics] = useState<Statistics | null>(null)
  const [statsLoading, setStatsLoading] = useState(false)

  /**
   * How current the statistics really are.
   *
   * Seller Centre is real-time and says so ("Hari Ini - Pk 15:00"); ours is
   * only as fresh as the last sync, and on several stores only as fresh as
   * whichever one lagged furthest behind. Without this the hour filter would
   * promise a precision the data does not have.
   */
  const dataUpTo = (() => {
    const inScope = stores.filter((s) =>
      (!statsPlatform || s.platform === statsPlatform) &&
      (!statsStoreId || s.id === statsStoreId))
    const times = inScope.map((s) => s.lastSyncAt).filter((t): t is string => Boolean(t))
    if (times.length === 0) return null
    return times.reduce((oldest, t) => (new Date(t) < new Date(oldest) ? t : oldest))
  })()

  const fetchDashboard = async () => {
    try {
      const [statsRes, storesRes] = await Promise.all([
        api.get('/dashboard/stats'),
        api.get('/dashboard/stores'),
      ])
      setStats(statsRes.data)
      setStores(storesRes.data)
    } catch (err) {
      console.error('Failed to load dashboard', err)
    } finally {
      setLoading(false)
    }
  }

  const fetchStatistics = useCallback(async () => {
    setStatsLoading(true)
    try {
      const params: Record<string, string> = {}
      if (statsFrom) params.dateFrom = statsFrom
      if (statsTo) params.dateTo = statsUntil ? `${statsTo}T${statsUntil}` : statsTo
      if (statsPlatform) params.platform = statsPlatform
      if (statsStoreId) params.storeId = statsStoreId
      params.basis = statsBasis

      const res = await api.get<Statistics>('/dashboard/statistics', { params })
      setStatistics(res.data)
    } catch (err) {
      console.error('Failed to load statistics', err)
      setStatistics(null)
    } finally {
      setStatsLoading(false)
    }
  }, [statsFrom, statsTo, statsUntil, statsPlatform, statsStoreId, statsBasis])

  useEffect(() => {
    fetchDashboard()
  }, [])

  useEffect(() => {
    fetchStatistics()
  }, [fetchStatistics])

  const handleSync = async () => {
    setSyncing(true)
    try {
      await api.post('/orders/sync')
      await Promise.all([fetchDashboard(), fetchStatistics()])
    } catch (err) {
      console.error('Sync failed', err)
    } finally {
      setSyncing(false)
    }
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <Loader2 className="w-8 h-8 animate-spin text-primary-600 dark:text-primary-400" />
      </div>
    )
  }

  // Buckets mirror the platform's real order statuses (KB §2.1) — the old
  // Pending/Diproses tiles counted statuses Shopee never sends.
  const summaryCards = [
    {
      label: 'Siap Kirim',
      value: stats?.toShip ?? 0,
      icon: Package,
      color: 'text-amber-600 dark:text-amber-400',
      iconBg: 'bg-amber-100 dark:bg-amber-950/70',
    },
    {
      label: 'Menunggu Pickup',
      value: stats?.awaitingPickup ?? 0,
      icon: PackageCheck,
      color: 'text-blue-600 dark:text-blue-400',
      iconBg: 'bg-blue-100 dark:bg-blue-950/70',
    },
    {
      label: 'Dikirim',
      value: stats?.shipped ?? 0,
      icon: Truck,
      color: 'text-emerald-600 dark:text-emerald-400',
      iconBg: 'bg-emerald-100 dark:bg-emerald-950/70',
    },
    {
      label: 'Perlu Tindakan',
      value: stats?.needsAttention ?? 0,
      icon: AlertTriangle,
      color: 'text-rose-600 dark:text-rose-400',
      iconBg: 'bg-rose-100 dark:bg-rose-950/70',
    },
  ]

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold text-gray-900 dark:text-slate-100">Dashboard</h1>
          <p className="text-sm text-gray-500 dark:text-slate-400 mt-1">Ringkasan pesanan & status toko Anda</p>
        </div>
        <button onClick={handleSync} disabled={syncing} className="btn-primary self-start sm:self-auto">
          {syncing ? (
            <Loader2 className="w-4 h-4 animate-spin" />
          ) : (
            <RefreshCw className="w-4 h-4" />
          )}
          Sync Pesanan
        </button>
      </div>

      {/* Summary Cards */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 sm:gap-4">
        {summaryCards.map((card) => {
          const Icon = card.icon
          return (
            <div key={card.label} className="card p-4 sm:p-5">
              <div className="flex flex-col sm:flex-row items-start sm:items-center gap-3 sm:gap-4">
                <div className={`w-10 h-10 sm:w-12 sm:h-12 rounded-xl flex items-center justify-center shrink-0 ${card.iconBg}`}>
                  <Icon className={`w-5 h-5 sm:w-6 sm:h-6 ${card.color}`} />
                </div>
                <div>
                  <p className="text-xs sm:text-sm text-gray-500 dark:text-slate-400">{card.label}</p>
                  <p className="text-xl sm:text-2xl font-bold text-gray-900 dark:text-slate-100">{card.value.toLocaleString()}</p>
                </div>
              </div>
            </div>
          )
        })}
      </div>

      {/* Statistics. Filtered by period, unlike the tiles above which always
          describe the whole backlog. */}
      <div className="card">
        <div className="px-4 sm:px-6 py-4 border-b border-gray-200 dark:border-slate-700 flex flex-col lg:flex-row lg:items-center justify-between gap-3">
          <div>
            <h2 className="text-lg font-semibold text-gray-900 dark:text-slate-100">Statistik</h2>
            <p className="text-xs text-gray-500 dark:text-slate-400 mt-0.5">
              {dataUpTo
                ? `Data s/d pukul ${new Date(dataUpTo).toLocaleTimeString('id-ID', {
                    hour: '2-digit', minute: '2-digit',
                  })} (sync terakhir)`
                : 'Belum pernah disinkronkan'}
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <input
              type="date"
              className="input w-auto"
              value={statsFrom}
              max={statsTo || undefined}
              onChange={(e) => setStatsFrom(e.target.value)}
              aria-label="Tanggal mulai"
            />
            <span className="text-gray-400 dark:text-slate-500 text-sm">–</span>
            <input
              type="date"
              className="input w-auto"
              value={statsTo}
              min={statsFrom || undefined}
              onChange={(e) => setStatsTo(e.target.value)}
              aria-label="Tanggal akhir"
            />
            <input
              type="time"
              className="input w-auto"
              value={statsUntil}
              onChange={(e) => setStatsUntil(e.target.value)}
              aria-label="Sampai jam"
              title="Batas jam pada tanggal akhir. Kosong berarti sampai akhir hari."
            />
            <select
              className="input w-auto"
              value={statsBasis}
              onChange={(e) => setStatsBasis(e.target.value as StatsBasis)}
              aria-label="Status pesanan"
              title={BASIS_OPTIONS.find((o) => o.key === statsBasis)?.hint}
            >
              {BASIS_OPTIONS.map((o) => (
                <option key={o.key} value={o.key}>{o.label}</option>
              ))}
            </select>
            <select
              className="input w-auto"
              value={statsPlatform}
              onChange={(e) => {
                setStatsPlatform(e.target.value)
                setStatsStoreId('') // the chosen store may belong to the other platform
              }}
              aria-label="Platform"
            >
              <option value="">Semua Platform</option>
              <option value="SHOPEE">Shopee</option>
              <option value="TIKTOK">TikTok</option>
            </select>
            <select
              className="input w-auto"
              value={statsStoreId}
              onChange={(e) => setStatsStoreId(e.target.value)}
              aria-label="Toko"
            >
              <option value="">Semua Toko</option>
              {stores
                .filter((s) => !statsPlatform || s.platform === statsPlatform)
                .map((s) => (
                  <option key={s.id} value={s.id}>{s.name}</option>
                ))}
            </select>
          </div>
        </div>

        <div className="p-4 sm:p-6 space-y-4">
          {statsLoading && !statistics ? (
            <div className="flex items-center gap-2 text-sm text-gray-500 dark:text-slate-400 py-6">
              <Loader2 className="w-4 h-4 animate-spin" /> Menghitung…
            </div>
          ) : (
            <>
              <div className={`grid grid-cols-2 lg:grid-cols-4 gap-3 sm:gap-4 ${statsLoading ? 'opacity-60' : ''}`}>
                {[
                  { label: 'Nilai Total Pesanan', value: statistics?.totalValue ?? 0 },
                  { label: 'Nilai Pesanan Selesai', value: statistics?.completedValue ?? 0 },
                  { label: 'Nilai Pesanan Dibatalkan', value: statistics?.cancelledValue ?? 0 },
                  { label: 'Rata-rata per Pesanan', value: statistics?.averageOrderValue ?? 0 },
                ].map((card) => (
                  <div key={card.label} className="rounded-xl border border-gray-200 dark:border-slate-700 p-4">
                    <p className="text-xs text-gray-500 dark:text-slate-400">{card.label}</p>
                    <p className="text-lg sm:text-xl font-bold text-gray-900 dark:text-slate-100 mt-1 break-words">
                      {rupiah(card.value)}
                    </p>
                  </div>
                ))}
              </div>

              <div className={`grid grid-cols-2 lg:grid-cols-4 gap-3 sm:gap-4 ${statsLoading ? 'opacity-60' : ''}`}>
                {[
                  {
                    label: 'Jumlah Pesanan',
                    value: statistics?.orderCount ?? 0,
                    icon: ShoppingBag,
                    // The primary scale stops at 900 (tailwind.config.ts), so
                    // no 950 here — it would silently generate nothing.
                    color: 'text-primary-600 dark:text-primary-400',
                    iconBg: 'bg-primary-100 dark:bg-primary-900/50',
                  },
                  {
                    label: 'Pesanan Siap Dikirim',
                    value: statistics?.readyToShipCount ?? 0,
                    icon: Package,
                    color: 'text-amber-600 dark:text-amber-400',
                    iconBg: 'bg-amber-100 dark:bg-amber-950/70',
                  },
                  {
                    label: 'Pesanan Dikirim',
                    value: statistics?.shippedCount ?? 0,
                    icon: Truck,
                    color: 'text-emerald-600 dark:text-emerald-400',
                    iconBg: 'bg-emerald-100 dark:bg-emerald-950/70',
                  },
                  {
                    label: 'Pesanan Dibatalkan',
                    value: statistics?.cancelledCount ?? 0,
                    icon: Ban,
                    color: 'text-rose-600 dark:text-rose-400',
                    iconBg: 'bg-rose-100 dark:bg-rose-950/70',
                  },
                ].map((card) => {
                  const Icon = card.icon
                  return (
                    <div
                      key={card.label}
                      className="rounded-xl border border-gray-200 dark:border-slate-700 p-4 flex items-center justify-between gap-3"
                    >
                      <div>
                        <p className="text-xl sm:text-2xl font-bold text-gray-900 dark:text-slate-100">
                          {card.value.toLocaleString('id-ID')}
                        </p>
                        <p className="text-xs text-gray-500 dark:text-slate-400 mt-0.5">{card.label}</p>
                      </div>
                      <div className={`w-9 h-9 rounded-lg flex items-center justify-center shrink-0 ${card.iconBg}`}>
                        <Icon className={`w-4 h-4 ${card.color}`} />
                      </div>
                    </div>
                  )
                })}
              </div>

              {/* The headline count, broken down until it adds up. Four tiles
                  used to account for 11 of 43 orders, with PROCESSED and UNPAID
                  invisible — which is what made the total look wrong rather
                  than merely unexplained. */}
              {statistics && (
                <div className="rounded-xl border border-gray-200 dark:border-slate-700 p-4 space-y-2.5">
                  <p className="text-xs text-gray-500 dark:text-slate-400">
                    Rincian {statistics.orderCount.toLocaleString('id-ID')} pesanan pada dasar{' '}
                    <span className="font-medium text-gray-700 dark:text-slate-200">
                      {BASIS_OPTIONS.find((o) => o.key === statistics.basis)?.label}
                    </span>
                  </p>
                  {statistics.orderCount === 0 ? (
                    <p className="text-sm text-gray-500 dark:text-slate-400">Tidak ada pesanan di periode ini.</p>
                  ) : (
                    <div className="flex flex-wrap gap-x-5 gap-y-2">
                      {BUCKET_LABELS.filter((b) => statistics.breakdown[b.key] > 0).map((b) => (
                        <span key={b.key} className="text-sm text-gray-700 dark:text-slate-300">
                          {b.label}{' '}
                          <span className="font-semibold text-gray-900 dark:text-slate-100">
                            {statistics.breakdown[b.key].toLocaleString('id-ID')}
                          </span>
                        </span>
                      ))}
                    </div>
                  )}
                  {/* Seller Centre reports a different number per basis, so the
                      others are shown here rather than leaving a mismatch to be
                      discovered against Shopee. */}
                  <p className="text-xs text-gray-500 dark:text-slate-400">
                    Dasar lain:{' '}
                    {BASIS_OPTIONS.filter((o) => o.key !== statistics.basis)
                      .map((o) => `${o.label} ${(statistics.basisCounts?.[o.key] ?? 0).toLocaleString('id-ID')}`)
                      .join(' · ')}
                  </p>
                </div>
              )}

              {/* The schema has no order-total column, so these are item
                  subtotals. Saying so beats letting them be read as payouts. */}
              <p className="text-xs text-gray-500 dark:text-slate-400 flex items-start gap-1.5">
                <Info className="w-3.5 h-3.5 shrink-0 mt-0.5" />
                <span>
                  Nilai dihitung dari subtotal item (harga × jumlah), belum termasuk ongkir, voucher, atau potongan
                  platform. Angka bersih setelah biaya Shopee perlu API escrow yang belum terhubung. Jumlah pesanan
                  dihitung per pesanan, bukan per paket
                  {statistics && statistics.packageCount > statistics.orderCount
                    ? ` (${statistics.packageCount.toLocaleString('id-ID')} paket di periode ini).`
                    : '.'}
                </span>
              </p>
            </>
          )}
        </div>
      </div>

      {/* Active Stores */}
      <div className="card">
        <div className="px-6 py-4 border-b border-gray-200 dark:border-slate-700">
          <h2 className="text-lg font-semibold text-gray-900 dark:text-slate-100">Toko Aktif</h2>
        </div>
        <div className="divide-y divide-gray-100 dark:divide-slate-700/60">
          {stores.length === 0 ? (
            <div className="px-6 py-12 text-center text-gray-500 dark:text-slate-400">
              <Store className="w-12 h-12 mx-auto mb-3 text-gray-300 dark:text-slate-600" />
              <p className="font-medium text-gray-900 dark:text-slate-200">Belum ada toko yang terhubung</p>
              <p className="text-sm mt-1">Buka menu Kelola Toko untuk mengkoneksikan toko</p>
            </div>
          ) : (
            stores.map((store) => (
              <div key={store.id} className="px-6 py-4 flex items-center justify-between hover:bg-gray-50 dark:hover:bg-slate-700/40 transition-colors">
                <div className="flex items-center gap-4">
                  <div className="w-10 h-10 rounded-lg bg-gray-100 dark:bg-slate-700 flex items-center justify-center shrink-0">
                    <Store className="w-5 h-5 text-gray-500 dark:text-slate-300" />
                  </div>
                  <div>
                    <p className="font-medium text-gray-900 dark:text-slate-100">{store.name}</p>
                    <div className="flex items-center gap-2 mt-1">
                      <span className={store.platform === 'SHOPEE' ? 'badge-shopee' : 'badge-tiktok'}>
                        {store.platform}
                      </span>
                      <span className={`badge ${statusColors[store.status]}`}>
                        {statusLabels[store.status] || store.status}
                      </span>
                      {store.status === 'ACTIVE' && store.tokenExpiry && (
                        <span className="text-xs text-gray-400 dark:text-slate-500">
                          token s/d {new Date(store.tokenExpiry).toLocaleTimeString('id-ID', {
                            hour: '2-digit',
                            minute: '2-digit',
                          })}
                        </span>
                      )}
                    </div>
                  </div>
                </div>
                <div className="text-right">
                  <p className="text-lg font-semibold text-gray-900 dark:text-slate-100">{store.orderCount}</p>
                  <p className="text-xs text-gray-500 dark:text-slate-400">
                    pesanan
                    {/* Only worth showing when the shop actually has split orders */}
                    {store.packageCount > store.orderCount && ` · ${store.packageCount} paket`}
                  </p>
                </div>
              </div>
            ))
          )}
        </div>
      </div>
    </div>
  )
}
