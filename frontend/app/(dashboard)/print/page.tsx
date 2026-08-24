'use client'

import { useEffect, useState, Suspense } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import api from '@/lib/api'
import {
  Printer,
  Download,
  ArrowLeft,
  Loader2,
  CheckCircle2,
  Filter,
  Eye,
  Package,
} from 'lucide-react'

interface PrintOrder {
  id: string
  orderId: string
  storeId: string
  storeName: string
  platform: 'SHOPEE' | 'TIKTOK'
  buyerName: string
  courier: string
  trackingNumber: string
  address: string
  items: { name: string; qty: number; variant?: string }[]
}

function PrintPageContent() {
  const router = useRouter()
  const searchParams = useSearchParams()

  const [orders, setOrders] = useState<PrintOrder[]>([])
  const [loading, setLoading] = useState(true)
  const [printing, setPrinting] = useState(false)
  const [progress, setProgress] = useState(0)
  const [done, setDone] = useState(false)
  const [previewOrder, setPreviewOrder] = useState<PrintOrder | null>(null)
  const [courierFilter, setCourierFilter] = useState('')
  const [error, setError] = useState('')

  const orderIds = searchParams.get('ids')?.split(',').filter(Boolean) || []
  const isReprint = searchParams.get('reprint') === 'true'

  useEffect(() => {
    if (orderIds.length === 0) {
      setLoading(false)
      return
    }

    const fetchOrders = async () => {
      try {
        const { data } = await api.post<PrintOrder[]>('/orders/print-details', {
          ids: orderIds,
        })
        setOrders(data)
      } catch (err) {
        setError('Gagal memuat detail pesanan')
      } finally {
        setLoading(false)
      }
    }

    fetchOrders()
  }, [orderIds.join(',')])

  // Group by store
  const filteredOrders = courierFilter
    ? orders.filter((o) => o.courier.toLowerCase().includes(courierFilter.toLowerCase()))
    : orders

  const groupedByStore = filteredOrders.reduce(
    (acc, order) => {
      if (!acc[order.storeId]) {
        acc[order.storeId] = { name: order.storeName, platform: order.platform, orders: [] }
      }
      acc[order.storeId].orders.push(order)
      return acc
    },
    {} as Record<string, { name: string; platform: string; orders: PrintOrder[] }>
  )

  const couriers = [...new Set(orders.map((o) => o.courier))]

  const handlePrintAll = async () => {
    setPrinting(true)
    setProgress(0)
    setError('')

    try {
      const ids = filteredOrders.map((o) => o.id)
      const response = await api.post(
        '/orders/print',
        { ids, reprint: isReprint },
        { responseType: 'blob', timeout: 120000 }
      )

      // Simulate progress
      const interval = setInterval(() => {
        setProgress((prev) => {
          if (prev >= 90) {
            clearInterval(interval)
            return 90
          }
          return prev + 10
        })
      }, 300)

      // Download PDF
      const url = window.URL.createObjectURL(new Blob([response.data]))
      const link = document.createElement('a')
      link.href = url
      link.setAttribute('download', `resi-${new Date().toISOString().slice(0, 10)}.pdf`)
      document.body.appendChild(link)
      link.click()
      link.remove()
      window.URL.revokeObjectURL(url)

      clearInterval(interval)
      setProgress(100)
      setDone(true)
      // No follow-up call to mark these printed: /orders/print does it in the
      // same request. As two calls, a failure between them left the label
      // printed and the order still listed as unprinted.
    } catch (err) {
      setError('Gagal mencetak resi. Silakan coba lagi.')
      setProgress(0)
    } finally {
      setPrinting(false)
    }
  }

  const handlePreview = (order: PrintOrder) => {
    setPreviewOrder(order)
  }

  if (orderIds.length === 0) {
    return (
      <div className="space-y-6">
        <div>
          <h1 className="text-2xl font-bold text-gray-900 dark:text-slate-100">Cetak Resi</h1>
          <p className="text-sm text-gray-500 dark:text-slate-400 mt-1">Cetak resi pengiriman pesanan</p>
        </div>
        <div className="card p-16 text-center">
          <Printer className="w-16 h-16 text-gray-300 dark:text-slate-600 mx-auto mb-4" />
          <h2 className="text-lg font-semibold text-gray-900 dark:text-slate-100 mb-2">Belum ada pesanan dipilih</h2>
          <p className="text-gray-500 dark:text-slate-400 mb-6">
            Pilih pesanan dari halaman Pesanan terlebih dahulu, lalu klik tombol cetak.
          </p>
          <button onClick={() => router.push('/orders')} className="btn-primary">
            <ArrowLeft className="w-4 h-4" />
            Ke Halaman Pesanan
          </button>
        </div>
      </div>
    )
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <Loader2 className="w-8 h-8 animate-spin text-primary-600" />
      </div>
    )
  }

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <button
            onClick={() => router.push('/orders')}
            className="flex items-center gap-1 text-sm text-gray-500 dark:text-slate-400 hover:text-gray-700 dark:hover:text-slate-200 mb-2"
          >
            <ArrowLeft className="w-4 h-4" />
            Kembali ke Pesanan
          </button>
          <h1 className="text-2xl font-bold text-gray-900 dark:text-slate-100">
            {isReprint ? 'Cetak Ulang Resi' : 'Cetak Resi'}
          </h1>
          <p className="text-sm text-gray-500 dark:text-slate-400 mt-0.5">
            {filteredOrders.length} pesanan siap dicetak
          </p>
        </div>
        <button
          onClick={handlePrintAll}
          disabled={printing || filteredOrders.length === 0}
          className="btn-primary"
        >
          {printing ? (
            <Loader2 className="w-4 h-4 animate-spin" />
          ) : (
            <Printer className="w-4 h-4" />
          )}
          Cetak Semua ({filteredOrders.length})
        </button>
      </div>

      {/* Error */}
      {error && (
        <div className="bg-red-50 dark:bg-red-950/50 border border-red-200 dark:border-red-800 text-red-700 dark:text-red-300 px-4 py-3 rounded-lg text-sm flex items-center justify-between">
          <span>{error}</span>
          <button onClick={() => setError('')} className="text-red-500 dark:text-red-400 hover:text-red-700 dark:hover:text-red-200">×</button>
        </div>
      )}

      {/* Progress */}
      {printing && (
        <div className="card p-6">
          <div className="flex items-center gap-4 mb-3">
            <Loader2 className="w-5 h-5 animate-spin text-primary-600" />
            <span className="text-sm font-medium text-gray-700 dark:text-slate-300">Mencetak resi...</span>
            <span className="text-sm text-gray-500 dark:text-slate-400 ml-auto">{progress}%</span>
          </div>
          <div className="w-full bg-gray-200 dark:bg-slate-700 rounded-full h-2">
            <div
              className="bg-primary-600 h-2 rounded-full transition-all duration-300"
              style={{ width: `${progress}%` }}
            />
          </div>
        </div>
      )}

      {/* Done */}
      {done && (
        <div className="card p-6 bg-green-50 dark:bg-green-950/50 border-green-200 dark:border-green-800">
          <div className="flex items-center gap-3">
            <CheckCircle2 className="w-6 h-6 text-green-600 dark:text-green-400" />
            <div>
              <p className="font-medium text-green-900 dark:text-green-200">Resi berhasil dicetak!</p>
              <p className="text-sm text-green-700 dark:text-green-300">File PDF telah diunduh ke komputer Anda.</p>
            </div>
            <button
              onClick={() => router.push('/orders')}
              className="btn-secondary ml-auto"
            >
              <ArrowLeft className="w-4 h-4" />
              Kembali
            </button>
          </div>
        </div>
      )}

      {/* Courier filter */}
      {couriers.length > 1 && (
        <div className="card p-4">
          <div className="flex items-center gap-3">
            <Filter className="w-4 h-4 text-gray-400 dark:text-slate-500" />
            <span className="text-sm text-gray-600 dark:text-slate-400">Filter Kurir:</span>
            <select
              value={courierFilter}
              onChange={(e) => setCourierFilter(e.target.value)}
              className="input w-auto min-w-[160px]"
            >
              <option value="">Semua Kurir</option>
              {couriers.map((c) => (
                <option key={c} value={c}>{c}</option>
              ))}
            </select>
          </div>
        </div>
      )}

      {/* Grouped orders */}
      {Object.entries(groupedByStore).map(([storeId, group]) => (
        <div key={storeId} className="card overflow-hidden">
          <div className="px-6 py-4 bg-gray-50 dark:bg-slate-800/80 border-b border-gray-200 dark:border-slate-700 flex items-center justify-between">
            <div className="flex items-center gap-3">
              <h3 className="font-semibold text-gray-900 dark:text-slate-100">{group.name}</h3>
              <span className={group.platform === 'SHOPEE' ? 'badge-shopee' : 'badge-tiktok'}>
                {group.platform}
              </span>
            </div>
            <span className="text-sm text-gray-500 dark:text-slate-400">{group.orders.length} pesanan</span>
          </div>
          <div className="divide-y divide-gray-100 dark:divide-slate-700/60">
            {group.orders.map((order) => (
              <div key={order.id} className="px-6 py-4 flex items-center justify-between hover:bg-gray-50 dark:hover:bg-slate-700/40">
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-3">
                    <span className="font-mono text-sm font-medium text-gray-900 dark:text-slate-100">
                      {order.orderId}
                    </span>
                    <span className="text-sm text-gray-500 dark:text-slate-500">•</span>
                    <span className="text-sm text-gray-700 dark:text-slate-300">{order.buyerName}</span>
                  </div>
                  <div className="flex items-center gap-4 mt-1 text-sm text-gray-500 dark:text-slate-400">
                    <span>{order.courier}</span>
                    {order.trackingNumber && (
                      <span className="font-mono">{order.trackingNumber}</span>
                    )}
                  </div>
                </div>
                <button
                  onClick={() => handlePreview(order)}
                  className="btn-ghost text-sm"
                >
                  <Eye className="w-4 h-4" />
                  Preview
                </button>
              </div>
            ))}
          </div>
        </div>
      ))}

      {/* Preview Modal */}
      {previewOrder && (
        <div className="fixed inset-0 bg-black/50 z-50 flex items-center justify-center p-4">
          <div className="bg-white dark:bg-slate-800 rounded-xl shadow-2xl max-w-lg w-full max-h-[90vh] overflow-y-auto">
            <div className="px-6 py-4 border-b border-gray-200 dark:border-slate-700 flex items-center justify-between">
              <h3 className="font-semibold text-gray-900 dark:text-slate-100">Preview Resi</h3>
              <button
                onClick={() => setPreviewOrder(null)}
                className="text-gray-400 dark:text-slate-500 hover:text-gray-600 dark:hover:text-slate-200 text-xl"
              >
                ×
              </button>
            </div>
            <div className="p-6 space-y-4">
              <div className="text-center border-b border-dashed border-gray-300 dark:border-slate-600 pb-4">
                <p className="text-lg font-bold text-gray-900 dark:text-slate-100">{previewOrder.storeName}</p>
                <p className="text-sm text-gray-500 dark:text-slate-400">{previewOrder.platform}</p>
              </div>
              <div>
                <p className="text-xs text-gray-500 dark:text-slate-500 uppercase tracking-wider mb-1">Order ID</p>
                <p className="font-mono font-medium text-gray-900 dark:text-slate-100">{previewOrder.orderId}</p>
              </div>
              <div>
                <p className="text-xs text-gray-500 dark:text-slate-500 uppercase tracking-wider mb-1">Penerima</p>
                <p className="font-medium text-gray-900 dark:text-slate-100">{previewOrder.buyerName}</p>
                <p className="text-sm text-gray-600 dark:text-slate-400 mt-1">{previewOrder.address}</p>
              </div>
              <div>
                <p className="text-xs text-gray-500 dark:text-slate-500 uppercase tracking-wider mb-1">Kurir</p>
                <p className="text-gray-900 dark:text-slate-100">{previewOrder.courier}</p>
                {previewOrder.trackingNumber && (
                  <p className="font-mono text-sm mt-1 text-gray-900 dark:text-slate-100">{previewOrder.trackingNumber}</p>
                )}
              </div>
              <div>
                <p className="text-xs text-gray-500 dark:text-slate-500 uppercase tracking-wider mb-2">Item</p>
                <div className="space-y-2">
                  {previewOrder.items.map((item, i) => (
                    <div key={i} className="flex justify-between text-sm">
                      <div>
                        <p className="text-gray-900 dark:text-slate-100">{item.name}</p>
                        {item.variant && <p className="text-gray-500 dark:text-slate-400 text-xs">{item.variant}</p>}
                      </div>
                      <span className="text-gray-600 dark:text-slate-400">x{item.qty}</span>
                    </div>
                  ))}
                </div>
              </div>
            </div>
            <div className="px-6 py-4 border-t border-gray-200 dark:border-slate-700 flex justify-end">
              <button onClick={() => setPreviewOrder(null)} className="btn-secondary">
                Tutup
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

export default function PrintPage() {
  return (
    <Suspense fallback={
      <div className="flex items-center justify-center h-64">
        <Loader2 className="w-8 h-8 animate-spin text-primary-600" />
      </div>
    }>
      <PrintPageContent />
    </Suspense>
  )
}
