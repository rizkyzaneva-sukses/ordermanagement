'use client'

import { useEffect, useState } from 'react'
import api from '@/lib/api'
import {
  Package,
  PackageCheck,
  Truck,
  AlertTriangle,
  RefreshCw,
  Store,
  Loader2,
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
  status: 'ACTIVE' | 'EXPIRED' | 'ERROR'
  tokenExpiry: string | null
  lastSyncAt: string | null
  lastSyncError: string | null
}

const statusColors: Record<string, string> = {
  ACTIVE: 'bg-green-100 text-green-700 dark:bg-green-950/60 dark:text-green-300',
  EXPIRED: 'bg-yellow-100 text-yellow-700 dark:bg-yellow-950/60 dark:text-yellow-300',
  ERROR: 'bg-red-100 text-red-700 dark:bg-red-950/60 dark:text-red-300',
}

const statusLabels: Record<string, string> = {
  ACTIVE: 'AKTIF',
  EXPIRED: 'PERLU HUBUNGKAN ULANG',
  ERROR: 'SYNC GAGAL',
}

export default function DashboardPage() {
  const [stats, setStats] = useState<DashboardStats | null>(null)
  const [stores, setStores] = useState<StoreInfo[]>([])
  const [loading, setLoading] = useState(true)
  const [syncing, setSyncing] = useState(false)

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

  useEffect(() => {
    fetchDashboard()
  }, [])

  const handleSync = async () => {
    setSyncing(true)
    try {
      await api.post('/orders/sync')
      await fetchDashboard()
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
