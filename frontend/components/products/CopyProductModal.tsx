'use client'

import { useEffect, useState } from 'react'
import api from '@/lib/api'
import { apiError } from '@/lib/productDraft'
import { Check, Loader2, X } from 'lucide-react'

interface StoreRow {
  id: string
  name: string
  platform: string
  needsReconnect: boolean
}

export interface CopyResult {
  drafts: { id: string; targetStoreId: string; targetStoreName?: string }[]
  duplicates: { id: string; targetStoreId: string; targetStoreName?: string }[]
}

interface Props {
  listingIds: string[]
  sourceStoreId: string
  productName: string
  onClose: () => void
  onCopied: (result: CopyResult) => void
}

/**
 * "Pilih Toko tujuan untuk Salin Produk" — the Komplace dialog, Shopee only.
 */
export default function CopyProductModal({ listingIds, sourceStoreId, productName, onClose, onCopied }: Props) {
  const [stores, setStores] = useState<StoreRow[] | null>(null)
  const [chosen, setChosen] = useState<string[]>([])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    api.get<any>('/stores')
      .then((res) => {
        const raw: any[] = Array.isArray(res.data) ? res.data : (res.data?.data ?? [])
        setStores(raw
          .filter((s) => s.platform === 'SHOPEE' && s.id !== sourceStoreId)
          .map((s) => ({ id: s.id, name: s.name, platform: s.platform, needsReconnect: Boolean(s.needsReconnect) }))
          .sort((a, b) => a.name.localeCompare(b.name, 'id')))
      })
      .catch((err) => { setStores([]); setError(apiError(err, 'Daftar toko tidak bisa dimuat')) })
  }, [sourceStoreId])

  const toggle = (id: string) =>
    setChosen((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]))

  const submit = async () => {
    setBusy(true)
    setError(null)
    try {
      const res = await api.post<any>('/products/drafts', { listingIds, targetStoreIds: chosen })
      onCopied(res.data as CopyResult)
    } catch (err) {
      setError(apiError(err, 'Gagal menyalin produk'))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="fixed inset-0 z-[70] flex items-center justify-center bg-black/40 p-4" onClick={onClose}>
      <div className="card w-full max-w-3xl p-5 space-y-4 max-h-[90vh] overflow-y-auto" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-start justify-between gap-4">
          <div className="min-w-0">
            <h2 className="text-lg font-semibold text-gray-900 dark:text-slate-100">Pilih Toko tujuan untuk Salin Produk</h2>
            <p className="text-sm text-gray-500 dark:text-slate-400 truncate">{productName}</p>
          </div>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600" aria-label="Tutup">
            <X className="w-5 h-5" />
          </button>
        </div>

        <div>
          <p className="text-xs font-medium text-gray-500 dark:text-slate-400 mb-2">Pilih Marketplace</p>
          <div className="inline-flex items-center gap-2 rounded-lg border-2 border-orange-500 px-4 py-2 text-sm font-medium text-gray-900 dark:text-slate-100">
            <span className="w-5 h-5 rounded bg-orange-500 text-white text-xs flex items-center justify-center font-bold">S</span>
            Shopee
            <Check className="w-4 h-4 text-orange-500" />
          </div>
        </div>

        <div>
          <p className="text-xs font-medium text-gray-500 dark:text-slate-400 mb-2">Pilih Toko</p>
          {stores === null ? (
            <p className="text-sm text-gray-500 dark:text-slate-400 flex items-center gap-2">
              <Loader2 className="w-4 h-4 animate-spin" /> Memuat toko…
            </p>
          ) : stores.length === 0 ? (
            <p className="text-sm text-gray-600 dark:text-slate-300">
              Tidak ada toko tujuan yang bisa kamu akses selain toko asal.
            </p>
          ) : (
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-x-4 gap-y-2">
              {stores.map((s) => (
                <label
                  key={s.id}
                  className={`flex items-center gap-2 text-sm ${s.needsReconnect ? 'opacity-60 cursor-not-allowed' : 'cursor-pointer'}`}
                  title={s.needsReconnect ? 'Toko perlu dihubungkan ulang di Kelola Toko' : undefined}
                >
                  <input
                    type="checkbox"
                    disabled={s.needsReconnect}
                    checked={chosen.includes(s.id)}
                    onChange={() => toggle(s.id)}
                    className="rounded border-gray-300 dark:border-slate-600"
                  />
                  <span className="text-gray-800 dark:text-slate-200">{s.name}</span>
                  {s.needsReconnect && <span className="text-xs text-amber-700 dark:text-amber-400">(perlu dihubungkan ulang)</span>}
                </label>
              ))}
            </div>
          )}
        </div>

        {error && (
          <div className="rounded-lg border border-red-200 dark:border-red-800 bg-red-50 dark:bg-red-900/20 px-3 py-2 text-sm text-red-800 dark:text-red-200">
            {error}
          </div>
        )}

        <div className="flex items-center justify-between gap-2 pt-1">
          <span className="text-sm font-medium text-gray-700 dark:text-slate-300">{chosen.length} Toko Terpilih</span>
          <div className="flex gap-2">
            <button onClick={onClose} className="btn-secondary">Batal</button>
            <button onClick={submit} disabled={busy || chosen.length === 0} className="btn-primary flex items-center gap-2">
              {busy && <Loader2 className="w-4 h-4 animate-spin" />}
              <span>Salin Produk</span>
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
