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
  RotateCcw,
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
  /** Shopee's deadline for handing the parcel over. Null until a sync sees one. */
  shipByDate?: string | null
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
  /** Whether the repeatable sync jobs are registered — a reachable Redis is
      not the same thing, and only this says anything is scheduled to run. */
  autoSyncRunning?: boolean
}

/**
 * One courier's worth of a bulk shipment (POST /orders/ship-mass/options).
 *
 * A pickup slot belongs to one courier's schedule, so a mixed selection comes
 * back split — one group per courier and shop, each with its own answers.
 */
interface MassShipGroup {
  key: string
  storeId: string
  storeName: string
  courier: string
  logisticsChannelId: number | null
  orderRowIds: string[]
  availableModes: string[]
  suggestedMode?: string | null
  /** Per-mode list of fields Shopee still wants; an empty dropoff array means
      an empty object is all it needs (KB §5.1). */
  infoNeeded?: Record<string, string[] | undefined>
  dropoff?: { branch_list?: Array<{ branch_id: number; address?: string }> } | null
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
  /** Courier that does not collect — Pos and JNE. Advisory, not enforced. */
  dropoffOnly?: boolean
  /** Why this courier could not be asked, when Shopee refused every attempt. */
  error?: string
}

interface MassShipOptions {
  groups: MassShipGroup[]
}

/** One courier's pickup options when re-scheduling a failed collection. */
interface MassRetryGroup {
  key: string
  storeName: string
  courier: string
  orderRowIds: string[]
  dropoffOnly?: boolean
  pickup?: MassShipGroup['pickup']
  error?: string
}

/** What the operator picked for one courier when re-scheduling. */
interface MassRetryChoice {
  addressId: number | null
  pickupTimeId: string
}

/** What the operator picked for one courier group. */
interface MassShipChoice {
  mode: 'pickup' | 'dropoff'
  addressId: number | null
  pickupTimeId: string
}

type PrintFilter = 'belum' | 'sudah' | 'semua'

type OrderTab = 'all' | 'unpaid' | 'toShip' | 'shipped'
type SubTab = 'all' | 'toProcess' | 'processed'

/**
 * Sort orders the list can be read in.
 *
 * `deadline` is how the work is actually prioritised — an order due today
 * outranks one that arrived first but is due Friday — which is the ordering
 * Komplace shows and this list could not.
 */
const SORT_OPTIONS = [
  { key: 'newest', label: 'Terbaru' },
  { key: 'deadline', label: 'Batas kirim terdekat' },
] as const
type SortKey = (typeof SORT_OPTIONS)[number]['key']

const DEADLINE_TONES = {
  overdue: 'text-red-700 dark:text-red-400 font-semibold',
  today:   'text-orange-700 dark:text-orange-400 font-semibold',
  soon:    'text-amber-700 dark:text-amber-400',
  later:   'text-gray-500 dark:text-slate-400',
} as const

/**
 * Time left to hand the parcel to the courier.
 *
 * Shown as a countdown rather than a date because that is the decision being
 * made with it: "hari ini" moves an order to the top of the pile, "28 Agu"
 * leaves the operator doing the arithmetic. Days are compared at midnight
 * boundaries, so an order due at 23:00 tonight reads "hari ini" and not
 * "besok" — which is how a deadline is actually spoken about.
 */
function shipDeadline(value?: string | null) {
  if (!value) return null
  const due = new Date(value)
  if (Number.isNaN(due.getTime())) return null

  const now = new Date()
  const midnight = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime()
  const days = Math.round((midnight(due) - midnight(now)) / 86_400_000)
  const time = due.toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit' })
  const full = due.toLocaleString('id-ID', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' })

  if (due.getTime() < now.getTime()) {
    return { label: days === 0 ? `Lewat ${time}` : `Lewat ${Math.abs(days)} hari`, tone: 'overdue' as const, title: full }
  }
  if (days === 0) return { label: `Hari ini ${time}`, tone: 'today' as const, title: full }
  if (days === 1) return { label: `Besok ${time}`, tone: 'soon' as const, title: full }
  return { label: `${days} hari lagi`, tone: 'later' as const, title: full }
}

/**
 * Primary tabs, in marketplace statuses — the only counts that can be checked
 * against Seller Centre.
 *
 * Selesai / Pembatalan / Retur are missing on purpose: sync fetches four
 * statuses within 15 days, so those totals would not match Shopee. They stay
 * reachable through the status dropdown until a backfill makes honest tabs
 * possible.
 */
const ORDER_TABS: { key: OrderTab; label: string }[] = [
  { key: 'all',     label: 'Semua' },
  { key: 'unpaid',  label: 'Belum Bayar' },
  { key: 'toShip',  label: 'Perlu Dikirim' },
  { key: 'shipped', label: 'Dikirim' },
]

/** Inside "Perlu Dikirim", split by whether the shipment has been arranged. */
const ORDER_SUB_TABS: { key: SubTab; label: string }[] = [
  { key: 'all',       label: 'Semua' },
  { key: 'toProcess', label: 'Perlu Diproses' },
  { key: 'processed', label: 'Telah Diproses' },
]

/** Statuses each tab covers, so the dropdown cannot offer a contradiction. */
const TAB_STATUSES: Record<OrderTab, string[] | null> = {
  all:     null,
  unpaid:  ['UNPAID'],
  toShip:  ['READY_TO_SHIP', 'RETRY_SHIP', 'PROCESSED'],
  shipped: ['SHIPPED'],
}

const STATUS_LABELS: Record<string, string> = {
  UNPAID: 'Belum Bayar',
  READY_TO_SHIP: 'Siap Kirim',
  PROCESSED: 'Sudah Diatur',
  RETRY_SHIP: 'Pickup Gagal',
  SHIPPED: 'Dikirim',
  IN_CANCEL: 'Minta Batal',
  CANCELLED: 'Dibatalkan',
  COMPLETED: 'Selesai',
}

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

/** YYYY-MM-DD in local time — `toISOString` would shift a WIB date back a day. */
const isoDate = (d: Date) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`

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
  /** Orders past their deadline, and due before midnight — what to work on first. */
  const [urgency, setUrgency] = useState({ overdue: 0, dueToday: 0 })
  const [sort, setSort] = useState<SortKey>('newest')
  const [loading, setLoading] = useState(true)
  const [syncing, setSyncing] = useState(false)
  const [stores, setStores] = useState<Store[]>([])
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [bulkBusy, setBulkBusy] = useState(false)
  const [bulkMessage, setBulkMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null)
  const [massShipOpen, setMassShipOpen] = useState(false)
  const [massShipOptions, setMassShipOptions] = useState<MassShipOptions | null>(null)
  /** Keyed by group key — every courier keeps its own address and slot. */
  const [massChoices, setMassChoices] = useState<Record<string, MassShipChoice>>({})
  const [massRetryOpen, setMassRetryOpen] = useState(false)
  const [massRetryOptions, setMassRetryOptions] = useState<{ groups: MassRetryGroup[] } | null>(null)
  const [retryChoices, setRetryChoices] = useState<Record<string, MassRetryChoice>>({})
  const [syncStatus, setSyncStatus] = useState<SyncStatus | null>(null)
  const [awaitingTracking, setAwaitingTracking] = useState(0)
  const [couriers, setCouriers] = useState<string[]>([])

  // Filters
  // Print status is a secondary filter now, not the page's primary navigation:
  // `printedAt` only ever knows about labels printed from this app, so it can
  // never be reconciled against Shopee. The tabs above it can.
  const [printFilter, setPrintFilter] = useState<PrintFilter>(
    (searchParams.get('printFilter') as PrintFilter) || 'semua'
  )
  const [tab, setTab] = useState<OrderTab>(
    (searchParams.get('tab') as OrderTab) || 'toShip'
  )
  const [subTab, setSubTab] = useState<SubTab>(
    (searchParams.get('subTab') as SubTab) || 'all'
  )
  const [tabCounts, setTabCounts] = useState<Record<OrderTab, number>>(
    { all: 0, unpaid: 0, toShip: 0, shipped: 0 }
  )
  const [subTabCounts, setSubTabCounts] = useState<Record<SubTab, number>>(
    { all: 0, toProcess: 0, processed: 0 }
  )
  const [page, setPage] = useState(1)
  const [search, setSearch] = useState('')
  const [platform, setPlatform] = useState('')
  const [storeId, setStoreId] = useState('')
  const [status, setStatus] = useState('')
  const [courier, setCourier] = useState('')
  // The page opens on today's orders: that is the day an operator is packing,
  // and an unbounded list makes every load pull months of history it has to
  // page through. Widening the range is one click on the date boxes.
  const today = isoDate(new Date())
  const [dateFrom, setDateFrom] = useState(today)
  const [dateTo, setDateTo] = useState(today)

  const [limit, setLimit] = useState(20)

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
   * The filters that decide *which* orders are in scope.
   *
   * Shared by the table and by any bulk action that claims to act on
   * everything currently filtered — a button that re-derives the filters
   * itself eventually disagrees with the table it was launched from, and the
   * operator has no way to tell which of the two is right.
   */
  const currentFilters = useCallback(() => {
    const f: Record<string, string> = { tab, subTab }
    if (search) f.search = search
    if (platform) f.platform = platform
    if (storeId) f.storeId = storeId
    if (status) f.status = status
    if (courier) f.courier = courier
    if (dateFrom) f.dateFrom = dateFrom
    if (dateTo) f.dateTo = dateTo
    return f
  }, [tab, subTab, search, platform, storeId, status, courier, dateFrom, dateTo])

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
      const params: any = { page, limit, printFilter, sort, ...currentFilters() }

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
      setUrgency({ overdue: rawCounts.overdue ?? 0, dueToday: rawCounts.dueToday ?? 0 })
      if (data.tabCounts) setTabCounts(data.tabCounts)
      if (data.subTabCounts) setSubTabCounts(data.subTabCounts)

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
  }, [page, limit, printFilter, sort, currentFilters])

  const fetchStores = async () => {
    try {
      const res = await api.get<any>('/stores')
      const storeData = Array.isArray(res.data) ? res.data : (res.data?.data || [])
      setStores(Array.isArray(storeData) ? storeData : [])
    } catch {
      setStores([])
    }
  }

  /**
   * The courier list follows the store and platform filters: showing couriers
   * that no visible order uses would offer the operator a selection that can
   * only ever come back empty.
   */
  const fetchCouriers = useCallback(async () => {
    try {
      const params: any = {}
      if (storeId) params.storeId = storeId
      if (platform) params.platform = platform
      const res = await api.get<any>('/orders/couriers', { params })
      const list = Array.isArray(res.data) ? res.data : (res.data?.data || [])
      setCouriers(Array.isArray(list) ? list : [])
    } catch {
      setCouriers([])
    }
  }, [storeId, platform])

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

  useEffect(() => {
    fetchCouriers()
  }, [fetchCouriers])

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
  }, [printFilter, tab, subTab, page])

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

  /** Keep the chosen view in the URL, so a reload or a shared link lands back on it. */
  const pushParams = (patch: Record<string, string>) => {
    const params = new URLSearchParams(searchParams.toString())
    for (const [k, v] of Object.entries(patch)) params.set(k, v)
    router.push(`/orders?${params.toString()}`)
  }

  const handlePrintFilterChange = (filter: PrintFilter) => {
    setPrintFilter(filter)
    setPage(1)
    pushParams({ printFilter: filter })
  }

  const handleTabChange = (next: OrderTab) => {
    setTab(next)
    setPage(1)
    // A status carried over from another tab would silently empty the list, so
    // it is dropped unless the new tab actually covers it.
    const allowed = TAB_STATUSES[next]
    const keepStatus = !status || !allowed || allowed.includes(status)
    if (!keepStatus) setStatus('')
    // Sub-tabs only exist inside Perlu Dikirim; leaving one set would carry an
    // invisible filter into a tab that shows no sub-tabs at all.
    setSubTab('all')
    pushParams({ tab: next, subTab: 'all', ...(keepStatus ? {} : { status: '' }) })
  }

  const handleSubTabChange = (next: SubTab) => {
    setSubTab(next)
    setPage(1)
    pushParams({ subTab: next })
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
  /**
   * Awaiting a second attempt at collection: the shipment exists, the courier
   * simply never came.
   *
   * These need `update_shipping_order`, not `ship_order` — sending them through
   * a bulk ship only makes it notice the shipment is already arranged and
   * refresh the tracking number, which looks like success and changes nothing.
   */
  const isRetryable = (order: Order) =>
    order.platform === 'SHOPEE' &&
    (order.status === 'RETRY_SHIP' || order.logisticsStatus === 'LOGISTICS_PICKUP_RETRY')

  const isShippable = (order: Order) => {
    if (order.platform !== 'SHOPEE') return false
    if (!['READY_TO_SHIP', 'RETRY_SHIP'].includes(order.status)) return false
    // A retry belongs to the other button, not this one.
    if (isRetryable(order)) return false
    // Unknown fulfillment state: let the server make the call, it re-reads live
    if (!order.logisticsStatus) return true
    return order.logisticsStatus === 'LOGISTICS_READY'
  }

  const isCheckboxEnabled = (order: Order) => {
    // Keyed on the order, not on which view is open: printed and unprinted rows
    // now sit on the same page, so "which tab am I on" no longer answers this.
    if (order.printed) return false
    return isPrintable(order) || isShippable(order) || isRetryable(order)
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
  const retrySelected = selectedOrders.filter(isRetryable)
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
   * The default choice for one courier.
   *
   * `suggestedMode` already accounts for couriers that do not collect, so this
   * mostly follows it. The fallback repeats the rule rather than defaulting to
   * pickup: a Pos or JNE batch defaulting to "dijemput" is a collection nobody
   * turns up for, and the operator has no reason to suspect the default.
   */
  const defaultChoice = (group: MassShipGroup): MassShipChoice => {
    const modes = group.availableModes || []
    const suggested = group.suggestedMode
    const fallback: 'pickup' | 'dropoff' = group.dropoffOnly
      ? (modes.includes('dropoff') ? 'dropoff' : 'pickup')
      : (modes.includes('pickup') ? 'pickup' : 'dropoff')
    const mode: 'pickup' | 'dropoff' =
      suggested === 'pickup' || suggested === 'dropoff' ? suggested : fallback

    const firstAddress = group.pickup?.address_list?.[0]
    return {
      mode,
      addressId: firstAddress?.address_id ?? null,
      pickupTimeId: firstAddress?.time_slot_list?.[0]?.pickup_time_id || '',
    }
  }

  /**
   * Open the bulk-ship dialog and load each courier's own pickup options.
   *
   * One answer per courier and shop, because a pickup slot belongs to one
   * courier's schedule: applying SiCepat's slot to an SPX package is what
   * Shopee rejects as "Pickup time is out of range".
   */
  const openMassShip = async () => {
    if (shippableSelected.length === 0) return
    setMassShipOpen(true)
    setMassShipOptions(null)
    setMassChoices({})
    setBulkMessage(null)
    setBulkBusy(true)
    try {
      const res = await api.post<MassShipOptions>('/orders/ship-mass/options', {
        ids: shippableSelected.map((o) => o.id),
      })
      const groups = res.data.groups || []
      setMassShipOptions({ groups })
      setMassChoices(Object.fromEntries(
        groups.filter((g) => g.availableModes.length > 0).map((g) => [g.key, defaultChoice(g)])
      ))
    } catch (err) {
      setBulkMessage({ type: 'error', text: await readError(err) })
      setMassShipOpen(false)
    } finally {
      setBulkBusy(false)
    }
  }

  /** Groups that can actually be sent — one Shopee refused is skipped, not blocking. */
  const shippableGroups = (massShipOptions?.groups || []).filter((g) => g.availableModes.length > 0)
  const blockedGroups = (massShipOptions?.groups || []).filter((g) => g.availableModes.length === 0)

  // Only a pickup needs an address and a slot, and only for its own courier.
  // Demanding them across the board is what made "antar ke counter"
  // unselectable, and one courier's missing slot must not block the others.
  const incompleteGroups = shippableGroups.filter((g) => {
    const choice = massChoices[g.key]
    return choice?.mode === 'pickup' && (!choice.addressId || !choice.pickupTimeId)
  })

  const setChoice = (key: string, patch: Partial<MassShipChoice>) =>
    setMassChoices((prev) => ({ ...prev, [key]: { ...prev[key], ...patch } }))

  /** Orders actually covered by the batches, which excludes any blocked courier. */
  const groupedOrderCount = shippableGroups.reduce((n, g) => n + g.orderRowIds.length, 0)

  const handleMassShip = async () => {
    if (shippableGroups.length === 0) return
    if (incompleteGroups.length > 0) {
      setBulkMessage({
        type: 'error',
        text: `Pilih alamat dan slot penjemputan untuk ${incompleteGroups.map((g) => g.courier).join(', ')}`,
      })
      return
    }
    setBulkBusy(true)
    setBulkMessage(null)
    try {
      const res = await api.post<any>('/orders/ship-mass', {
        groups: shippableGroups.map((g) => {
          const choice = massChoices[g.key]
          return {
            ids: g.orderRowIds,
            mode: choice.mode,
            // Drop-off takes an empty object unless the channel asks for more (KB §5.1)
            modeData: choice.mode === 'pickup'
              ? { address_id: choice.addressId, pickup_time_id: choice.pickupTimeId }
              : {},
          }
        }),
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

  /** Open the bulk retry dialog and load each courier's pickup schedule. */
  const openMassRetry = async () => {
    if (retrySelected.length === 0) return
    setMassRetryOpen(true)
    setMassRetryOptions(null)
    setRetryChoices({})
    setBulkMessage(null)
    setBulkBusy(true)
    try {
      const res = await api.post<{ groups: MassRetryGroup[] }>('/orders/retry-ship-mass/options', {
        ids: retrySelected.map((o) => o.id),
      })
      const groups = res.data.groups || []
      setMassRetryOptions({ groups })
      setRetryChoices(Object.fromEntries(
        groups.filter((g) => g.pickup).map((g) => {
          const address = g.pickup?.address_list?.[0]
          return [g.key, {
            addressId: address?.address_id ?? null,
            pickupTimeId: address?.time_slot_list?.[0]?.pickup_time_id || '',
          }]
        })
      ))
    } catch (err) {
      setBulkMessage({ type: 'error', text: await readError(err) })
      setMassRetryOpen(false)
    } finally {
      setBulkBusy(false)
    }
  }

  /** Couriers that answered with a schedule; one that did not is skipped, not blocking. */
  const retryGroups = (massRetryOptions?.groups || []).filter((g) => g.pickup)
  const blockedRetryGroups = (massRetryOptions?.groups || []).filter((g) => !g.pickup)
  const incompleteRetryGroups = retryGroups.filter((g) => {
    const choice = retryChoices[g.key]
    return !choice?.addressId || !choice?.pickupTimeId
  })

  const setRetryChoice = (key: string, patch: Partial<MassRetryChoice>) =>
    setRetryChoices((prev) => ({ ...prev, [key]: { ...prev[key], ...patch } }))

  const handleMassRetry = async () => {
    if (retryGroups.length === 0) return
    if (incompleteRetryGroups.length > 0) {
      setBulkMessage({
        type: 'error',
        text: `Pilih alamat dan slot penjemputan untuk ${incompleteRetryGroups.map((g) => g.courier).join(', ')}`,
      })
      return
    }
    setBulkBusy(true)
    setBulkMessage(null)
    try {
      const res = await api.post<any>('/orders/retry-ship-mass', {
        groups: retryGroups.map((g) => ({
          ids: g.orderRowIds,
          addressId: retryChoices[g.key].addressId,
          pickupTimeId: retryChoices[g.key].pickupTimeId,
        })),
      })
      setMassRetryOpen(false)
      const done = res.data?.rescheduled?.length ?? 0
      const failed = res.data?.failed ?? []
      setBulkMessage({
        type: failed.length > 0 ? 'error' : 'success',
        text: failed.length > 0
          ? `${done} pesanan dijadwalkan ulang, ${failed.length} ditolak Shopee: ` +
            failed.map((f: any) => `${f.orderId} (${f.message})`).join(', ')
          : `${done} pesanan berhasil dijadwalkan ulang penjemputannya.`,
      })
      setSelected(new Set())
      await fetchOrders()
    } catch (err) {
      setBulkMessage({ type: 'error', text: await readError(err) })
    } finally {
      setBulkBusy(false)
    }
  }

  /**
   * Ask the courier for every waybill still missing across the whole filter.
   *
   * This used to be scoped to the rows on screen while the banner above it
   * counted the entire filter — so "Ambil semua nomor resi" on a backlog of two
   * hundred fetched fifty and left the same banner showing, with nothing to say
   * the button had only done part of the job. The server picks the rows now,
   * most urgent first, and reports how many are left.
   */
  const handleRefreshTrackingAll = async () => {
    if (awaitingTracking === 0) return

    setBulkBusy(true)
    setBulkMessage(null)
    try {
      const res = await api.post<any>('/orders/refresh-tracking-all', currentFilters())
      const found = res.data?.refreshed?.length ?? 0
      const pending = res.data?.stillMissing?.length ?? 0
      const failed = res.data?.failed ?? []
      const remaining = res.data?.remaining ?? 0

      setBulkMessage({
        // Nothing found is not an error — the courier simply has not issued
        // them yet, and saying "gagal" would send the operator hunting for a
        // fault that is not theirs.
        type: failed.length > 0 ? 'error' : 'success',
        text: [
          found > 0 ? `${found} nomor resi didapat` : null,
          pending > 0 ? `${pending} belum diterbitkan kurir` : null,
          failed.length > 0
            ? `${failed.length} gagal: ${failed.map((f: any) => `${f.orderId} (${f.message})`).join(', ')}`
            : null,
          // Said plainly rather than left to be inferred from a banner that
          // stubbornly will not clear.
          remaining > 0 ? `masih ada ${remaining} lagi — klik sekali lagi untuk melanjutkan` : null,
        ].filter(Boolean).join(' · ') || 'Tidak ada perubahan',
      })

      await fetchOrders({ background: true })
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
    setPrintFilter('semua')
    setDateFrom(today)
    setDateTo(today)
    setPage(1)
  }

  // Today's range is the default, not something the operator chose, so it does
  // not by itself light up Reset or explain an empty table.
  const isDefaultRange = dateFrom === today && dateTo === today
  // Tabs are navigation, not filters, so they stay out of this — but the print
  // dropdown is one now that it no longer leads the page.
  const hasActiveFilters = platform || storeId || status || courier || !isDefaultRange || search
    || printFilter !== 'semua'
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
      {syncStatus && (syncStatus.needsReconnect > 0 || syncStatus.failing > 0 || syncStatus.partial > 0
        || syncStatus.autoSyncRunning === false) && (
        <div className="rounded-lg border border-amber-200 dark:border-amber-800 bg-amber-50 dark:bg-amber-900/20 px-4 py-3">
          <div className="flex items-start gap-2 text-sm text-amber-800 dark:text-amber-200">
            <AlertTriangle className="w-4 h-4 mt-0.5 shrink-0" />
            <div className="space-y-1">
              {/* Nothing is scheduled, so the list only moves when someone
                  presses Sync. Without this the sole clue is a "last synced"
                  stamp that quietly stops advancing. */}
              {syncStatus.autoSyncRunning === false && (
                <p>
                  <span className="font-semibold">Sync otomatis sedang tidak berjalan.</span>{' '}
                  Pesanan baru tidak akan masuk sendiri — tekan &ldquo;Sync Pesanan&rdquo; untuk menarik sekarang.
                  Sistem terus mencoba menyalakannya kembali sendiri.
                </p>
              )}
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

      {/* Deadline pressure. Counted across the whole filter rather than the
          open tab, because an order running out of time matters wherever the
          operator happens to be looking. */}
      {(urgency.overdue > 0 || urgency.dueToday > 0) && (
        <div className={`rounded-lg border px-4 py-3 text-sm flex flex-col sm:flex-row sm:items-center gap-3 ${
          urgency.overdue > 0
            ? 'border-red-200 dark:border-red-800 bg-red-50 dark:bg-red-950/30 text-red-800 dark:text-red-200'
            : 'border-amber-200 dark:border-amber-800 bg-amber-50 dark:bg-amber-950/30 text-amber-900 dark:text-amber-200'
        }`}>
          <div className="flex items-start gap-2 flex-1">
            <Clock className="w-4 h-4 mt-0.5 shrink-0" />
            <p>
              {urgency.overdue > 0 && (
                <span className="font-semibold">{urgency.overdue} pesanan lewat batas kirim Shopee</span>
              )}
              {urgency.overdue > 0 && urgency.dueToday > 0 && ' · '}
              {urgency.dueToday > 0 && <span>{urgency.dueToday} jatuh tempo hari ini</span>}
            </p>
          </div>
          {sort !== 'deadline' && (
            <button
              onClick={() => { setSort('deadline'); setPage(1) }}
              className="btn-secondary self-start sm:self-auto shrink-0"
            >
              Urutkan yang paling mepet
            </button>
          )}
        </div>
      )}

      {/* Orders that exist but cannot be printed yet */}
      {awaitingTracking > 0 && (
        <div className="rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-800/60 px-4 py-3 text-sm text-slate-700 dark:text-slate-300 flex flex-col sm:flex-row sm:items-center gap-3">
          <div className="flex items-start gap-2 flex-1">
            <Package className="w-4 h-4 mt-0.5 shrink-0" />
            <p>
              <span className="font-semibold">{awaitingTracking} pesanan belum punya nomor resi</span> — kurir belum
              menerbitkannya. Pesanan tetap ditampilkan, tapi belum bisa dicentang untuk dicetak.
            </p>
          </div>
          <button
            onClick={handleRefreshTrackingAll}
            disabled={bulkBusy}
            className="btn-secondary self-start sm:self-auto shrink-0 flex items-center gap-2"
          >
            {bulkBusy ? <Loader2 className="w-4 h-4 animate-spin" /> : <RefreshCw className="w-4 h-4" />}
            Ambil semua nomor resi
          </button>
        </div>
      )}

      {/* Primary tabs — marketplace status, the only counts Seller Centre can
          confirm. Print status moved down into the filter row: it is a local
          flag that no marketplace can vouch for, so it has no business being
          the first thing the operator navigates by. */}
      <div className="card p-1">
        <div className="flex gap-1 overflow-x-auto">
          {ORDER_TABS.map((t) => (
            <button
              key={t.key}
              onClick={() => handleTabChange(t.key)}
              className={`flex-1 py-2.5 px-3 sm:px-4 rounded-lg text-xs sm:text-sm font-medium transition-colors whitespace-nowrap ${
                tab === t.key
                  ? 'bg-primary-600 text-white shadow-sm dark:bg-primary-600'
                  : 'text-gray-600 dark:text-slate-300 hover:bg-gray-50 dark:hover:bg-slate-700/60'
              }`}
            >
              {t.label}
              <span className={`ml-2 px-2 py-0.5 rounded-full text-xs ${
                tab === t.key
                  ? 'bg-white/20 text-white'
                  : 'bg-gray-100 dark:bg-slate-700 text-gray-600 dark:text-slate-300'
              }`}>
                {tabCounts[t.key]}
              </span>
            </button>
          ))}
        </div>
      </div>

      {/* Sub-tabs, only inside Perlu Dikirim: "Perlu Diproses" still needs a
          shipment arranged, "Telah Diproses" already has one and is waiting to
          be printed. Two different jobs, two different buttons. */}
      {tab === 'toShip' && (
        <div className="flex gap-4 px-1 overflow-x-auto">
          {ORDER_SUB_TABS.map((st) => (
            <button
              key={st.key}
              onClick={() => handleSubTabChange(st.key)}
              className={`py-1.5 text-sm font-medium whitespace-nowrap border-b-2 transition-colors ${
                subTab === st.key
                  ? 'border-primary-600 text-primary-700 dark:text-primary-400'
                  : 'border-transparent text-gray-500 dark:text-slate-400 hover:text-gray-700 dark:hover:text-slate-200'
              }`}
            >
              {st.label} <span className="text-xs">({subTabCounts[st.key]})</span>
            </button>
          ))}
        </div>
      )}

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

            {/* Only the statuses the active tab covers. Offering one it does
                not would hand the operator a choice that can only ever come
                back empty. On "Semua" the full list is available, which is how
                Dibatalkan and Selesai stay reachable while they have no tab. */}
            <select
              value={status}
              onChange={(e) => { setStatus(e.target.value); setPage(1) }}
              className="input w-full lg:w-auto min-w-[140px]"
              aria-label="Status pesanan"
            >
              <option value="">Semua Status</option>
              {(TAB_STATUSES[tab] ?? Object.keys(STATUS_LABELS)).map((st) => (
                <option key={st} value={st}>{STATUS_LABELS[st] || st}</option>
              ))}
            </select>

            {/* Demoted from the page's main tabs — see the comment there. */}
            <select
              value={printFilter}
              onChange={(e) => handlePrintFilterChange(e.target.value as PrintFilter)}
              className="input w-full lg:w-auto min-w-[150px]"
              aria-label="Status cetak"
            >
              <option value="semua">Semua Status Cetak</option>
              <option value="belum">Belum Dicetak ({counts.belumDicetak})</option>
              <option value="sudah">Sudah Dicetak ({counts.sudahDicetak})</option>
            </select>

            <select
              value={sort}
              onChange={(e) => { setSort(e.target.value as SortKey); setPage(1) }}
              className="input w-full lg:w-auto min-w-[150px]"
              aria-label="Urutkan"
            >
              {SORT_OPTIONS.map((o) => (
                <option key={o.key} value={o.key}>Urutkan: {o.label}</option>
              ))}
            </select>

            <select
              value={courier}
              onChange={(e) => { setCourier(e.target.value); setPage(1) }}
              className="input w-full lg:w-auto min-w-[150px]"
            >
              <option value="">Semua Kurir</option>
              {/* Keep the active value selectable even when the current store
                  filter no longer lists it — otherwise the box reads "Semua
                  Kurir" while a courier filter is still narrowing the table. */}
              {(couriers.includes(courier) || !courier ? couriers : [courier, ...couriers]).map((c) => (
                <option key={c} value={c}>{c}</option>
              ))}
            </select>

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
        {/* Pagination, above the rows: with 20-500 orders on screen the
            controls were a full scroll away from the filters that change what
            they page through. Rendered whenever there are rows, not only when
            the list spills past one page — the page-size control lives here,
            and hiding it at 500-per-page would strand the operator with no way
            back to 20. */}
        {total > 0 && (
          <div className="px-4 py-3 border-b border-gray-200 dark:border-slate-700 flex flex-col sm:flex-row items-center justify-between gap-3 bg-gray-50 dark:bg-slate-800/80">
            <div className="flex items-center gap-3">
              <p className="text-sm text-gray-500 dark:text-slate-400">
                Menampilkan {(page - 1) * limit + 1}–{Math.min(page * limit, total)} dari {total} pesanan
              </p>
              <select
                value={limit}
                onChange={(e) => { setLimit(Number(e.target.value)); setPage(1) }}
                className="input py-1 text-sm w-auto min-w-[110px]"
                aria-label="Jumlah per halaman"
              >
                {[20, 50, 100, 200, 500].map((n) => (
                  <option key={n} value={n}>{n} / halaman</option>
                ))}
              </select>
            </div>
            {totalPages > 1 && (
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
            )}
          </div>
        )}
        <div className="overflow-x-auto">
          <table className="w-full table-fixed">
            <colgroup>
              <col className="w-[40px]" />
              <col className="w-[12%]" />
              <col className="w-[10%]" />
              <col className="w-[7%]" />
              <col className="w-[9%]" />
              <col className="w-[22%]" />
              <col className="w-[10%]" />
              <col className="w-[9%]" />
              <col className="w-[8%]" />
              <col className="w-[8%]" />
              <col className="w-[40px]" />
            </colgroup>
            <thead className="bg-gray-50 dark:bg-slate-800/80 border-b border-gray-200 dark:border-slate-700">
              <tr>
                <th className="table-header">
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
                <th className="table-header">Batas Kirim</th>
                <th className="table-header">Tanggal</th>
                <th className="table-header">Aksi</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100 dark:divide-slate-700/60">
              {loading ? (
                <tr>
                  <td colSpan={11} className="px-4 py-16 text-center">
                    <Loader2 className="w-8 h-8 animate-spin text-primary-600 mx-auto" />
                    <p className="text-sm text-gray-500 dark:text-slate-400 mt-2">Memuat pesanan...</p>
                  </td>
                </tr>
              ) : orders.length === 0 ? (
                <tr>
                  <td colSpan={11} className="px-4 py-16 text-center">
                    <Package className="w-12 h-12 text-gray-300 dark:text-slate-600 mx-auto mb-3" />
                    <p className="font-medium text-gray-900 dark:text-slate-200">Tidak ada pesanan</p>
                    <p className="text-sm text-gray-500 dark:text-slate-400 mt-1">
                      {hasActiveFilters
                        ? 'Coba ubah filter atau kata kunci pencarian'
                        : 'Belum ada pesanan hari ini. Ubah rentang tanggal untuk melihat hari lain, atau klik "Sync" untuk mengambil pesanan terbaru'}
                    </p>
                  </td>
                </tr>
              ) : (
                orders.map((order) => {
                  const enabled = isCheckboxEnabled(order)
                  return (
                    <tr key={order.id} className="hover:bg-gray-50 dark:hover:bg-slate-700/40 transition-colors">
                      <td className="table-cell">
                        {order.printed ? (
                          <div className="flex flex-col gap-0.5">
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
                      <td className="table-cell font-mono text-xs font-medium text-gray-900 dark:text-slate-100 break-all">
                        {order.orderId}
                        {order.packageNumber && (
                          <p className="text-[10px] text-gray-400 dark:text-slate-500 break-all" title="Nomor paket">
                            pkg {order.packageNumber}
                          </p>
                        )}
                      </td>
                      <td className="table-cell text-sm break-words">{order.storeName}</td>
                      <td className="table-cell">
                        <span className={platformBadgeClass[order.platform] || 'badge'}>
                          {order.platform}
                        </span>
                      </td>
                      <td className="table-cell text-sm break-words">{order.buyerName}</td>
                      <td className="table-cell">
                        {order.items.length === 0 ? (
                          <span className="text-xs text-gray-400 dark:text-slate-500">—</span>
                        ) : (
                          <div
                            className="space-y-0.5"
                            title={order.items
                              .map((it) => `${it.quantity}x ${it.name}${it.variant ? ` (${it.variant})` : ''}`)
                              .join('\n')}
                          >
                            {order.items.slice(0, 2).map((it, idx) => (
                              <p key={idx} className="text-xs text-gray-700 dark:text-slate-300 break-words">
                                <span className="text-gray-400 dark:text-slate-500 font-mono text-[10px]">
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
                      <td className="table-cell text-sm break-words">
                        <div>
                          <p>{order.courier}</p>
                          {order.trackingNumber && (
                            <p className="text-[10px] text-gray-400 dark:text-slate-500 font-mono break-all">{order.trackingNumber}</p>
                          )}
                        </div>
                      </td>
                      <td className="table-cell">
                        <span className={statusBadgeClass[order.status] || 'badge'}>
                          {order.status.replace(/_/g, ' ')}
                        </span>
                        {order.logisticsStatus && (
                          <p className="text-[10px] text-gray-400 dark:text-slate-500 mt-1">
                            {logisticsLabel[order.logisticsStatus] || order.logisticsStatus}
                          </p>
                        )}
                      </td>
                      {/* Blank rather than guessed when Shopee never sent a
                          deadline — an invented "aman" would be read as one. */}
                      <td className="table-cell text-xs whitespace-nowrap">
                        {(() => {
                          const deadline = shipDeadline(order.shipByDate)
                          if (!deadline) return <span className="text-gray-300 dark:text-slate-600">—</span>
                          return (
                            <span className={DEADLINE_TONES[deadline.tone]} title={deadline.title}>
                              {deadline.label}
                            </span>
                          )
                        })()}
                      </td>
                      <td className="table-cell text-xs text-gray-500 dark:text-slate-400 whitespace-nowrap">
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
            className="card w-full max-w-2xl p-5 space-y-3 max-h-[85vh] overflow-y-auto"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-start justify-between gap-4">
              <div>
                <h3 className="font-semibold text-gray-900 dark:text-slate-100">Kirim Massal</h3>
                <p className="text-xs text-gray-500 dark:text-slate-400 mt-0.5">
                  {shippableSelected.length} pesanan
                  {massShipOptions ? ` · ${massShipOptions.groups.length} kurir` : ''}
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
                {/* One card per courier. KB Rule #2 still holds — exactly one
                    mode per shipment — it is simply decided per courier now,
                    because a pickup slot belongs to one courier's own schedule
                    and a shared one is rejected for everybody else. */}
                {shippableGroups.map((group) => {
                  const choice = massChoices[group.key]
                  if (!choice) return null
                  const addresses = group.pickup?.address_list || []
                  const address = addresses.find((a) => a.address_id === choice.addressId)
                  const slots = address?.time_slot_list || []
                  const canPickup = group.availableModes.includes('pickup')
                  const canDropoff = group.availableModes.includes('dropoff')

                  return (
                    <div key={group.key} className="rounded-lg border border-gray-200 dark:border-slate-700 p-3 space-y-2.5">
                      <div className="flex items-start justify-between gap-3">
                        <div>
                          <p className="text-sm font-medium text-gray-900 dark:text-slate-100">{group.courier}</p>
                          <p className="text-xs text-gray-500 dark:text-slate-400">
                            {group.storeName} · {group.orderRowIds.length} pesanan
                          </p>
                        </div>
                        {canPickup && canDropoff ? (
                          <div className="flex gap-1 shrink-0">
                            {([
                              { key: 'pickup' as const, label: 'Dijemput' },
                              { key: 'dropoff' as const, label: 'Ke counter' },
                            ]).map((m) => (
                              <button
                                key={m.key}
                                type="button"
                                disabled={bulkBusy}
                                onClick={() => setChoice(group.key, { mode: m.key })}
                                className={`rounded-md border px-2.5 py-1 text-xs font-medium transition-colors disabled:opacity-40 ${
                                  choice.mode === m.key
                                    ? 'border-primary-600 bg-primary-50 text-primary-700 dark:bg-primary-900/30 dark:text-primary-300'
                                    : 'border-gray-200 dark:border-slate-700 text-gray-600 dark:text-slate-300 hover:bg-gray-50 dark:hover:bg-slate-800'
                                }`}
                              >
                                {m.label}
                              </button>
                            ))}
                          </div>
                        ) : (
                          /* Only one mode on offer — say which, rather than
                             showing a toggle that cannot move. */
                          <span className="text-xs text-gray-500 dark:text-slate-400 shrink-0 pt-0.5">
                            {canPickup ? 'Dijemput kurir' : 'Antar ke counter'}
                          </span>
                        )}
                      </div>

                      {/* The rule is the operators' own — Shopee offers
                          pickup for these couriers regardless — so it is stated
                          rather than enforced, and only shouts when the choice
                          actually contradicts it. */}
                      {group.dropoffOnly && (
                        <p className={`rounded-md border px-2.5 py-1.5 text-xs ${
                          choice.mode === 'pickup'
                            ? 'bg-red-50 dark:bg-red-900/20 border-red-200 dark:border-red-800 text-red-700 dark:text-red-300'
                            : 'bg-slate-50 dark:bg-slate-800/60 border-slate-200 dark:border-slate-700 text-slate-600 dark:text-slate-300'
                        }`}>
                          {choice.mode === 'pickup'
                            ? `${group.courier} tidak menjemput paket — pilih "Ke counter", atau pengiriman ini akan menunggu kurir yang tidak datang.`
                            : `${group.courier} tidak bisa dijemput, jadi paket diantar ke counter.`}
                        </p>
                      )}

                      {choice.mode === 'dropoff' && (group.infoNeeded?.dropoff?.length ?? 0) > 0 && (
                        <p className="rounded-md bg-amber-50 dark:bg-amber-900/20 border border-amber-200 dark:border-amber-800 px-2.5 py-1.5 text-xs text-amber-700 dark:text-amber-300">
                          Channel ini meminta data tambahan untuk drop-off ({group.infoNeeded?.dropoff?.join(', ')}),
                          yang belum bisa diisi dari sini. Pesanan yang ditolak akan dilaporkan satu per satu.
                        </p>
                      )}

                      {choice.mode === 'pickup' && (
                        <div className="grid sm:grid-cols-2 gap-2">
                          <select
                            className="input text-sm"
                            aria-label={`Alamat penjemputan ${group.courier}`}
                            value={choice.addressId ?? ''}
                            disabled={bulkBusy}
                            onChange={(e) => {
                              const id = Number(e.target.value)
                              const addr = addresses.find((a) => a.address_id === id)
                              setChoice(group.key, {
                                addressId: id,
                                pickupTimeId: addr?.time_slot_list?.[0]?.pickup_time_id || '',
                              })
                            }}
                          >
                            {addresses.map((a) => (
                              <option key={a.address_id} value={a.address_id}>
                                {[a.address, a.city, a.state].filter(Boolean).join(', ') || `Alamat #${a.address_id}`}
                              </option>
                            ))}
                          </select>

                          <select
                            className="input text-sm"
                            aria-label={`Slot waktu ${group.courier}`}
                            value={choice.pickupTimeId}
                            disabled={bulkBusy || slots.length === 0}
                            onChange={(e) => setChoice(group.key, { pickupTimeId: e.target.value })}
                          >
                            {slots.length === 0 && <option value="">Tidak ada slot tersedia</option>}
                            {slots.map((slot) => (
                              <option key={slot.pickup_time_id} value={slot.pickup_time_id}>
                                {slot.time_text ||
                                  (slot.date ? new Date(slot.date * 1000).toLocaleString('id-ID') : slot.pickup_time_id)}
                              </option>
                            ))}
                          </select>
                        </div>
                      )}
                    </div>
                  )
                })}

                {/* A courier Shopee would not answer for is shown rather than
                    dropped, so the operator knows those orders were left behind
                    instead of working it out from the count afterwards. */}
                {blockedGroups.length > 0 && (
                  <div className="rounded-lg bg-amber-50 dark:bg-amber-900/20 border border-amber-200 dark:border-amber-800 px-3 py-2 space-y-1">
                    <p className="text-sm font-medium text-amber-800 dark:text-amber-300">Tidak bisa diatur dari sini</p>
                    {blockedGroups.map((g) => (
                      <p key={g.key} className="text-xs text-amber-700 dark:text-amber-300 break-words [overflow-wrap:anywhere]">
                        {g.courier} · {g.orderRowIds.length} pesanan — {g.error}
                      </p>
                    ))}
                  </div>
                )}

                <p className="text-xs text-gray-500 dark:text-slate-400">
                  Tiap kurir dikirim dengan jadwalnya sendiri, satu per satu ke Shopee. Nomor resi tidak
                  ditunggu di sini — akan terisi pada sync berikutnya.
                </p>

                <div className="flex justify-end gap-2 pt-2">
                  <button onClick={() => setMassShipOpen(false)} disabled={bulkBusy} className="btn-ghost">
                    Batal
                  </button>
                  {/* Left enabled when a schedule is missing: handleMassShip
                      names the courier that still needs one, which a dead
                      button never could. */}
                  <button
                    onClick={handleMassShip}
                    disabled={bulkBusy || shippableGroups.length === 0}
                    className="btn-primary"
                  >
                    {bulkBusy && <Loader2 className="w-4 h-4 animate-spin" />}
                    Kirim {groupedOrderCount} pesanan
                  </button>
                </div>
              </>
            )}
          </div>
        </div>
      )}

      {/* Bulk pickup re-scheduling. Same per-courier shape as Kirim Massal and
          for the same reason — a pickup slot id belongs to one courier's own
          schedule — but with no mode to choose: a retry is always a pickup. */}
      {massRetryOpen && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
          onClick={() => { if (!bulkBusy) setMassRetryOpen(false) }}
        >
          <div
            className="card w-full max-w-2xl p-5 space-y-3 max-h-[85vh] overflow-y-auto"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-start justify-between gap-4">
              <div>
                <h3 className="font-semibold text-gray-900 dark:text-slate-100">Jadwalkan Ulang Pickup</h3>
                <p className="text-xs text-gray-500 dark:text-slate-400 mt-0.5">
                  {retrySelected.length} pesanan
                  {massRetryOptions ? ` · ${massRetryOptions.groups.length} kurir` : ''}
                </p>
              </div>
              <button onClick={() => setMassRetryOpen(false)} disabled={bulkBusy} className="btn-ghost p-1">
                <X className="w-4 h-4" />
              </button>
            </div>

            {bulkMessage?.type === 'error' && (
              <div className="rounded-lg bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 px-3 py-2 text-sm text-red-700 dark:text-red-300 break-words [overflow-wrap:anywhere]">
                {bulkMessage.text}
              </div>
            )}

            {bulkBusy && !massRetryOptions && (
              <div className="flex items-center gap-2 text-sm text-gray-500 dark:text-slate-400">
                <Loader2 className="w-4 h-4 animate-spin" /> Menghubungi Shopee…
              </div>
            )}

            {massRetryOptions && (
              <>
                {retryGroups.map((group) => {
                  const choice = retryChoices[group.key]
                  if (!choice) return null
                  const addresses = group.pickup?.address_list || []
                  const address = addresses.find((a) => a.address_id === choice.addressId)
                  const slots = address?.time_slot_list || []

                  return (
                    <div key={group.key} className="rounded-lg border border-gray-200 dark:border-slate-700 p-3 space-y-2.5">
                      <div>
                        <p className="text-sm font-medium text-gray-900 dark:text-slate-100">{group.courier}</p>
                        <p className="text-xs text-gray-500 dark:text-slate-400">
                          {group.storeName} · {group.orderRowIds.length} pesanan
                        </p>
                      </div>

                      {/* Worth saying here too: re-booking a collection from a
                          courier that does not collect just fails again. */}
                      {group.dropoffOnly && (
                        <p className="rounded-md border border-red-200 dark:border-red-800 bg-red-50 dark:bg-red-900/20 px-2.5 py-1.5 text-xs text-red-700 dark:text-red-300">
                          {group.courier} tidak menjemput paket — penjemputan ulang kemungkinan besar gagal lagi. Antar ke counter.
                        </p>
                      )}

                      <div className="grid sm:grid-cols-2 gap-2">
                        <select
                          className="input text-sm"
                          aria-label={`Alamat penjemputan ${group.courier}`}
                          value={choice.addressId ?? ''}
                          disabled={bulkBusy}
                          onChange={(e) => {
                            const id = Number(e.target.value)
                            const addr = addresses.find((a) => a.address_id === id)
                            setRetryChoice(group.key, {
                              addressId: id,
                              pickupTimeId: addr?.time_slot_list?.[0]?.pickup_time_id || '',
                            })
                          }}
                        >
                          {addresses.map((a) => (
                            <option key={a.address_id} value={a.address_id}>
                              {[a.address, a.city, a.state].filter(Boolean).join(', ') || `Alamat #${a.address_id}`}
                            </option>
                          ))}
                        </select>

                        <select
                          className="input text-sm"
                          aria-label={`Slot waktu ${group.courier}`}
                          value={choice.pickupTimeId}
                          disabled={bulkBusy || slots.length === 0}
                          onChange={(e) => setRetryChoice(group.key, { pickupTimeId: e.target.value })}
                        >
                          {slots.length === 0 && <option value="">Tidak ada slot tersedia</option>}
                          {slots.map((slot) => (
                            <option key={slot.pickup_time_id} value={slot.pickup_time_id}>
                              {slot.time_text ||
                                (slot.date ? new Date(slot.date * 1000).toLocaleString('id-ID') : slot.pickup_time_id)}
                            </option>
                          ))}
                        </select>
                      </div>
                    </div>
                  )
                })}

                {blockedRetryGroups.length > 0 && (
                  <div className="rounded-lg bg-amber-50 dark:bg-amber-900/20 border border-amber-200 dark:border-amber-800 px-3 py-2 space-y-1">
                    <p className="text-sm font-medium text-amber-800 dark:text-amber-300">Tidak bisa dijadwalkan dari sini</p>
                    {blockedRetryGroups.map((g) => (
                      <p key={g.key} className="text-xs text-amber-700 dark:text-amber-300 break-words [overflow-wrap:anywhere]">
                        {g.courier} · {g.orderRowIds.length} pesanan — {g.error}
                      </p>
                    ))}
                  </div>
                )}

                <div className="flex justify-end gap-2 pt-2">
                  <button onClick={() => setMassRetryOpen(false)} disabled={bulkBusy} className="btn-ghost">
                    Batal
                  </button>
                  <button
                    onClick={handleMassRetry}
                    disabled={bulkBusy || retryGroups.length === 0}
                    className="btn-primary"
                  >
                    {bulkBusy && <Loader2 className="w-4 h-4 animate-spin" />}
                    Jadwalkan {retryGroups.reduce((n, g) => n + g.orderRowIds.length, 0)} pesanan
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
              {/* Its own button because a retry is a different Shopee call:
                  sending these through Kirim Massal only re-reads the tracking
                  number and reports success without re-booking anything. */}
              {retrySelected.length > 0 && (
                <button
                  onClick={openMassRetry}
                  disabled={bulkBusy}
                  className="btn bg-amber-600 text-white hover:bg-amber-700"
                >
                  {bulkBusy ? <Loader2 className="w-4 h-4 animate-spin" /> : <RotateCcw className="w-4 h-4" />}
                  Jadwalkan Ulang Pickup ({retrySelected.length})
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
