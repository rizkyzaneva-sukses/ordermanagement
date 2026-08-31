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
  AlertTriangle,
  Unlink,
} from 'lucide-react'

type StoreStatus = 'ACTIVE' | 'TOKEN_EXPIRED' | 'NEEDS_RECONNECT' | 'SYNC_PARTIAL' | 'SYNC_ERROR' | 'ERROR'

interface StoreData {
  id: string
  name: string
  platform: 'SHOPEE' | 'TIKTOK'
  shopId: string
  status: StoreStatus
  lastSyncAt: string | null
  orderCount: number
  needsReconnect?: boolean
  lastSyncStatus?: string | null
  lastSyncError?: string | null
}

/** Shopee's own view of who authorized us, against what is stored here. */
interface AuthorizedShops {
  supported: boolean
  reason?: string
  authorizedCount?: number
  linkedCount?: number
  unlinked?: { shopId: string; authTime: number | null; expireTime: number | null; expired: boolean }[]
  revoked?: { id: string; name: string; shopId: string }[]
}

const statusConfig: Record<string, { label: string; class: string; icon: any }> = {
  ACTIVE: { label: 'Terhubung', class: 'bg-green-100 text-green-700 dark:bg-green-950/60 dark:text-green-300', icon: CheckCircle2 },
  TOKEN_EXPIRED: { label: 'Token Kadaluarsa', class: 'bg-yellow-100 text-yellow-700 dark:bg-yellow-950/60 dark:text-yellow-300', icon: Clock },
  // Re-authorization is the only fix, so this must not look like the expiry
  // above — that one the Reconnect button can still repair on its own.
  NEEDS_RECONNECT: { label: 'Perlu Otorisasi Ulang', class: 'bg-orange-100 text-orange-700 dark:bg-orange-950/60 dark:text-orange-300', icon: Unlink },
  // Distinct from Sync Gagal on purpose: the run succeeded, it just came back
  // incomplete — the rows it missed are quietly stale rather than absent.
  SYNC_PARTIAL: { label: 'Sync Sebagian', class: 'bg-amber-100 text-amber-700 dark:bg-amber-950/60 dark:text-amber-300', icon: AlertTriangle },
  SYNC_ERROR: { label: 'Sync Gagal', class: 'bg-red-100 text-red-700 dark:bg-red-950/60 dark:text-red-300', icon: AlertTriangle },
  ERROR: { label: 'Error', class: 'bg-red-100 text-red-700 dark:bg-red-950/60 dark:text-red-300', icon: AlertCircle },
}

export default function StoresPage() {
  const [stores, setStores] = useState<StoreData[]>([])
  const [authorized, setAuthorized] = useState<AuthorizedShops | null>(null)
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

  /**
   * Ask Shopee which shops have authorized this app.
   *
   * Failure is deliberately quiet: the panel just does not render. An admin who
   * came here to connect a shop should not be met with a red box about a
   * comparison that is only ever advisory.
   */
  const fetchAuthorized = async () => {
    try {
      const res = await api.get<any>('/stores/authorized')
      setAuthorized(res.data?.data || res.data || null)
    } catch {
      setAuthorized(null)
    }
  }

  const refreshAll = async () => {
    await Promise.all([fetchStores(), fetchAuthorized()])
  }

  useEffect(() => {
    Promise.all([fetchStores(), fetchAuthorized()]).finally(() => setLoading(false))

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
      await refreshAll()
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

      {/* Shopee's authorization list against ours.
          A shop that authorized us but was never added here is invisible
          everywhere else in the app: its orders never arrive and nothing says
          they are missing. This is the only screen that can name them. */}
      {authorized?.supported && (
        (authorized.unlinked?.length ?? 0) > 0 || (authorized.revoked?.length ?? 0) > 0 ? (
          <div className="rounded-xl border border-amber-300 dark:border-amber-800 bg-amber-50 dark:bg-amber-950/30 p-4 space-y-3">
            <div className="flex items-start gap-3">
              <AlertTriangle className="w-5 h-5 text-amber-600 dark:text-amber-400 shrink-0 mt-0.5" />
              <div className="space-y-1">
                <p className="text-sm font-semibold text-amber-900 dark:text-amber-200">
                  {authorized.linkedCount} dari {authorized.authorizedCount} toko Shopee yang mengotorisasi aplikasi ini sudah tersambung
                </p>
                <p className="text-xs text-amber-800 dark:text-amber-300">
                  Pesanan dari toko yang belum tersambung tidak pernah masuk ke OrderPro — dan tidak muncul sebagai kekurangan di layar mana pun.
                </p>
              </div>
            </div>

            {(authorized.unlinked?.length ?? 0) > 0 && (
              <div className="space-y-2">
                <p className="text-xs font-medium text-amber-900 dark:text-amber-200">
                  Belum tersambung ({authorized.unlinked!.length}):
                </p>
                <div className="flex flex-wrap gap-1.5">
                  {authorized.unlinked!.map((shop) => (
                    <span
                      key={shop.shopId}
                      className={`inline-flex items-center gap-1.5 rounded-md border px-2 py-1 font-mono text-xs ${
                        shop.expired
                          ? 'border-red-300 dark:border-red-800 bg-red-50 dark:bg-red-950/40 text-red-700 dark:text-red-300'
                          : 'border-amber-300 dark:border-amber-700 bg-white dark:bg-slate-800 text-amber-900 dark:text-amber-200'
                      }`}
                      title={
                        shop.authTime
                          ? `Diotorisasi ${new Date(shop.authTime * 1000).toLocaleDateString('id-ID')}`
                          : undefined
                      }
                    >
                      {shop.shopId}
                      {shop.expired && <span className="not-italic">· otorisasi habis</span>}
                    </span>
                  ))}
                </div>
                <button
                  onClick={() => handle1ClickConnect('SHOPEE')}
                  disabled={connectingPlatform === 'SHOPEE'}
                  className="inline-flex items-center gap-2 rounded-lg bg-orange-600 hover:bg-orange-700 px-3 py-2 text-xs font-semibold text-white disabled:opacity-50"
                >
                  {connectingPlatform === 'SHOPEE' ? (
                    <Loader2 className="w-3.5 h-3.5 animate-spin" />
                  ) : (
                    <Zap className="w-3.5 h-3.5" />
                  )}
                  Hubungkan toko berikutnya
                </button>
                {/* Shopee's authorization page has the merchant pick the shop
                    themselves — we cannot preselect one — so the ids above are
                    the checklist to work through. */}
                <p className="text-xs text-amber-800 dark:text-amber-300">
                  Shopee meminta kamu memilih sendiri tokonya saat otorisasi. Ulangi tombol di atas untuk tiap Shop ID di daftar.
                </p>
              </div>
            )}

            {(authorized.revoked?.length ?? 0) > 0 && (
              <div className="space-y-1.5 border-t border-amber-200 dark:border-amber-800 pt-3">
                <p className="text-xs font-medium text-amber-900 dark:text-amber-200">
                  Masih aktif di sini tapi tidak lagi terdaftar di Shopee ({authorized.revoked!.length}) — pesanannya sudah berhenti masuk:
                </p>
                <div className="flex flex-wrap gap-1.5">
                  {authorized.revoked!.map((store) => (
                    <span
                      key={store.id}
                      className="inline-flex items-center gap-1.5 rounded-md border border-red-300 dark:border-red-800 bg-red-50 dark:bg-red-950/40 px-2 py-1 text-xs text-red-700 dark:text-red-300"
                    >
                      <Unlink className="w-3 h-3" />
                      {store.name} <span className="font-mono opacity-70">({store.shopId})</span>
                    </span>
                  ))}
                </div>
              </div>
            )}
          </div>
        ) : (
          <div className="rounded-xl border border-emerald-200 dark:border-emerald-800 bg-emerald-50 dark:bg-emerald-950/30 px-4 py-3 flex items-center gap-3">
            <CheckCircle2 className="w-5 h-5 text-emerald-600 dark:text-emerald-400 shrink-0" />
            <p className="text-sm text-emerald-900 dark:text-emerald-200">
              Semua {authorized.authorizedCount} toko Shopee yang mengotorisasi aplikasi ini sudah tersambung.
            </p>
          </div>
        )
      )}

      {/* Connected Stores Table */}
      <div className="card overflow-hidden">
        <div className="px-6 py-4 border-b border-gray-200 dark:border-slate-700 flex items-center justify-between">
          <h2 className="font-semibold text-gray-900 dark:text-slate-100">Daftar Toko Terhubung ({stores.length})</h2>
          <button onClick={refreshAll} className="btn-ghost p-1.5 text-xs text-gray-500 flex items-center gap-1">
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
                          <div className="min-w-0">
                            <span>{store.name}</span>
                            {/* Recorded by every failed sync but never shown, so
                                a shop that stopped pulling orders looked the
                                same as one with nothing to pull. */}
                            {(store.status === 'SYNC_ERROR' || store.status === 'SYNC_PARTIAL') && store.lastSyncError && (
                              <p
                                className={`text-xs font-normal truncate max-w-[260px] ${
                                  store.status === 'SYNC_PARTIAL'
                                    ? 'text-amber-700 dark:text-amber-400'
                                    : 'text-red-600 dark:text-red-400'
                                }`}
                                title={store.lastSyncError}
                              >
                                {store.lastSyncError}
                              </p>
                            )}
                          </div>
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
                          {/* A store the platform told us to re-authorize
                              cannot be repaired by refreshing the token — that
                              is precisely the call that failed. Sending the
                              admin through the login flow is the only fix. */}
                          {store.status === 'NEEDS_RECONNECT' ? (
                            <button
                              onClick={() => handle1ClickConnect(store.platform)}
                              disabled={connectingPlatform === store.platform}
                              className="btn-ghost p-2 text-orange-600 dark:text-orange-400"
                              title="Otorisasi ulang lewat login toko"
                            >
                              {connectingPlatform === store.platform ? (
                                <Loader2 className="w-4 h-4 animate-spin" />
                              ) : (
                                <Zap className="w-4 h-4" />
                              )}
                            </button>
                          ) : store.status !== 'ACTIVE' && store.status !== 'SYNC_PARTIAL' ? (
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
                          ) : null}
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
