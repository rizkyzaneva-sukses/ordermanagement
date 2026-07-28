'use client'

import { useEffect, useState } from 'react'
import api from '@/lib/api'
import {
  Store,
  RefreshCw,
  Loader2,
  AlertCircle,
  CheckCircle2,
  Clock,
  LinkIcon,
  ShieldCheck,
  Zap,
  ArrowRight,
} from 'lucide-react'

interface StoreData {
  id: string
  name: string
  platform: 'SHOPEE' | 'TIKTOK'
  shopId: string
  status: 'ACTIVE' | 'TOKEN_EXPIRED' | 'ERROR'
  lastSyncAt: string | null
  orderCount: number
}

const statusConfig: Record<string, { label: string; class: string; icon: any }> = {
  ACTIVE: { label: 'Terhubung', class: 'bg-green-100 text-green-700 dark:bg-green-950/60 dark:text-green-300', icon: CheckCircle2 },
  TOKEN_EXPIRED: { label: 'Token Kadaluarsa', class: 'bg-yellow-100 text-yellow-700 dark:bg-yellow-950/60 dark:text-yellow-300', icon: Clock },
  ERROR: { label: 'Error', class: 'bg-red-100 text-red-700 dark:bg-red-950/60 dark:text-red-300', icon: AlertCircle },
}

export default function StoresPage() {
  const [stores, setStores] = useState<StoreData[]>([])
  const [loading, setLoading] = useState(true)
  const [connectingPlatform, setConnectingPlatform] = useState<'SHOPEE' | 'TIKTOK' | null>(null)
  const [reconnecting, setReconnecting] = useState<string | null>(null)
  const [toastMessage, setToastMessage] = useState<string | null>(null)
  const [toastType, setToastType] = useState<'success' | 'error'>('success')

  const fetchStores = async () => {
    try {
      const res = await api.get<any>('/stores')
      const rawData = Array.isArray(res.data) ? res.data : (res.data?.data || [])
      const formatted = rawData.map((s: any) => ({
        ...s,
        status: s.status || (s.isActive ? 'ACTIVE' : 'ERROR'),
        lastSyncAt: s.lastSyncAt || s.updatedAt || null,
      }))
      setStores(formatted)
    } catch (err) {
      console.error('Failed to fetch stores', err)
      setStores([])
    }
  }

  useEffect(() => {
    fetchStores().finally(() => setLoading(false))

    const params = new URLSearchParams(window.location.search)
    const connected = params.get('connected')
    const error = params.get('error')
    if (connected) {
      const name = connected === 'shopee' ? 'Shopee' : 'TikTok'
      setToastMessage(`Toko ${name} berhasil terhubung!`)
      setToastType('success')
      setTimeout(() => setToastMessage(null), 5000)
      window.history.replaceState(null, '', '/admin/stores')
    } else if (error) {
      setToastMessage(error)
      setToastType('error')
      setTimeout(() => setToastMessage(null), 8000)
      window.history.replaceState(null, '', '/admin/stores')
    }
  }, [])

  const handle1ClickConnect = async (platform: 'SHOPEE' | 'TIKTOK') => {
    setConnectingPlatform(platform)
    try {
      const res = await api.post<any>('/stores/quick-connect', { platform })
      const authUrl = res.data?.authUrl
      if (authUrl) {
        window.location.href = authUrl
        return
      }
      setToastMessage('URL otorisasi tidak diterima dari server')
      setToastType('error')
      setTimeout(() => setToastMessage(null), 5000)
    } catch (err: any) {
      setToastMessage(err.response?.data?.error || 'Gagal menghubungkan toko')
      setToastType('error')
      setTimeout(() => setToastMessage(null), 5000)
    } finally {
      setConnectingPlatform(null)
    }
  }

  const handleReconnect = async (storeId: string) => {
    setReconnecting(storeId)
    try {
      await api.post(`/stores/${storeId}/reconnect`)
      await fetchStores()
    } catch (err) {
      console.error('Reconnect failed', err)
    } finally {
      setReconnecting(null)
    }
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <Loader2 className="w-8 h-8 animate-spin text-primary-600 dark:text-primary-400" />
      </div>
    )
  }

  return (
    <div className="space-y-6">
      {/* Toast Notification */}
      {toastMessage && (
        <div className={`${toastType === 'error' ? 'bg-red-50 dark:bg-red-950/80 border-red-300 dark:border-red-700 text-red-800 dark:text-red-200' : 'bg-emerald-50 dark:bg-emerald-950/80 border-emerald-300 dark:border-emerald-700 text-emerald-800 dark:text-emerald-200'} px-4 py-3 rounded-xl flex items-center gap-3 shadow-lg border`}>
          {toastType === 'error' ? (
            <AlertCircle className="w-5 h-5 text-red-600 dark:text-red-400 shrink-0" />
          ) : (
            <CheckCircle2 className="w-5 h-5 text-emerald-600 dark:text-emerald-400 shrink-0" />
          )}
          <span className="text-sm font-medium">{toastMessage}</span>
        </div>
      )}

      {/* Header */}
      <div>
        <h1 className="text-2xl font-bold text-gray-900 dark:text-slate-100">Kelola Toko</h1>
        <p className="text-sm text-gray-500 dark:text-slate-400 mt-1">
          Hubungkan akun Toko Shopee & TikTok Shop Anda dengan 1-Klik Login
        </p>
      </div>

      {/* 1-Click Login Cards Header */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        {/* Shopee Connect Card */}
        <div className="card p-5 border-l-4 border-l-orange-500 bg-gradient-to-br from-white to-orange-50/30 dark:from-slate-800 dark:to-orange-950/20 flex flex-col justify-between gap-4">
          <div className="flex items-start justify-between">
            <div className="flex items-center gap-3">
              <div className="w-12 h-12 rounded-xl bg-orange-500 text-white flex items-center justify-center font-bold text-xl shadow-md">
                S
              </div>
              <div>
                <h3 className="font-bold text-gray-900 dark:text-slate-100 text-lg">Shopee Seller Center</h3>
                <p className="text-xs text-gray-500 dark:text-slate-400">Otorisasi langsung via Akun Shopee Seller</p>
              </div>
            </div>
            <span className="badge badge-shopee">Shopee</span>
          </div>

          <button
            onClick={() => handle1ClickConnect('SHOPEE')}
            disabled={connectingPlatform === 'SHOPEE'}
            className="w-full py-3 px-4 rounded-xl bg-orange-600 hover:bg-orange-700 active:bg-orange-800 text-white font-semibold text-sm transition-all flex items-center justify-center gap-2 shadow-md hover:shadow-lg disabled:opacity-50"
          >
            {connectingPlatform === 'SHOPEE' ? (
              <>
                <Loader2 className="w-4 h-4 animate-spin" />
                <span>Menghubungkan Akun Shopee...</span>
              </>
            ) : (
              <>
                <Zap className="w-4 h-4" />
                <span>Login & Hubungkan Toko Shopee</span>
                <ArrowRight className="w-4 h-4" />
              </>
            )}
          </button>
        </div>

        {/* TikTok Shop Connect Card */}
        <div className="card p-5 border-l-4 border-l-slate-900 dark:border-l-slate-400 bg-gradient-to-br from-white to-slate-100/50 dark:from-slate-800 dark:to-slate-900/50 flex flex-col justify-between gap-4">
          <div className="flex items-start justify-between">
            <div className="flex items-center gap-3">
              <div className="w-12 h-12 rounded-xl bg-slate-900 dark:bg-slate-100 text-white dark:text-slate-900 flex items-center justify-center font-bold text-xl shadow-md">
                T
              </div>
              <div>
                <h3 className="font-bold text-gray-900 dark:text-slate-100 text-lg">TikTok Shop Center</h3>
                <p className="text-xs text-gray-500 dark:text-slate-400">Otorisasi langsung via Akun TikTok Seller</p>
              </div>
            </div>
            <span className="badge badge-tiktok">TikTok</span>
          </div>

          <button
            onClick={() => handle1ClickConnect('TIKTOK')}
            disabled={connectingPlatform === 'TIKTOK'}
            className="w-full py-3 px-4 rounded-xl bg-slate-900 hover:bg-slate-800 dark:bg-slate-100 dark:text-slate-900 dark:hover:bg-white text-white font-semibold text-sm transition-all flex items-center justify-center gap-2 shadow-md hover:shadow-lg disabled:opacity-50"
          >
            {connectingPlatform === 'TIKTOK' ? (
              <>
                <Loader2 className="w-4 h-4 animate-spin" />
                <span>Menghubungkan Akun TikTok...</span>
              </>
            ) : (
              <>
                <Zap className="w-4 h-4" />
                <span>Login & Hubungkan TikTok Shop</span>
                <ArrowRight className="w-4 h-4" />
              </>
            )}
          </button>
        </div>
      </div>

      {/* Security Note Banner */}
      <div className="bg-slate-50 dark:bg-slate-800/60 border border-slate-200 dark:border-slate-700 rounded-xl p-4 flex items-center gap-3">
        <ShieldCheck className="w-5 h-5 text-emerald-600 dark:text-emerald-400 shrink-0" />
        <p className="text-xs text-gray-600 dark:text-slate-400">
          Kredensial API & Secret Key aman tersimpan di dalam environment server (<code className="font-mono bg-slate-200 dark:bg-slate-700 px-1 py-0.5 rounded text-gray-800 dark:text-slate-200">.env</code>) dan terbebas dari repositori Git. Tim Anda cukup mengklik tombol login di atas.
        </p>
      </div>

      {/* Connected Stores Table */}
      <div className="card overflow-hidden">
        <div className="px-6 py-4 border-b border-gray-200 dark:border-slate-700 flex items-center justify-between">
          <h2 className="font-semibold text-gray-900 dark:text-slate-100">Daftar Toko Terhubung ({stores.length})</h2>
          <button onClick={fetchStores} className="btn-ghost p-1.5 text-xs text-gray-500 flex items-center gap-1">
            <RefreshCw className="w-3.5 h-3.5" />
            Refresh
          </button>
        </div>

        <div className="overflow-x-auto">
          <table className="w-full min-w-[640px]">
            <thead>
              <tr className="border-b border-gray-200 dark:border-slate-700 bg-gray-50 dark:bg-slate-800/80">
                <th className="table-header">Nama Toko</th>
                <th className="table-header">Platform</th>
                <th className="table-header">Shop ID</th>
                <th className="table-header">Status</th>
                <th className="table-header">Jumlah Pesanan</th>
                <th className="table-header">Sync Terakhir</th>
                <th className="table-header text-right">Aksi</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100 dark:divide-slate-700/60">
              {stores.length === 0 ? (
                <tr>
                  <td colSpan={7} className="px-4 py-16 text-center">
                    <Store className="w-12 h-12 text-gray-300 dark:text-slate-600 mx-auto mb-3" />
                    <p className="font-medium text-gray-900 dark:text-slate-200">Belum ada toko yang terhubung</p>
                    <p className="text-sm text-gray-500 dark:text-slate-400 mt-1">
                      Klik salah satu tombol login di atas untuk menghubungkan toko Shopee atau TikTok Shop Anda
                    </p>
                  </td>
                </tr>
              ) : (
                stores.map((store) => {
                  const statusInfo = statusConfig[store.status] || statusConfig.ACTIVE
                  const StatusIcon = statusInfo.icon
                  return (
                    <tr key={store.id} className="hover:bg-gray-50 dark:hover:bg-slate-700/40 transition-colors">
                      <td className="table-cell font-medium text-gray-900 dark:text-slate-100">
                        <div className="flex items-center gap-3">
                          <div className="w-9 h-9 rounded-lg bg-gray-100 dark:bg-slate-700 flex items-center justify-center">
                            <Store className="w-4 h-4 text-gray-500 dark:text-slate-300" />
                          </div>
                          <span>{store.name}</span>
                        </div>
                      </td>
                      <td className="table-cell">
                        <span className={store.platform === 'SHOPEE' ? 'badge-shopee' : 'badge-tiktok'}>
                          {store.platform}
                        </span>
                      </td>
                      <td className="table-cell font-mono text-xs text-gray-500 dark:text-slate-400">{store.shopId}</td>
                      <td className="table-cell">
                        <span className={`badge ${statusInfo.class}`}>
                          <StatusIcon className="w-3 h-3 mr-1" />
                          {statusInfo.label}
                        </span>
                      </td>
                      <td className="table-cell font-medium text-gray-900 dark:text-slate-100">{store.orderCount}</td>
                      <td className="table-cell text-gray-500 dark:text-slate-400 text-xs">
                        {store.lastSyncAt
                          ? new Date(store.lastSyncAt).toLocaleString('id-ID', {
                              day: '2-digit',
                              month: 'short',
                              hour: '2-digit',
                              minute: '2-digit',
                            })
                          : '-'}
                      </td>
                      <td className="table-cell text-right">
                        <div className="flex items-center justify-end gap-1">
                          {store.status !== 'ACTIVE' && (
                            <button
                              onClick={() => handleReconnect(store.id)}
                              disabled={reconnecting === store.id}
                              className="btn-ghost p-2 text-yellow-600 dark:text-yellow-400"
                              title="Koneksikan Ulang"
                            >
                              {reconnecting === store.id ? (
                                <Loader2 className="w-4 h-4 animate-spin" />
                              ) : (
                                <LinkIcon className="w-4 h-4" />
                              )}
                            </button>
                          )}
                        </div>
                      </td>
                    </tr>
                  )
                })
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  )
}
