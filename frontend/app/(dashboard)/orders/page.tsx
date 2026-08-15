'use client'

import { useEffect, useState, useCallback, useRef } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import api from '@/lib/api'
import OrderActions from '@/components/OrderActions'
import {
  RefreshCw,
  Search,
  Printer,
  ChevronLeft,
  ChevronRight,
  Loader2,
  Package,
  Filter,
  Truck,
  FileDown,
  AlertTriangle,
  X,
  Clock,
} from 'lucide-react'

interface OrderItem {
  name: string
  quantity: number
  price?: number
  variant?: string | null
}

interface Order {
  id: string
  orderId: string
  packageNumber?: string
  storeId: string
  storeName: string
  platform: 'SHOPEE' | 'TIKTOK'
  buyerName: string
  courier: string
  trackingNumber?: string
  status: string
  logisticsStatus?: string | null
  awbFetchedAt?: string | null
  printed: boolean
  items: OrderItem[]
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

interface SyncStoreState {
  id: string
  name: string
  platform: string
  lastSyncAt: string | null
  lastSyncAttemptAt: string | null
  lastSyncStatus: 'OK' | 'PARTIAL' | 'ERROR' | null
  lastSyncError: string | null
  needsReconnect: boolean
}

interface SyncStatus {
  stores: SyncStoreState[]
  failing: number
  /** Runs that finished but lost a status pass, so some rows went unrefreshed */
  partial: number
  needsReconnect: number
  redisReady: boolean
  workerRunning: boolean
}

/** Pickup addresses offered for a bulk shipment (POST /orders/ship-mass/options) */
interface MassShipOptions {
  availableModes: string[]
  pickup?: {
    address_list?: Array<{
      address_id: number
      address?: string
      city?: string
      state?: string
      time_slot_list?: Array<{
        pickup_time_id: string
        date?: number
        time_text?: string
      }>
    }>
  } | null
}

type PrintFilter = 'belum' | 'sudah' | 'semua'

/**
 * "3 menit lalu" — the form that actually answers "is what I'm looking at
 * current?". An absolute timestamp alone forces the reader to do that
 * subtraction themselves.
 */
function relativeTime(iso: string): string {
  const seconds = Math.floor((Date.now() - new Date(iso).getTime()) / 1000)

  if (seconds < 60) return 'baru saja'
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes} menit lalu`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours} jam lalu`
  const days = Math.floor(hours / 24)
  return `${days} hari lalu`
}

/**
 * Order.items is a JSON string column, but not every producer has written it
 * that way. Anything unparseable degrades to an empty list: a missing product
 * name is a cosmetic gap, whereas throwing here would take down the whole table.
 */
function parseItems(raw: unknown): OrderItem[] {
  if (Array.isArray(raw)) return raw as OrderItem[]
  if (typeof raw !== 'string' || raw.trim() === '') return []
  try {
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
}

function absoluteTime(iso: string): string {
  return new Date(iso).toLocaleString('id-ID', {
    day: '2-digit',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
  })
}

const statusBadgeClass: Record<string, string> = {
  PENDING: 'badge-pending',
  PROCESSING: 'badge-processing',
  READY_TO_SHIP: 'badge-ready-to-ship',
  PROCESSED: 'badge-processing',
  RETRY_SHIP: 'badge-pending',
  IN_CANCEL: 'badge-pending',
  SHIPPED: 'badge-shipped',
  CANCELLED: 'badge-cancelled',
}

/**
 * Short Indonesian label for a Shopee fulfillment status (KB §3.2). Shown
 * alongside the order status because it — not the order status — is what
 * decides whether a label may still be printed.
 */
const logisticsLabel: Record<string, string> = {
  LOGISTICS_NOT_START: 'Belum siap',
  LOGISTICS_READY: 'Siap diatur',
  LOGISTICS_REQUEST_CREATED: 'Pengiriman diatur',
  LOGISTICS_PICKUP_DONE: 'Sudah dijemput',
  LOGISTICS_PICKUP_RETRY: 'Pickup gagal, perlu ulang',
  LOGISTICS_PICKUP_FAILED: 'Pickup gagal',
  LOGISTICS_DELIVERY_DONE: 'Terkirim',
  LOGISTICS_DELIVERY_FAILED: 'Gagal kirim',
  LOGISTICS_INVALID: 'Dibatalkan',
  LOGISTICS_REQUEST_CANCELED: 'Pengiriman dibatalkan',
  LOGISTICS_LOST: 'Paket hilang',
  LOGISTICS_PENDING_ARRANGE: 'Menunggu diatur',
  LOGISTICS_COD_REJECTED: 'COD ditolak',
}

/** Fulfillment states in which the AWB may still be printed (KB §7.3). */
const PRINTABLE_LOGISTICS = new Set(['LOGISTICS_REQUEST_CREATED', 'LOGISTICS_PICKUP_RETRY'])

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
  const [bulkBusy, setBulkBusy] = useState(false)
  const [bulkMessage, setBulkMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null)
  const [massShipOpen, setMassShipOpen] = useState(false)
  const [massShipOptions, setMassShipOptions] = useState<MassShipOptions | null>(null)
  const [massAddressId, setMassAddressId] = useState<number | null>(null)
  const [massPickupTimeId, setMassPickupTimeId] = useState('')
  const [syncStatus, setSyncStatus] = useState<SyncStatus | null>(null)
  const [awaitingTracking, setAwaitingTracking] = useState(0)

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

  // The oldest successful sync across all stores, not the newest: with several
  // shops the page is only as fresh as whichever one lagged furthest behind, and
  // showing the newest would overstate how current the list is. Stores that have
  // never synced are skipped rather than treated as infinitely stale — they have
  // no data here to be stale about.
  const lastSyncedAt = (() => {
    const times = (syncStatus?.stores ?? [])
      .map((s) => s.lastSyncAt)
      .filter((t): t is string => Boolean(t))
    if (times.length === 0) return null
    return times.reduce((oldest, t) => (new Date(t) < new Date(oldest) ? t : oldest))
  })()

  /**
   * @param opts.background - Refresh without the full-table skeleton.
   *
   * While `loading` is true the tbody renders a placeholder row instead of the
   * orders, which unmounts every row — and with them any per-order dialog that
   * is open, along with its error or success message. A refresh triggered by an
   * action (a fulfillment call, a sync poll) must therefore leave the rows in
   * place; only a first load or a filter change blocks.
   */
  const fetchOrders = useCallback(async (opts?: { background?: boolean }) => {
    if (!opts?.background) setLoading(true)
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
      setAwaitingTracking(rawCounts.awaitingTracking ?? 0)

      const formattedOrders = rawOrders.map((o: any) => ({
        ...o,
        storeName: o.storeName || o.store?.name || 'Toko',
        platform: o.platform || o.store?.platform || 'SHOPEE',
        courier: o.courier || o.shippingCourier || '-',
        packageNumber: o.packageNumber || '',
        logisticsStatus: o.logisticsStatus ?? null,
        awbFetchedAt: o.awbFetchedAt ?? null,
        // Stored as a JSON string in Postgres, but older rows and the TikTok
        // path have been seen holding an array already — accept both rather
        // than letting one bad row blank the column for the whole page.
        items: parseItems(o.items),
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

  const fetchSyncStatus = useCallback(async () => {
    try {
      const res = await api.get<SyncStatus>('/orders/sync-status')
      setSyncStatus(res.data)
      return res.data
    } catch {
      return null
    }
  }, [])

  useEffect(() => {
    fetchStores()
    fetchSyncStatus()
  }, [fetchSyncStatus])

  // Keep the freshness line honest on a page left open. Two things go stale:
  // the elapsed-time text (recomputed each render, so it needs a re-render) and
  // lastSyncAt itself (the 15-minute scheduled sync moves it server-side with
  // nothing here to notice). Re-fetching covers both, and a minute is frequent
  // enough for a label that reads in whole minutes.
  useEffect(() => {
    const id = setInterval(() => { fetchSyncStatus() }, 60_000)
    return () => clearInterval(id)
  }, [fetchSyncStatus])

  useEffect(() => {
    fetchOrders()
  }, [fetchOrders])

  // handleSync polls for up to 90 seconds, re-fetching as it goes. It captures
  // fetchOrders from the render it was invoked in, so a filter changed mid-sync
  // left that loop still querying with the old values — and its stale, unfiltered
  // results overwrote the list the user was looking at. Reading through a ref
  // keeps the loop pointed at the current filters.
  const fetchOrdersRef = useRef(fetchOrders)
  useEffect(() => {
    fetchOrdersRef.current = fetchOrders
  }, [fetchOrders])

  useEffect(() => {
    setSelected(new Set())
  }, [printFilter, page])

  /**
   * Trigger a sync, then poll until every store reports back.
   *
   * The request returns before the work finishes, so without polling a failed
   * sync would look exactly like a successful one that found no orders.
   */
  const handleSync = async () => {
    setSyncing(true)
    setBulkMessage(null)
    try {
      const startedAt = Date.now()
      const res = await api.post<any>('/orders/sync')

      if (res.data?.workerMissing) {
        setBulkMessage({
          type: 'error',
          text: 'Worker sync tidak berjalan — sync dijalankan langsung di server sebagai cadangan. Jalankan "npm run worker" agar sync terjadwal ikut aktif.',
        })
      }

      // Poll until each store has an attempt newer than this click, or we give up
      const MAX_WAIT_MS = 90_000
      const POLL_EVERY_MS = 3_000
      let status: SyncStatus | null = null

      while (Date.now() - startedAt < MAX_WAIT_MS) {
        await new Promise((r) => setTimeout(r, POLL_EVERY_MS))
        status = await fetchSyncStatus()
        await fetchOrdersRef.current({ background: true })

        const allReported = status?.stores?.every(
          (s) => s.lastSyncAttemptAt && new Date(s.lastSyncAttemptAt).getTime() >= startedAt - 5_000
        )
        if (allReported) break
      }

      const failing = status?.stores?.filter((s) => s.lastSyncStatus === 'ERROR') ?? []
      if (failing.length > 0) {
        const reconnect = failing.filter((s) => s.needsReconnect)
        setBulkMessage({
          type: 'error',
          text:
            reconnect.length > 0
              ? `${reconnect.length} toko perlu dihubungkan ulang (token kedaluwarsa): ${reconnect.map((s) => s.name).join(', ')}. Buka Kelola Toko lalu hubungkan ulang.`
              : `${failing.length} toko gagal sync: ${failing.map((s) => `${s.name} — ${s.lastSyncError}`).join(' | ')}`,
        })
      }
    } catch (err: any) {
      setBulkMessage({
        type: 'error',
        text: err?.response?.data?.error || err?.message || 'Sync gagal dijalankan',
      })
    } finally {
      setSyncing(false)
      // Same stale-closure hazard as the poll loop above: this runs after a sync
      // that may have lasted 90 seconds.
      await fetchOrdersRef.current()
      await fetchSyncStatus()
    }
  }

  const handlePrintFilterChange = (filter: PrintFilter) => {
    setPrintFilter(filter)
    setPage(1)
    const params = new URLSearchParams(searchParams.toString())
    params.set('printFilter', filter)
    router.push(`/orders?${params.toString()}`)
  }

  /**
   * Printable means: has a tracking number and the fulfillment status is still
   * inside the KB §7.3 window. Rows whose fulfillment status is unknown
   * (TikTok, or synced before the column existed) fall back to the tracking
   * number alone.
   */
  const isPrintable = (order: Order) => {
    if (order.printed) return false
    if (!order.trackingNumber) return false
    if (order.logisticsStatus) return PRINTABLE_LOGISTICS.has(order.logisticsStatus)
    return true
  }

  /**
   * Shippable means Shopee still accepts a ship_order for this package.
   *
   * The order status alone is not enough. Shopee only takes a ship_order while
   * the package itself is LOGISTICS_READY ("Siap diatur") — one still allocating
   * or at LOGISTICS_NOT_START is refused, and every such refusal counts against
   * the ship_order success rate the platform holds this app to. Excluding them
   * here keeps the count on the button honest rather than promising a bulk run
   * that is half rejections.
   */
  const isShippable = (order: Order) => {
    if (order.platform !== 'SHOPEE') return false
    if (!['READY_TO_SHIP', 'RETRY_SHIP'].includes(order.status)) return false
    // Unknown fulfillment state: let the server make the call, it re-reads live
    if (!order.logisticsStatus) return true
    return order.logisticsStatus === 'LOGISTICS_READY' ||
      order.logisticsStatus === 'LOGISTICS_PICKUP_RETRY'
  }

  const isCheckboxEnabled = (order: Order) => {
    if (printFilter === 'sudah') return false
    return isPrintable(order) || isShippable(order)
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
  const shopeeCount = selectedOrders.filter((o) => o.platform === 'SHOPEE' && isPrintable(o)).length
  const tiktokCount = selectedOrders.filter((o) => o.platform === 'TIKTOK' && isPrintable(o)).length

  const shippableSelected = selectedOrders.filter(isShippable)
  const selectedMassAddress = massShipOptions?.pickup?.address_list?.find(
    (a) => a.address_id === massAddressId
  )
  const awbSelected = selectedOrders.filter((o) => o.platform === 'SHOPEE' && isPrintable(o))
  // One AWB request covers a single shop, so the button is only meaningful when
  // the selection has not spread across stores.
  const awbStoreIds = new Set(awbSelected.map((o) => o.storeId))

  const handlePrint = (platformFilter: string) => {
    const ids = selectedOrders
      .filter((o) => o.platform === platformFilter && isPrintable(o))
      .map((o) => o.id)
    router.push(`/print?ids=${ids.join(',')}`)
  }

  /** Pull a readable message out of an error whose body may be a Blob. */
  const readError = async (err: any): Promise<string> => {
    const body = err?.response?.data
    if (body instanceof Blob) {
      try {
        return JSON.parse(await body.text())?.error || 'Gagal memproses permintaan'
      } catch {
        return 'Gagal memproses permintaan'
      }
    }
    return body?.error || err?.message || 'Gagal memproses permintaan'
  }

  /**
   * Open the bulk-ship dialog and load the pickup addresses to offer.
   *
   * Shopee needs an address and a time slot before it will accept a pickup, and
   * those are a shop-level setting, so one order's answer covers the selection.
   */
  const openMassShip = async () => {
    if (shippableSelected.length === 0) return
    setMassShipOpen(true)
    setMassShipOptions(null)
    setMassAddressId(null)
    setMassPickupTimeId('')
    setBulkMessage(null)
    setBulkBusy(true)
    try {
      const res = await api.post<MassShipOptions>('/orders/ship-mass/options', {
        ids: shippableSelected.map((o) => o.id),
      })
      setMassShipOptions(res.data)

      const firstAddress = res.data.pickup?.address_list?.[0]
      if (firstAddress) {
        setMassAddressId(firstAddress.address_id)
        setMassPickupTimeId(firstAddress.time_slot_list?.[0]?.pickup_time_id || '')
      }
    } catch (err) {
      setBulkMessage({ type: 'error', text: await readError(err) })
      setMassShipOpen(false)
    } finally {
      setBulkBusy(false)
    }
  }

  const handleMassShip = async () => {
    if (shippableSelected.length === 0) return
    if (!massAddressId || !massPickupTimeId) {
      setBulkMessage({ type: 'error', text: 'Pilih alamat dan slot waktu penjemputan terlebih dahulu' })
      return
    }
    setBulkBusy(true)
    setBulkMessage(null)
    try {
      const res = await api.post<any>('/orders/ship-mass', {
        ids: shippableSelected.map((o) => o.id),
        mode: 'pickup',
        modeData: { address_id: massAddressId, pickup_time_id: massPickupTimeId },
      })
      setMassShipOpen(false)
      const shipped = res.data?.shipped?.length ?? 0
      const failed = res.data?.failed ?? []

      setBulkMessage({
        type: failed.length > 0 ? 'error' : 'success',
        text: failed.length > 0
          ? `${shipped} pesanan dikirim, ${failed.length} ditolak Shopee: ` +
            failed.map((f: any) => `${f.orderId} (${f.message || f.error})`).join(', ')
          : `${shipped} pesanan berhasil diatur pengirimannya.`,
      })

      setSelected(new Set())
      await fetchOrders()
    } catch (err) {
      setBulkMessage({ type: 'error', text: await readError(err) })
    } finally {
      setBulkBusy(false)
    }
  }

  const handleDownloadAwb = async () => {
    if (awbSelected.length === 0) return
    setBulkBusy(true)
    setBulkMessage(null)
    try {
      const res = await api.post('/print/awb', { ids: awbSelected.map((o) => o.id) }, {
        responseType: 'blob',
      })

      // Shopee decides the format — pdf, html or zip (KB §7.2)
      const disposition = res.headers?.['content-disposition'] || ''
      const suggested = /filename="([^"]+)"/.exec(disposition)?.[1]
      const blob = res.data as Blob

      const url = window.URL.createObjectURL(blob)
      const link = document.createElement('a')
      link.href = url
      link.download = suggested || `awb-${Date.now()}`
      document.body.appendChild(link)
      link.click()
      link.remove()
      window.URL.revokeObjectURL(url)

      setBulkMessage({ type: 'success', text: `AWB Shopee untuk ${awbSelected.length} paket berhasil diunduh.` })
      setSelected(new Set())
      await fetchOrders()
    } catch (err) {
      setBulkMessage({ type: 'error', text: await readError(err) })
    } finally {
      setBulkBusy(false)
    }
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
          {lastSyncedAt && (
            <p className="text-xs text-gray-500 dark:text-slate-400 mt-1 flex items-center gap-1.5">
              <Clock className="w-3.5 h-3.5 shrink-0" />
              <span>
                Data terakhir disinkronkan <span className="font-medium">{relativeTime(lastSyncedAt)}</span>
                <span className="text-gray-400 dark:text-slate-500"> · {absoluteTime(lastSyncedAt)}</span>
              </span>
            </p>
          )}
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

      {/* Standing sync health banner — visible without having to press Sync first */}
      {syncStatus && (syncStatus.needsReconnect > 0 || syncStatus.failing > 0 || syncStatus.partial > 0) && (
        <div className="rounded-lg border border-amber-200 dark:border-amber-800 bg-amber-50 dark:bg-amber-900/20 px-4 py-3">
          <div className="flex items-start gap-2 text-sm text-amber-800 dark:text-amber-200">
            <AlertTriangle className="w-4 h-4 mt-0.5 shrink-0" />
            <div className="space-y-1">
              {syncStatus.needsReconnect > 0 && (
                <p>
                  <span className="font-semibold">{syncStatus.needsReconnect} toko perlu dihubungkan ulang.</span>{' '}
                  Token Shopee-nya sudah kedaluwarsa, jadi pesanan tidak bisa ditarik sampai diotorisasi ulang di{' '}
                  <button onClick={() => router.push('/admin/stores')} className="underline font-medium">
                    Kelola Toko
                  </button>
                  .
                </p>
              )}
              {/* A partial run is the dangerous one: it looks like it worked,
                  but the statuses it lost were never refreshed, so those rows
                  keep showing whatever they said before. */}
              {syncStatus.partial > 0 && (
                <p>
                  <span className="font-semibold">
                    {syncStatus.partial} toko tersinkron sebagian.
                  </span>{' '}
                  Sebagian status gagal diambil dari Shopee, jadi pesanan pada status itu belum tentu terbarui.
                  Sync berikutnya akan mencoba lagi.
                </p>
              )}
              {syncStatus.stores
                .filter((s) => s.lastSyncStatus === 'ERROR' || s.lastSyncStatus === 'PARTIAL')
                .map((s) => (
                  <p key={s.id} className="text-xs break-words [overflow-wrap:anywhere]">
                    <span className="font-medium">{s.name}</span>
                    {s.lastSyncStatus === 'PARTIAL' && <span className="ml-1">(sebagian)</span>}
                    {s.needsReconnect ? ' — token kedaluwarsa' : ` — ${s.lastSyncError}`}
                  </p>
                ))}
            </div>
          </div>
        </div>
      )}

      {/* Sync runs but nothing consumes the queue */}
      {syncStatus && syncStatus.redisReady && !syncStatus.workerRunning && (
        <div className="rounded-lg border border-blue-200 dark:border-blue-800 bg-blue-50 dark:bg-blue-900/20 px-4 py-3 text-sm text-blue-800 dark:text-blue-200 flex items-start gap-2">
          <AlertTriangle className="w-4 h-4 mt-0.5 shrink-0" />
          <p>
            Worker sync tidak berjalan. Sync manual tetap bekerja (dijalankan langsung di server), tapi sync
            otomatis tiap 15 menit tidak akan jalan sampai <code className="font-mono">npm run worker</code> dihidupkan.
          </p>
        </div>
      )}

      {/* Orders that exist but cannot be printed yet */}
      {awaitingTracking > 0 && (
        <div className="rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-800/60 px-4 py-3 text-sm text-slate-700 dark:text-slate-300 flex items-start gap-2">
          <Package className="w-4 h-4 mt-0.5 shrink-0" />
          <p>
            <span className="font-semibold">{awaitingTracking} pesanan belum punya nomor resi</span> — kurir belum
            menerbitkannya. Pesanan tetap ditampilkan, tapi belum bisa dicentang untuk dicetak. Gunakan
            &ldquo;Ambil nomor resi&rdquo; di kolom Aksi, atau tunggu sync berikutnya.
          </p>
        </div>
      )}

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
              <option value="UNPAID">Belum Bayar</option>
              <option value="READY_TO_SHIP">Siap Kirim</option>
              <option value="PROCESSED">Sudah Diatur</option>
              <option value="RETRY_SHIP">Pickup Gagal</option>
              <option value="SHIPPED">Dikirim</option>
              <option value="IN_CANCEL">Minta Batal</option>
              <option value="CANCELLED">Dibatalkan</option>
              <option value="COMPLETED">Selesai</option>
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
                <th className="table-header">Produk</th>
                <th className="table-header">Kurir</th>
                <th className="table-header">Status</th>
                <th className="table-header">Tanggal</th>
                <th className="table-header w-10">Aksi</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100 dark:divide-slate-700/60">
              {loading ? (
                <tr>
                  <td colSpan={10} className="px-4 py-16 text-center">
                    <Loader2 className="w-8 h-8 animate-spin text-primary-600 mx-auto" />
                    <p className="text-sm text-gray-500 dark:text-slate-400 mt-2">Memuat pesanan...</p>
                  </td>
                </tr>
              ) : orders.length === 0 ? (
                <tr>
                  <td colSpan={10} className="px-4 py-16 text-center">
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
                        {order.packageNumber && (
                          <p className="text-xs text-gray-400 dark:text-slate-500" title="Nomor paket">
                            pkg {order.packageNumber}
                          </p>
                        )}
                      </td>
                      <td className="table-cell">{order.storeName}</td>
                      <td className="table-cell">
                        <span className={platformBadgeClass[order.platform] || 'badge'}>
                          {order.platform}
                        </span>
                      </td>
                      <td className="table-cell">{order.buyerName}</td>
                      <td className="table-cell w-[200px] max-w-[200px]">
                        {order.items.length === 0 ? (
                          <span className="text-xs text-gray-400 dark:text-slate-500">—</span>
                        ) : (
                          <div
                            className="space-y-0.5"
                            // Names run long enough that showing them in full would
                            // dominate the row; the full list stays reachable on hover.
                            title={order.items
                              .map((it) => `${it.quantity}x ${it.name}${it.variant ? ` (${it.variant})` : ''}`)
                              .join('\n')}
                          >
                            {order.items.slice(0, 2).map((it, idx) => (
                              <p key={idx} className="text-sm text-gray-700 dark:text-slate-300 truncate">
                                <span className="text-gray-400 dark:text-slate-500 font-mono text-xs">
                                  {it.quantity}x
                                </span>{' '}
                                {it.name}
                              </p>
                            ))}
                            {order.items.length > 2 && (
                              <p className="text-xs text-gray-400 dark:text-slate-500">
                                +{order.items.length - 2} produk lain
                              </p>
                            )}
                          </div>
                        )}
                      </td>
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
                        {order.logisticsStatus && (
                          <p className="text-xs text-gray-400 dark:text-slate-500 mt-1">
                            {logisticsLabel[order.logisticsStatus] || order.logisticsStatus}
                          </p>
                        )}
                      </td>
                      <td className="table-cell text-gray-500 dark:text-slate-400 whitespace-nowrap">
                        {new Date(order.createdAt).toLocaleDateString('id-ID', {
                          day: '2-digit',
                          month: 'short',
                          year: 'numeric',
                        })}
                      </td>
                      <td className="table-cell">
                        <OrderActions order={order} onDone={() => fetchOrders({ background: true })} />
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

      {/* Bulk action result — only when no selection bar is showing.
          The bulk actions live in a bar fixed to the bottom of the viewport, but
          this message renders in normal page flow below a long table. Pressing a
          button there produced a result the operator never saw: it landed
          off-screen, behind or above the bar. While a selection exists the
          message is rendered inside that bar instead (see below), so it appears
          where the click happened. */}
      {bulkMessage && selected.size === 0 && (
        <div
          className={`rounded-lg border px-4 py-3 text-sm flex items-start justify-between gap-4 ${
            bulkMessage.type === 'success'
              ? 'bg-green-50 dark:bg-green-900/20 border-green-200 dark:border-green-800 text-green-700 dark:text-green-300'
              : 'bg-red-50 dark:bg-red-900/20 border-red-200 dark:border-red-800 text-red-700 dark:text-red-300'
          }`}
        >
          <span>{bulkMessage.text}</span>
          <button onClick={() => setBulkMessage(null)} className="shrink-0">
            <X className="w-4 h-4" />
          </button>
        </div>
      )}

      {/* Bulk ship dialog. Shopee will not accept a pickup without an address
          and a time slot, and those are a shop-level setting — so the operator
          chooses once here and the whole selection is shipped with it. */}
      {massShipOpen && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
          onClick={() => { if (!bulkBusy) setMassShipOpen(false) }}
        >
          <div
            className="card w-full max-w-lg p-5 space-y-4 max-h-[85vh] overflow-y-auto"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-start justify-between gap-4">
              <div>
                <h3 className="font-semibold text-gray-900 dark:text-slate-100">Kirim Massal</h3>
                <p className="text-xs text-gray-500 dark:text-slate-400 mt-0.5">
                  {shippableSelected.length} pesanan · dijemput kurir (pickup)
                </p>
              </div>
              <button onClick={() => setMassShipOpen(false)} disabled={bulkBusy} className="btn-ghost p-1">
                <X className="w-4 h-4" />
              </button>
            </div>

            {bulkMessage?.type === 'error' && (
              <div className="rounded-lg bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 px-3 py-2 text-sm text-red-700 dark:text-red-300 break-words [overflow-wrap:anywhere]">
                {bulkMessage.text}
              </div>
            )}

            {bulkBusy && !massShipOptions && (
              <div className="flex items-center gap-2 text-sm text-gray-500 dark:text-slate-400">
                <Loader2 className="w-4 h-4 animate-spin" /> Menghubungi Shopee…
              </div>
            )}

            {massShipOptions && (
              <>
                {!massShipOptions.availableModes?.includes('pickup') && (
                  <div className="rounded-lg bg-amber-50 dark:bg-amber-900/20 border border-amber-200 dark:border-amber-800 px-3 py-2 text-sm text-amber-700 dark:text-amber-300">
                    Channel ini tidak menawarkan mode pickup (tersedia:{' '}
                    {massShipOptions.availableModes?.join(', ') || 'tidak ada'}). Pengiriman kemungkinan akan ditolak.
                  </div>
                )}

                <div>
                  <label className="block text-sm font-medium mb-1.5 text-gray-700 dark:text-slate-300">
                    Alamat penjemputan
                  </label>
                  <select
                    className="input"
                    value={massAddressId ?? ''}
                    onChange={(e) => {
                      const id = Number(e.target.value)
                      setMassAddressId(id)
                      const addr = massShipOptions.pickup?.address_list?.find((a) => a.address_id === id)
                      setMassPickupTimeId(addr?.time_slot_list?.[0]?.pickup_time_id || '')
                    }}
                  >
                    {(massShipOptions.pickup?.address_list || []).map((a) => (
                      <option key={a.address_id} value={a.address_id}>
                        {[a.address, a.city, a.state].filter(Boolean).join(', ') || `Alamat #${a.address_id}`}
                      </option>
                    ))}
                  </select>
                </div>

                <div>
                  <label className="block text-sm font-medium mb-1.5 text-gray-700 dark:text-slate-300">
                    Slot waktu
                  </label>
                  <select
                    className="input"
                    value={massPickupTimeId}
                    onChange={(e) => setMassPickupTimeId(e.target.value)}
                  >
                    {(selectedMassAddress?.time_slot_list || []).map((slot) => (
                      <option key={slot.pickup_time_id} value={slot.pickup_time_id}>
                        {slot.time_text ||
                          (slot.date ? new Date(slot.date * 1000).toLocaleString('id-ID') : slot.pickup_time_id)}
                      </option>
                    ))}
                  </select>
                  {(selectedMassAddress?.time_slot_list || []).length === 0 && (
                    <p className="text-xs text-amber-600 dark:text-amber-400 mt-1">
                      Tidak ada slot tersedia untuk alamat ini.
                    </p>
                  )}
                </div>

                <p className="text-xs text-gray-500 dark:text-slate-400">
                  Alamat dan slot ini dipakai untuk seluruh {shippableSelected.length} pesanan, dikirim satu per satu
                  ke Shopee. Nomor resi tidak ditunggu di sini — akan terisi pada sync berikutnya.
                </p>

                <div className="flex justify-end gap-2 pt-2">
                  <button onClick={() => setMassShipOpen(false)} disabled={bulkBusy} className="btn-ghost">
                    Batal
                  </button>
                  <button
                    onClick={handleMassShip}
                    disabled={bulkBusy || !massAddressId || !massPickupTimeId}
                    className="btn-primary"
                  >
                    {bulkBusy && <Loader2 className="w-4 h-4 animate-spin" />}
                    Kirim {shippableSelected.length} pesanan
                  </button>
                </div>
              </>
            )}
          </div>
        </div>
      )}

      {/* Selection Bar */}
      {selected.size > 0 && (
        <div className="fixed bottom-0 left-64 right-0 bg-white dark:bg-slate-800 border-t border-gray-200 dark:border-slate-700 shadow-lg px-6 py-4 z-20">
          {bulkMessage && (
            <div
              className={`rounded-lg border px-4 py-3 text-sm flex items-start justify-between gap-4 mb-3 ${
                bulkMessage.type === 'success'
                  ? 'bg-green-50 dark:bg-green-900/20 border-green-200 dark:border-green-800 text-green-700 dark:text-green-300'
                  : 'bg-red-50 dark:bg-red-900/20 border-red-200 dark:border-red-800 text-red-700 dark:text-red-300'
              }`}
            >
              <span>{bulkMessage.text}</span>
              <button onClick={() => setBulkMessage(null)} className="shrink-0">
                <X className="w-4 h-4" />
              </button>
            </div>
          )}
          <div className="flex items-center justify-between gap-4 flex-wrap">
            <div className="text-sm text-gray-700 dark:text-slate-300">
              <span className="font-semibold">{selected.size} pesanan</span> dipilih
              {selectedPlatforms.size > 0 && (
                <span className="text-gray-500 dark:text-slate-400">
                  {' '}({Array.from(selectedPlatforms).join(', ')})
                </span>
              )}
            </div>
            <div className="flex items-center gap-3 flex-wrap">
              {shippableSelected.length > 0 && (
                <button
                  onClick={openMassShip}
                  disabled={bulkBusy}
                  className="btn bg-shopee text-white hover:bg-orange-600"
                >
                  {bulkBusy ? <Loader2 className="w-4 h-4 animate-spin" /> : <Truck className="w-4 h-4" />}
                  Kirim Massal ({shippableSelected.length})
                </button>
              )}
              {awbSelected.length > 0 && (
                <button
                  onClick={handleDownloadAwb}
                  disabled={bulkBusy || awbStoreIds.size > 1}
                  title={
                    awbStoreIds.size > 1
                      ? 'Satu permintaan AWB hanya boleh untuk satu toko'
                      : 'Unduh AWB resmi dari Shopee'
                  }
                  className="btn-secondary"
                >
                  {bulkBusy ? <Loader2 className="w-4 h-4 animate-spin" /> : <FileDown className="w-4 h-4" />}
                  AWB Shopee ({awbSelected.length})
                </button>
              )}
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
