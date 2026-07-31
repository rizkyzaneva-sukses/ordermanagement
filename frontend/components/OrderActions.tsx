'use client'

import { useState, useEffect, useRef } from 'react'
import { createPortal } from 'react-dom'
import api from '@/lib/api'
import {
  MoreHorizontal,
  Truck,
  RotateCcw,
  Ban,
  RefreshCw,
  MapPin,
  Check,
  X,
  Loader2,
  Split,
  Merge,
  FileDown,
} from 'lucide-react'

export interface ActionableOrder {
  id: string
  orderId: string
  packageNumber?: string
  platform: string
  status: string
  logisticsStatus?: string | null
  trackingNumber?: string | null
  awbFetchedAt?: string | null
}

interface SplitItem {
  itemId: number
  modelId: number
  orderItemId: number
  promotionGroupId: number
  addOnDealId: number
  name: string
  variant?: string | null
  quantity: number
}

interface SplitOptions {
  orderStatus: string
  splittable: boolean
  maxPackages: number
  items: SplitItem[]
  lockedGroups: Array<{ key: string; reason: string; itemIds: number[] }>
}

interface ShippingOptions {
  availableModes: string[]
  suggestedMode: string | null
  logisticsStatus: string | null
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

interface TrackingEvent {
  update_time?: number
  description?: string
  logistics_status?: string
}

type Modal = 'ship' | 'retry' | 'cancel' | 'tracking' | 'split' | null

const MODE_LABELS: Record<string, string> = {
  pickup: 'Dijemput kurir (pickup)',
  dropoff: 'Antar sendiri (dropoff)',
  non_integrated: 'Resi sendiri (non-integrated)',
}

const CANCEL_REASONS = [
  { value: 'OUT_OF_STOCK', label: 'Stok habis' },
  { value: 'UNDELIVERABLE_AREA', label: 'Area tidak terjangkau' },
]

/**
 * Per-order fulfillment actions.
 *
 * Which actions appear is driven by the order's current state — Shopee rejects
 * a ship_order on an already-processed package and a cancel on a shipped one,
 * so offering them would only produce confusing errors.
 */
export default function OrderActions({
  order,
  onDone,
}: {
  order: ActionableOrder
  onDone: () => void
}) {
  const [menuOpen, setMenuOpen] = useState(false)
  const [modal, setModal] = useState<Modal>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')

  const [options, setOptions] = useState<ShippingOptions | null>(null)
  const [mode, setMode] = useState('')
  const [addressId, setAddressId] = useState<number | null>(null)
  const [pickupTimeId, setPickupTimeId] = useState('')
  const [trackingNumberInput, setTrackingNumberInput] = useState('')
  const [cancelReason, setCancelReason] = useState('OUT_OF_STOCK')
  const [events, setEvents] = useState<TrackingEvent[]>([])

  const [splitOptions, setSplitOptions] = useState<SplitOptions | null>(null)
  const [packageCount, setPackageCount] = useState(2)
  // itemKey -> package index (0-based)
  const [assignment, setAssignment] = useState<Record<string, number>>({})

  const buttonRef = useRef<HTMLButtonElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)
  const [menuPos, setMenuPos] = useState<{ top: number; left: number } | null>(null)

  // The orders table scrolls inside `overflow-hidden`/`overflow-x-auto`
  // wrappers, which clip an absolutely positioned menu — the last rows and the
  // rightmost column lost most of it. The menu is portalled to <body> and
  // positioned against the button instead, flipping above it near the bottom
  // edge and pulling back in when it would run past the right edge.
  useEffect(() => {
    if (!menuOpen) {
      setMenuPos(null)
      return
    }

    const place = () => {
      const anchor = buttonRef.current?.getBoundingClientRect()
      if (!anchor) return

      const menu = menuRef.current?.getBoundingClientRect()
      const width = menu?.width || 224
      const height = menu?.height || 0
      const gap = 4
      const margin = 8

      let top = anchor.bottom + gap
      if (height && top + height > window.innerHeight - margin) {
        top = Math.max(margin, anchor.top - height - gap)
      }

      const left = Math.min(
        Math.max(margin, anchor.right - width),
        Math.max(margin, window.innerWidth - width - margin),
      )

      setMenuPos({ top, left })
    }

    place()
    // `true` so the table's own scroll container is heard, not just the window
    window.addEventListener('scroll', place, true)
    window.addEventListener('resize', place)
    return () => {
      window.removeEventListener('scroll', place, true)
      window.removeEventListener('resize', place)
    }
  }, [menuOpen])

  const isShopee = order.platform === 'SHOPEE'
  const canShip = isShopee && ['READY_TO_SHIP', 'RETRY_SHIP'].includes(order.status)
  const canRetry = isShopee && (order.status === 'RETRY_SHIP' || order.logisticsStatus === 'LOGISTICS_PICKUP_RETRY')
  const canCancel = isShopee && ['UNPAID', 'READY_TO_SHIP', 'PROCESSED'].includes(order.status)
  const canAnswerCancellation = isShopee && order.status === 'IN_CANCEL'
  const canTrack = isShopee && Boolean(order.trackingNumber)
  // Splitting and merging are only legal while READY_TO_SHIP (KB §6)
  const canSplit = isShopee && order.status === 'READY_TO_SHIP'
  const canUnsplit = canSplit && Boolean(order.packageNumber)
  const hasStoredAwb = isShopee && Boolean(order.awbFetchedAt)

  const itemKey = (i: SplitItem) => `${i.itemId}::${i.modelId}::${i.orderItemId}`

  const errorMessage = (err: any) =>
    err?.response?.data?.error || err?.message || 'Terjadi kesalahan'

  /**
   * Show a failure and re-read the list.
   *
   * The fulfillment endpoints re-sync the row from Shopee before rejecting, so a
   * refusal like "status is PROCESSED" means the badge still on screen is stale.
   * Leaving it there is what makes the error look like it contradicts the table.
   */
  const failWith = (err: any) => {
    setError(errorMessage(err))
    onDone()
  }

  const closeAll = () => {
    setModal(null)
    setMenuOpen(false)
    setError('')
    setNotice('')
    setOptions(null)
    setMode('')
    setAddressId(null)
    setPickupTimeId('')
    setTrackingNumberInput('')
    setEvents([])
    setSplitOptions(null)
    setAssignment({})
    setPackageCount(2)
  }

  const openSplit = async () => {
    setMenuOpen(false)
    setModal('split')
    setBusy(true)
    setError('')
    try {
      const res = await api.get<SplitOptions>(`/orders/${order.id}/split-options`)
      setSplitOptions(res.data)

      // Start everything in package 1, but keep locked groups together so the
      // operator cannot accidentally break a bundle by moving one member.
      const initial: Record<string, number> = {}
      res.data.items.forEach((i) => { initial[itemKey(i)] = 0 })
      setAssignment(initial)
    } catch (err) {
      failWith(err)
    } finally {
      setBusy(false)
    }
  }

  /** Move an item — and anything locked to it — into a package. */
  const assignItem = (item: SplitItem, packageIndex: number) => {
    if (!splitOptions) return

    const lockedWith = splitOptions.lockedGroups.find((g) => g.itemIds.includes(item.itemId))
    const affected = lockedWith
      ? splitOptions.items.filter((i) => lockedWith.itemIds.includes(i.itemId))
      : [item]

    setAssignment((prev) => {
      const next = { ...prev }
      affected.forEach((i) => { next[itemKey(i)] = packageIndex })
      return next
    })
  }

  const submitSplit = async () => {
    if (!splitOptions) return
    setBusy(true)
    setError('')
    try {
      const packages = Array.from({ length: packageCount }, (_, index) => ({
        items: splitOptions.items.filter((i) => assignment[itemKey(i)] === index),
      }))

      const res = await api.post<any>(`/orders/${order.id}/split`, { packages })
      setNotice(`Pesanan dipecah menjadi ${res.data?.packages ?? packageCount} paket.`)
      onDone()
    } catch (err) {
      failWith(err)
    } finally {
      setBusy(false)
    }
  }

  const submitUnsplit = async () => {
    setMenuOpen(false)
    setBusy(true)
    setError('')
    try {
      await api.post(`/orders/${order.id}/unsplit`)
      setNotice('Paket digabungkan kembali menjadi satu.')
      onDone()
    } catch (err) {
      failWith(err)
      setModal('split')
    } finally {
      setBusy(false)
    }
  }

  const downloadStoredAwb = async () => {
    setMenuOpen(false)
    setBusy(true)
    setError('')
    try {
      const res = await api.get(`/print/awb/${order.id}`, { responseType: 'blob' })
      const disposition = (res.headers as any)?.['content-disposition'] || ''
      const suggested = /filename="([^"]+)"/.exec(disposition)?.[1]

      const url = window.URL.createObjectURL(res.data as Blob)
      const link = document.createElement('a')
      link.href = url
      link.download = suggested || `awb-${order.orderId}`
      document.body.appendChild(link)
      link.click()
      link.remove()
      window.URL.revokeObjectURL(url)
    } catch (err: any) {
      const body = err?.response?.data
      if (body instanceof Blob) {
        try {
          setError(JSON.parse(await body.text())?.error || 'Gagal mengunduh AWB')
        } catch {
          setError('Gagal mengunduh AWB')
        }
      } else {
        setError(errorMessage(err))
      }
    } finally {
      setBusy(false)
    }
  }

  const openShippingModal = async (which: 'ship' | 'retry') => {
    setMenuOpen(false)
    setModal(which)
    setBusy(true)
    setError('')
    try {
      const res = await api.get<ShippingOptions>(`/orders/${order.id}/shipping-options`)
      setOptions(res.data)
      setMode(res.data.suggestedMode || res.data.availableModes?.[0] || '')

      const firstAddress = res.data.pickup?.address_list?.[0]
      if (firstAddress) {
        setAddressId(firstAddress.address_id)
        setPickupTimeId(firstAddress.time_slot_list?.[0]?.pickup_time_id || '')
      }
    } catch (err) {
      failWith(err)
    } finally {
      setBusy(false)
    }
  }

  const selectedAddress = options?.pickup?.address_list?.find((a) => a.address_id === addressId)

  const submitShip = async () => {
    setBusy(true)
    setError('')
    try {
      const modeData: Record<string, any> = {}
      if (mode === 'pickup') {
        if (!addressId || !pickupTimeId) {
          setError('Pilih alamat dan slot waktu penjemputan terlebih dahulu')
          setBusy(false)
          return
        }
        modeData.address_id = addressId
        modeData.pickup_time_id = pickupTimeId
      } else if (mode === 'non_integrated') {
        if (!trackingNumberInput.trim()) {
          setError('Nomor resi wajib diisi untuk mode non-integrated')
          setBusy(false)
          return
        }
        modeData.tracking_number = trackingNumberInput.trim()
      }

      const res = await api.post<any>(`/orders/${order.id}/ship`, { mode, modeData })
      const tracking = res.data?.trackingNumber

      setNotice(
        res.data?.alreadyArranged
          ? 'Pengiriman sudah pernah diatur sebelumnya — hanya resi yang diperbarui.'
          : tracking
            ? `Pengiriman diatur. Resi: ${tracking}`
            : 'Pengiriman diatur. Resi belum terbit, akan terisi di sync berikutnya.'
      )
      onDone()
    } catch (err) {
      failWith(err)
    } finally {
      setBusy(false)
    }
  }

  const submitRetry = async () => {
    setBusy(true)
    setError('')
    try {
      if (!addressId || !pickupTimeId) {
        setError('Pilih alamat dan slot waktu penjemputan terlebih dahulu')
        setBusy(false)
        return
      }
      await api.post(`/orders/${order.id}/retry-ship`, { addressId, pickupTimeId })
      setNotice('Penjemputan berhasil dijadwalkan ulang.')
      onDone()
    } catch (err) {
      failWith(err)
    } finally {
      setBusy(false)
    }
  }

  const submitCancel = async () => {
    setBusy(true)
    setError('')
    try {
      await api.post(`/orders/${order.id}/cancel`, { reason: cancelReason })
      setNotice('Pesanan dibatalkan.')
      onDone()
    } catch (err) {
      failWith(err)
    } finally {
      setBusy(false)
    }
  }

  const answerCancellation = async (operation: 'ACCEPT' | 'REJECT') => {
    setMenuOpen(false)
    setBusy(true)
    setError('')
    try {
      await api.post(`/orders/${order.id}/handle-cancellation`, { operation })
      onDone()
    } catch (err) {
      failWith(err)
    } finally {
      setBusy(false)
    }
  }

  const refreshTracking = async () => {
    setMenuOpen(false)
    setBusy(true)
    setError('')
    try {
      const res = await api.post<{ trackingNumber: string | null }>(`/orders/${order.id}/refresh-tracking`)
      // The success path used to be silent — the request completes, the row
      // re-fetches, and if the tracking number happened to be unchanged
      // nothing on screen moves, so the click looked like it did nothing.
      setNotice(
        res.data?.trackingNumber
          ? `Nomor resi: ${res.data.trackingNumber}`
          : 'Resi belum terbit dari kurir. Coba lagi nanti.'
      )
      onDone()
    } catch (err) {
      setError(errorMessage(err))
    } finally {
      setBusy(false)
    }
  }

  const openTracking = async () => {
    setMenuOpen(false)
    setModal('tracking')
    setBusy(true)
    setError('')
    try {
      const res = await api.get<{ events: TrackingEvent[] }>(`/orders/${order.id}/tracking-info`)
      setEvents(res.data?.events || [])
    } catch (err) {
      setError(errorMessage(err))
    } finally {
      setBusy(false)
    }
  }

  const hasAnyAction =
    isShopee || canShip || canRetry || canCancel || canAnswerCancellation || canTrack || canSplit || hasStoredAwb

  if (!hasAnyAction) {
    return <span className="text-xs text-gray-400 dark:text-slate-500">—</span>
  }

  return (
    <div className="relative">
      <button
        ref={buttonRef}
        onClick={() => setMenuOpen((v) => !v)}
        disabled={busy}
        className="btn-ghost p-1.5"
        aria-label={`Aksi untuk pesanan ${order.orderId}`}
      >
        {busy && !modal ? <Loader2 className="w-4 h-4 animate-spin" /> : <MoreHorizontal className="w-4 h-4" />}
      </button>

      {menuOpen && typeof document !== 'undefined' && createPortal(
        <>
          <div className="fixed inset-0 z-[60]" onClick={() => setMenuOpen(false)} />
          <div
            ref={menuRef}
            style={{
              top: menuPos?.top ?? 0,
              left: menuPos?.left ?? 0,
              // Hidden for the frame before it is measured, so it never flashes
              // in the top-left corner.
              visibility: menuPos ? 'visible' : 'hidden',
            }}
            className="fixed w-56 rounded-lg border border-gray-200 dark:border-slate-700 bg-white dark:bg-slate-800 shadow-lg z-[61] py-1 text-sm">
            {canShip && (
              <button onClick={() => openShippingModal('ship')} className="w-full text-left px-3 py-2 hover:bg-gray-50 dark:hover:bg-slate-700 flex items-center gap-2">
                <Truck className="w-4 h-4" /> Atur pengiriman
              </button>
            )}
            {canRetry && (
              <button onClick={() => openShippingModal('retry')} className="w-full text-left px-3 py-2 hover:bg-gray-50 dark:hover:bg-slate-700 flex items-center gap-2">
                <RotateCcw className="w-4 h-4" /> Jadwalkan ulang pickup
              </button>
            )}
            {isShopee && (
              <button onClick={refreshTracking} className="w-full text-left px-3 py-2 hover:bg-gray-50 dark:hover:bg-slate-700 flex items-center gap-2">
                <RefreshCw className="w-4 h-4" /> Ambil nomor resi
              </button>
            )}
            {canTrack && (
              <button onClick={openTracking} className="w-full text-left px-3 py-2 hover:bg-gray-50 dark:hover:bg-slate-700 flex items-center gap-2">
                <MapPin className="w-4 h-4" /> Lacak pengiriman
              </button>
            )}
            {hasStoredAwb && (
              <button onClick={downloadStoredAwb} className="w-full text-left px-3 py-2 hover:bg-gray-50 dark:hover:bg-slate-700 flex items-center gap-2">
                <FileDown className="w-4 h-4" /> Unduh AWB tersimpan
              </button>
            )}
            {canSplit && (
              <>
                <div className="border-t border-gray-100 dark:border-slate-700 my-1" />
                <button onClick={openSplit} className="w-full text-left px-3 py-2 hover:bg-gray-50 dark:hover:bg-slate-700 flex items-center gap-2">
                  <Split className="w-4 h-4" /> Pecah jadi beberapa paket
                </button>
              </>
            )}
            {canUnsplit && (
              <button onClick={submitUnsplit} className="w-full text-left px-3 py-2 hover:bg-gray-50 dark:hover:bg-slate-700 flex items-center gap-2">
                <Merge className="w-4 h-4" /> Gabungkan kembali
              </button>
            )}
            {canAnswerCancellation && (
              <>
                <div className="border-t border-gray-100 dark:border-slate-700 my-1" />
                <button onClick={() => answerCancellation('ACCEPT')} className="w-full text-left px-3 py-2 hover:bg-gray-50 dark:hover:bg-slate-700 flex items-center gap-2">
                  <Check className="w-4 h-4" /> Setujui pembatalan buyer
                </button>
                <button onClick={() => answerCancellation('REJECT')} className="w-full text-left px-3 py-2 hover:bg-gray-50 dark:hover:bg-slate-700 flex items-center gap-2">
                  <X className="w-4 h-4" /> Tolak pembatalan buyer
                </button>
              </>
            )}
            {canCancel && (
              <>
                <div className="border-t border-gray-100 dark:border-slate-700 my-1" />
                <button
                  onClick={() => { setMenuOpen(false); setModal('cancel') }}
                  className="w-full text-left px-3 py-2 hover:bg-red-50 dark:hover:bg-red-900/20 text-red-600 dark:text-red-400 flex items-center gap-2"
                >
                  <Ban className="w-4 h-4" /> Batalkan pesanan
                </button>
              </>
            )}
          </div>
        </>,
        document.body,
      )}

      {(modal || notice) && typeof document !== 'undefined' && createPortal(
        <div className="fixed inset-0 z-[70] flex items-center justify-center bg-black/40 p-4" onClick={closeAll}>
          <div
            className="card w-full max-w-lg p-5 space-y-4 max-h-[85vh] overflow-y-auto"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-start justify-between gap-4">
              <div>
                <h3 className="font-semibold text-gray-900 dark:text-slate-100">
                  {modal === 'ship' && 'Atur Pengiriman'}
                  {modal === 'retry' && 'Jadwalkan Ulang Pickup'}
                  {modal === 'cancel' && 'Batalkan Pesanan'}
                  {modal === 'tracking' && 'Riwayat Pengiriman'}
                  {modal === 'split' && 'Pecah Pesanan'}
                  {!modal && 'Hasil'}
                </h3>
                <p className="text-xs text-gray-500 dark:text-slate-400 font-mono mt-0.5">{order.orderId}</p>
              </div>
              <button onClick={closeAll} className="btn-ghost p-1">
                <X className="w-4 h-4" />
              </button>
            </div>

            {/* Shopee errors carry an unbroken request_id that overflows the box
                and gets clipped without an explicit break. */}
            {error && (
              <div className="rounded-lg bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 px-3 py-2 text-sm text-red-700 dark:text-red-300 break-words [overflow-wrap:anywhere]">
                {error}
              </div>
            )}

            {notice && (
              <div className="rounded-lg bg-green-50 dark:bg-green-900/20 border border-green-200 dark:border-green-800 px-3 py-2 text-sm text-green-700 dark:text-green-300 break-words [overflow-wrap:anywhere]">
                {notice}
              </div>
            )}

            {busy && (
              <div className="flex items-center gap-2 text-sm text-gray-500 dark:text-slate-400">
                <Loader2 className="w-4 h-4 animate-spin" /> Menghubungi Shopee…
              </div>
            )}

            {/* Ship */}
            {modal === 'ship' && !busy && !notice && options && (
              <div className="space-y-4">
                <div>
                  <label className="block text-sm font-medium mb-1.5 text-gray-700 dark:text-slate-300">
                    Mode pengiriman
                  </label>
                  {options.availableModes.length === 0 ? (
                    <p className="text-sm text-gray-500 dark:text-slate-400">
                      Channel ini tidak menawarkan mode pengiriman apa pun saat ini.
                    </p>
                  ) : (
                    <div className="space-y-1.5">
                      {options.availableModes.map((m) => (
                        <label key={m} className="flex items-center gap-2 text-sm">
                          <input
                            type="radio"
                            name="ship-mode"
                            value={m}
                            checked={mode === m}
                            onChange={() => setMode(m)}
                          />
                          {MODE_LABELS[m] || m}
                        </label>
                      ))}
                    </div>
                  )}
                </div>

                {mode === 'pickup' && (
                  <>
                    <div>
                      <label className="block text-sm font-medium mb-1.5 text-gray-700 dark:text-slate-300">
                        Alamat penjemputan
                      </label>
                      <select
                        className="input"
                        value={addressId ?? ''}
                        onChange={(e) => {
                          const id = Number(e.target.value)
                          setAddressId(id)
                          const addr = options.pickup?.address_list?.find((a) => a.address_id === id)
                          setPickupTimeId(addr?.time_slot_list?.[0]?.pickup_time_id || '')
                        }}
                      >
                        {(options.pickup?.address_list || []).map((a) => (
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
                      <select className="input" value={pickupTimeId} onChange={(e) => setPickupTimeId(e.target.value)}>
                        {(selectedAddress?.time_slot_list || []).map((slot) => (
                          <option key={slot.pickup_time_id} value={slot.pickup_time_id}>
                            {slot.time_text ||
                              (slot.date ? new Date(slot.date * 1000).toLocaleString('id-ID') : slot.pickup_time_id)}
                          </option>
                        ))}
                      </select>
                      {(selectedAddress?.time_slot_list || []).length === 0 && (
                        <p className="text-xs text-amber-600 dark:text-amber-400 mt-1">
                          Tidak ada slot tersedia. Biasanya berarti pesanan sudah dikirim atau batas waktu kirim terlewat.
                        </p>
                      )}
                    </div>
                  </>
                )}

                {mode === 'non_integrated' && (
                  <div>
                    <label className="block text-sm font-medium mb-1.5 text-gray-700 dark:text-slate-300">
                      Nomor resi
                    </label>
                    <input
                      className="input font-mono"
                      value={trackingNumberInput}
                      onChange={(e) => setTrackingNumberInput(e.target.value)}
                      placeholder="Masukkan nomor resi dari kurir"
                    />
                  </div>
                )}

                <div className="flex justify-end gap-2 pt-2">
                  <button onClick={closeAll} className="btn-ghost">Batal</button>
                  <button onClick={submitShip} disabled={!mode} className="btn-primary">
                    Kirim
                  </button>
                </div>
              </div>
            )}

            {/* Retry pickup */}
            {modal === 'retry' && !busy && !notice && options && (
              <div className="space-y-4">
                <div>
                  <label className="block text-sm font-medium mb-1.5 text-gray-700 dark:text-slate-300">
                    Alamat penjemputan
                  </label>
                  <select
                    className="input"
                    value={addressId ?? ''}
                    onChange={(e) => {
                      const id = Number(e.target.value)
                      setAddressId(id)
                      const addr = options.pickup?.address_list?.find((a) => a.address_id === id)
                      setPickupTimeId(addr?.time_slot_list?.[0]?.pickup_time_id || '')
                    }}
                  >
                    {(options.pickup?.address_list || []).map((a) => (
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
                  <select className="input" value={pickupTimeId} onChange={(e) => setPickupTimeId(e.target.value)}>
                    {(selectedAddress?.time_slot_list || []).map((slot) => (
                      <option key={slot.pickup_time_id} value={slot.pickup_time_id}>
                        {slot.time_text ||
                          (slot.date ? new Date(slot.date * 1000).toLocaleString('id-ID') : slot.pickup_time_id)}
                      </option>
                    ))}
                  </select>
                </div>

                <div className="flex justify-end gap-2 pt-2">
                  <button onClick={closeAll} className="btn-ghost">Batal</button>
                  <button onClick={submitRetry} className="btn-primary">Jadwalkan</button>
                </div>
              </div>
            )}

            {/* Cancel */}
            {modal === 'cancel' && !busy && !notice && (
              <div className="space-y-4">
                <p className="text-sm text-gray-600 dark:text-slate-400">
                  Pembatalan dikirim ke Shopee dan tidak bisa dibatalkan kembali. Seluruh paket pada pesanan ini
                  ikut dibatalkan.
                </p>
                <div>
                  <label className="block text-sm font-medium mb-1.5 text-gray-700 dark:text-slate-300">
                    Alasan
                  </label>
                  <select className="input" value={cancelReason} onChange={(e) => setCancelReason(e.target.value)}>
                    {CANCEL_REASONS.map((r) => (
                      <option key={r.value} value={r.value}>{r.label}</option>
                    ))}
                  </select>
                </div>
                <div className="flex justify-end gap-2 pt-2">
                  <button onClick={closeAll} className="btn-ghost">Kembali</button>
                  <button onClick={submitCancel} className="btn bg-red-600 text-white hover:bg-red-700">
                    Batalkan pesanan
                  </button>
                </div>
              </div>
            )}

            {/* Split */}
            {modal === 'split' && !busy && !notice && splitOptions && (
              <div className="space-y-4">
                {!splitOptions.splittable && (
                  <div className="rounded-lg bg-amber-50 dark:bg-amber-900/20 border border-amber-200 dark:border-amber-800 px-3 py-2 text-sm text-amber-700 dark:text-amber-300">
                    Status pesanan {splitOptions.orderStatus} — hanya READY_TO_SHIP yang bisa dipecah.
                  </div>
                )}

                {splitOptions.lockedGroups.length > 0 && (
                  <div className="rounded-lg bg-blue-50 dark:bg-blue-900/20 border border-blue-200 dark:border-blue-800 px-3 py-2 text-xs text-blue-700 dark:text-blue-300">
                    {splitOptions.lockedGroups.length} kelompok item terkunci ({splitOptions.lockedGroups
                      .map((g) => g.reason)
                      .filter((v, i, a) => a.indexOf(v) === i)
                      .join(', ')}) dan akan berpindah bersama-sama.
                  </div>
                )}

                <div className="flex items-center gap-2">
                  <label className="text-sm font-medium text-gray-700 dark:text-slate-300">Jumlah paket</label>
                  <select
                    className="input w-24"
                    value={packageCount}
                    onChange={(e) => {
                      const next = Number(e.target.value)
                      setPackageCount(next)
                      // Pull back anything assigned to a package that no longer exists
                      setAssignment((prev) => {
                        const updated = { ...prev }
                        Object.keys(updated).forEach((k) => {
                          if (updated[k] >= next) updated[k] = next - 1
                        })
                        return updated
                      })
                    }}
                  >
                    {Array.from({ length: splitOptions.maxPackages - 1 }, (_, i) => i + 2).map((n) => (
                      <option key={n} value={n}>{n}</option>
                    ))}
                  </select>
                </div>

                <div className="space-y-2">
                  {splitOptions.items.map((item) => {
                    const key = itemKey(item)
                    const locked = splitOptions.lockedGroups.find((g) => g.itemIds.includes(item.itemId))
                    return (
                      <div key={key} className="flex items-center justify-between gap-3 border border-gray-200 dark:border-slate-700 rounded-lg px-3 py-2">
                        <div className="min-w-0">
                          <p className="text-sm text-gray-900 dark:text-slate-100 truncate">{item.name}</p>
                          <p className="text-xs text-gray-500 dark:text-slate-400">
                            {item.variant ? `${item.variant} · ` : ''}Qty {item.quantity}
                            {locked && ` · ${locked.reason}`}
                          </p>
                        </div>
                        <select
                          className="input w-28 shrink-0"
                          value={assignment[key] ?? 0}
                          onChange={(e) => assignItem(item, Number(e.target.value))}
                        >
                          {Array.from({ length: packageCount }, (_, i) => (
                            <option key={i} value={i}>Paket {i + 1}</option>
                          ))}
                        </select>
                      </div>
                    )
                  })}
                </div>

                <p className="text-xs text-gray-500 dark:text-slate-400">
                  Semua item harus terbagi habis dan setiap paket wajib berisi minimal satu item.
                </p>

                <div className="flex justify-end gap-2 pt-2">
                  <button onClick={closeAll} className="btn-ghost">Batal</button>
                  <button onClick={submitSplit} disabled={!splitOptions.splittable} className="btn-primary">
                    Pecah
                  </button>
                </div>
              </div>
            )}

            {/* Tracking */}
            {modal === 'tracking' && !busy && (
              <div className="space-y-2">
                {events.length === 0 ? (
                  <p className="text-sm text-gray-500 dark:text-slate-400">Belum ada event pengiriman.</p>
                ) : (
                  <ol className="space-y-3">
                    {events.map((ev, i) => (
                      <li key={i} className="border-l-2 border-gray-200 dark:border-slate-700 pl-3">
                        <p className="text-sm text-gray-900 dark:text-slate-100">
                          {ev.description || ev.logistics_status || '—'}
                        </p>
                        {ev.update_time && (
                          <p className="text-xs text-gray-500 dark:text-slate-400">
                            {new Date(ev.update_time * 1000).toLocaleString('id-ID')}
                          </p>
                        )}
                      </li>
                    ))}
                  </ol>
                )}
              </div>
            )}

            {notice && (
              <div className="flex justify-end pt-2">
                <button onClick={closeAll} className="btn-primary">Tutup</button>
              </div>
            )}
          </div>
        </div>,
        document.body,
      )}
    </div>
  )
}
