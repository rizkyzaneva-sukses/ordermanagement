'use client'

import { useCallback, useEffect, useState } from 'react'
import api from '@/lib/api'
import HelpTip from '@/components/HelpTip'
import { Rocket, Loader2, AlertTriangle, RefreshCw, Clock, Package } from 'lucide-react'

interface BoostItem {
  itemId: string
  name: string | null
  imageUrl: string | null
}

interface BoostedItem extends BoostItem {
  coolDownSeconds: number
}

interface HistoryRow {
  itemId: string
  name: string | null
  ok: boolean
  reason: string | null
  auto: boolean
  at: string
}

interface StoreBoost {
  storeId: string
  name: string
  autoBoost: boolean
  needsReconnect: boolean
  lastRunAt: string | null
  lastError: string | null
  liveError: string | null
  slots: number
  activeItems: number
  boosted: BoostedItem[]
  next: BoostItem[]
  history: HistoryRow[]
}

type Message = { type: 'success' | 'error'; text: string }

const timeFmt = new Intl.DateTimeFormat('id-ID', {
  day: '2-digit',
  month: 'short',
  hour: '2-digit',
  minute: '2-digit',
  timeZone: 'Asia/Jakarta',
})

/** "3 j 12 m" — sisa waktu sampai slot bisa dipakai lagi. */
function formatLeft(seconds: number): string {
  if (seconds <= 0) return 'segera kosong'
  const h = Math.floor(seconds / 3600)
  const m = Math.ceil((seconds % 3600) / 60)
  return h > 0 ? `${h} j ${m} m` : `${m} m`
}

/** Shopee's itemName can run long; the card only has room for one line. */
const itemLabel = (i: { name: string | null; itemId: string }) => i.name || `Produk #${i.itemId}`

export default function BoostPage() {
  const [stores, setStores] = useState<StoreBoost[] | null>(null)
  const [loadError, setLoadError] = useState('')
  const [busy, setBusy] = useState<string | null>(null)
  const [message, setMessage] = useState<Message | null>(null)
  // When the data was read, so the cooldowns count down without asking Shopee again.
  const [loadedAt, setLoadedAt] = useState(Date.now())
  const [now, setNow] = useState(Date.now())

  const load = useCallback(async () => {
    try {
      const res = await api.get<StoreBoost[]>('/boost')
      setStores(res.data)
      setLoadedAt(Date.now())
      setLoadError('')
    } catch (err: any) {
      setLoadError(err?.response?.data?.error || 'Gagal memuat Naikkan Produk')
    }
  }, [])

  useEffect(() => {
    load()
    const refresh = setInterval(load, 5 * 60_000)
    const tick = setInterval(() => setNow(Date.now()), 30_000)
    return () => {
      clearInterval(refresh)
      clearInterval(tick)
    }
  }, [load])

  const describeRun = (name: string, run: any): Message => {
    if (run?.busy) return { type: 'success', text: `${name}: sedang diproses, coba lihat lagi sebentar.` }
    const ok = run?.boosted?.length ?? 0
    const failed: any[] = run?.failed ?? []
    if (run?.freeSlots === 0) {
      return { type: 'success', text: `${name}: kelima slot masih terpakai, belum ada yang bisa dinaikkan.` }
    }
    if (ok === 0 && failed.length === 0) {
      return { type: 'success', text: `${name}: tidak ada produk aktif yang bisa dinaikkan.` }
    }
    const parts = [`${name}: ${ok} produk dinaikkan`]
    if (failed.length > 0) {
      parts.push(`${failed.length} gagal (${failed.map((f) => `${f.name || f.itemId}: ${f.reason}`).join('; ')})`)
    }
    return { type: failed.length > 0 && ok === 0 ? 'error' : 'success', text: parts.join(', ') + '.' }
  }

  const toggle = async (s: StoreBoost) => {
    setBusy(s.storeId)
    setMessage(null)
    try {
      const res = await api.put<any>(`/boost/${s.storeId}`, { enabled: !s.autoBoost })
      if (!s.autoBoost) {
        setMessage(
          res.data?.runError
            ? { type: 'error', text: `${s.name}: otomatis menyala, tetapi percobaan pertama gagal: ${res.data.runError}` }
            : describeRun(s.name, res.data?.run),
        )
      } else {
        setMessage({ type: 'success', text: `${s.name}: naikkan otomatis dimatikan.` })
      }
      await load()
    } catch (err: any) {
      setMessage({ type: 'error', text: err?.response?.data?.error || 'Gagal mengubah pengaturan' })
    } finally {
      setBusy(null)
    }
  }

  const runNow = async (s: StoreBoost) => {
    setBusy(s.storeId)
    setMessage(null)
    try {
      const res = await api.post<any>(`/boost/${s.storeId}/run`)
      setMessage(describeRun(s.name, res.data))
      await load()
    } catch (err: any) {
      setMessage({ type: 'error', text: `${s.name}: ${err?.response?.data?.error || 'Gagal menaikkan produk'}` })
    } finally {
      setBusy(null)
    }
  }

  const elapsed = Math.floor((now - loadedAt) / 1000)

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-2xl font-bold text-gray-900 dark:text-slate-100 flex items-center gap-2">
          Naikkan Produk
          <HelpTip term="boost.page" />
        </h1>
        <p className="text-sm text-gray-500 dark:text-slate-400">
          Shopee mengizinkan 5 produk dinaikkan per toko, tiap slot bisa dipakai lagi setelah 4 jam.
          Kalau Otomatis menyala, semua produk aktif digilir bergantian tanpa perlu dipilih.
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

      {loadError && (
        <div className="rounded-lg border border-red-200 dark:border-red-800 bg-red-50 dark:bg-red-900/20 px-4 py-3 text-sm text-red-800 dark:text-red-200 flex items-center justify-between gap-3">
          <span>{loadError}</span>
          <button onClick={load} className="btn-secondary shrink-0">Coba lagi</button>
        </div>
      )}

      {stores === null && !loadError && (
        <div className="card p-10 flex justify-center">
          <Loader2 className="w-6 h-6 animate-spin text-primary-600" />
        </div>
      )}

      {stores !== null && stores.length === 0 && (
        <div className="card p-10 text-center text-sm text-gray-600 dark:text-slate-300">
          Belum ada toko Shopee yang bisa kamu akses.
        </div>
      )}

      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
        {stores?.map((s) => {
          const isBusy = busy === s.storeId
          const used = s.boosted.length
          const error = s.liveError || s.lastError
          return (
            <div
              key={s.storeId}
              className={`card dark:bg-slate-800 dark:border-slate-700 p-4 flex flex-col gap-4 ${
                s.autoBoost ? 'border-green-300 dark:border-green-800' : ''
              }`}
            >
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <p className="font-semibold text-gray-900 dark:text-slate-100 truncate">{s.name}</p>
                  <p className="text-xs text-gray-500 dark:text-slate-400">
                    {s.activeItems} produk aktif di katalog
                    {s.lastRunAt && ` · dicek ${timeFmt.format(new Date(s.lastRunAt))} WIB`}
                  </p>
                </div>
                <div className="flex items-center gap-2 shrink-0">
                  <span className="text-xs font-medium text-gray-700 dark:text-slate-200">Otomatis</span>
                  <button
                    role="switch"
                    aria-checked={s.autoBoost}
                    aria-label={`Naikkan otomatis ${s.name}`}
                    disabled={isBusy || s.needsReconnect}
                    onClick={() => toggle(s)}
                    className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors disabled:opacity-50 ${
                      s.autoBoost ? 'bg-green-600' : 'bg-gray-300 dark:bg-slate-600'
                    }`}
                  >
                    <span
                      className={`inline-block h-5 w-5 rounded-full bg-white shadow transition-transform ${
                        s.autoBoost ? 'translate-x-5' : 'translate-x-0.5'
                      }`}
                    />
                  </button>
                  <HelpTip term="boost.auto" />
                </div>
              </div>

              {s.needsReconnect && (
                <p className="text-xs text-amber-800 dark:text-amber-300 flex gap-1.5">
                  <AlertTriangle className="w-4 h-4 shrink-0" />
                  Toko ini perlu disambungkan ulang di Kelola Toko sebelum bisa menaikkan produk.
                </p>
              )}

              {error && !s.needsReconnect && (
                <p className="text-xs text-red-700 dark:text-red-300 flex gap-1.5">
                  <AlertTriangle className="w-4 h-4 shrink-0" />
                  <span>Terakhir gagal: {error}</span>
                </p>
              )}

              <div>
                <p className="text-sm font-medium text-gray-900 dark:text-slate-100 mb-2">
                  Slot terpakai: {used}/{s.slots} <HelpTip term="boost.slots" />
                </p>
                {used === 0 ? (
                  <p className="text-xs text-gray-500 dark:text-slate-400">Tidak ada produk yang sedang dinaikkan.</p>
                ) : (
                  <ul className="space-y-1.5">
                    {s.boosted.map((b) => (
                      <li key={b.itemId} className="flex items-center gap-2 text-sm">
                        <Thumb url={b.imageUrl} />
                        <span className="flex-1 min-w-0 truncate text-gray-800 dark:text-slate-200" title={itemLabel(b)}>
                          {itemLabel(b)}
                        </span>
                        <span className="text-xs text-gray-600 dark:text-slate-300 flex items-center gap-1 shrink-0">
                          <Clock className="w-3.5 h-3.5" />
                          {formatLeft(b.coolDownSeconds - elapsed)}
                        </span>
                      </li>
                    ))}
                  </ul>
                )}
              </div>

              <div>
                <p className="text-sm font-medium text-gray-900 dark:text-slate-100 mb-2">
                  Antrean berikutnya <HelpTip term="boost.next" />
                </p>
                {s.next.length === 0 ? (
                  <p className="text-xs text-gray-500 dark:text-slate-400">
                    {s.activeItems === 0
                      ? 'Katalog kosong. Tarik katalog dulu di halaman Produk supaya antreannya terlihat.'
                      : 'Semua produk aktif sedang dinaikkan atau stoknya habis.'}
                  </p>
                ) : (
                  <ol className="space-y-1 text-sm list-decimal list-inside text-gray-700 dark:text-slate-300">
                    {s.next.map((n) => (
                      <li key={n.itemId} className="truncate" title={itemLabel(n)}>{itemLabel(n)}</li>
                    ))}
                  </ol>
                )}
              </div>

              <details className="text-sm">
                <summary className="cursor-pointer font-medium text-gray-900 dark:text-slate-100">
                  Riwayat ({s.history.length}) <HelpTip term="boost.history" />
                </summary>
                {s.history.length === 0 ? (
                  <p className="mt-2 text-xs text-gray-500 dark:text-slate-400">Belum ada produk yang dinaikkan.</p>
                ) : (
                  <ul className="mt-2 space-y-1.5 max-h-64 overflow-y-auto">
                    {s.history.map((h, i) => (
                      <li key={i} className="text-xs">
                        <div className="flex gap-2">
                          <span className="text-gray-500 dark:text-slate-400 shrink-0 tabular-nums">
                            {timeFmt.format(new Date(h.at))}
                          </span>
                          <span className="flex-1 min-w-0 truncate text-gray-800 dark:text-slate-200" title={itemLabel(h)}>
                            {itemLabel(h)}
                          </span>
                          <span className={`shrink-0 font-medium ${
                            h.ok ? 'text-green-700 dark:text-green-400' : 'text-red-700 dark:text-red-400'
                          }`}>
                            {h.ok ? 'Naik' : 'Gagal'}{!h.auto && ' · manual'}
                          </span>
                        </div>
                        {!h.ok && h.reason && (
                          <p className="text-red-700 dark:text-red-300 pl-1">{h.reason}</p>
                        )}
                      </li>
                    ))}
                  </ul>
                )}
              </details>

              <button
                onClick={() => runNow(s)}
                disabled={isBusy || s.needsReconnect || used >= s.slots}
                className="btn-secondary dark:bg-slate-700 dark:text-slate-100 dark:border-slate-600 mt-auto"
                title={used >= s.slots ? 'Kelima slot masih terpakai' : undefined}
              >
                {isBusy ? <Loader2 className="w-4 h-4 animate-spin" /> : <Rocket className="w-4 h-4" />}
                Naikkan Sekarang ({s.slots - used} slot kosong)
              </button>
            </div>
          )
        })}
      </div>

      {stores && stores.length > 0 && (
        <button onClick={load} className="btn-ghost text-sm">
          <RefreshCw className="w-4 h-4" /> Muat ulang
        </button>
      )}
    </div>
  )
}

function Thumb({ url }: { url: string | null }) {
  if (!url) {
    return (
      <span className="w-8 h-8 rounded bg-gray-100 dark:bg-slate-700 flex items-center justify-center shrink-0">
        <Package className="w-4 h-4 text-gray-500 dark:text-slate-400" />
      </span>
    )
  }
  // eslint-disable-next-line @next/next/no-img-element
  return <img src={url} alt="" className="w-8 h-8 rounded object-cover shrink-0" />
}
