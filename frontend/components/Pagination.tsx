'use client'

import type { ReactNode } from 'react'
import { ChevronLeft, ChevronRight, ChevronsLeft, ChevronsRight } from 'lucide-react'

export const PAGE_SIZE_OPTIONS = [20, 50, 100, 200, 500]

interface PaginationProps {
  page: number
  totalPages: number
  total: number
  limit: number
  loading?: boolean
  /** What one row is called: "listing", "master produk". */
  unit: string
  onPageChange: (page: number) => void
  onLimitChange: (limit: number) => void
  /** Extra actions rendered at the right end of the bar. */
  children?: ReactNode
}

/**
 * Page-size picker and page navigation for a table card.
 *
 * Rendered whenever the table has rows, not only when it spills past one page:
 * the page-size control lives here, and hiding it at 500-per-page would leave no
 * way back to 20. First/last buttons matter at catalogue scale — 11.000 listings
 * at 20 a page is 550 pages, too far to reach five numbers at a time.
 */
export default function Pagination({
  page,
  totalPages,
  total,
  limit,
  loading,
  unit,
  onPageChange,
  onLimitChange,
  children,
}: PaginationProps) {
  const from = total === 0 ? 0 : (page - 1) * limit + 1
  const to = Math.min(page * limit, total)
  const firstShown = Math.max(1, Math.min(page - 2, totalPages - 4))
  const pages = Array.from({ length: Math.min(5, totalPages) }, (_, i) => firstShown + i)

  return (
    <div className="px-4 py-3 border-b border-gray-200 dark:border-slate-700 flex flex-wrap items-center justify-between gap-3">
      <div className="flex flex-wrap items-center gap-3">
        <span className="text-sm text-gray-500 dark:text-slate-400">
          {loading
            ? 'Memuat…'
            : total === 0
              ? `0 ${unit}`
              : `Menampilkan ${from.toLocaleString('id-ID')}–${to.toLocaleString('id-ID')} dari ${total.toLocaleString('id-ID')} ${unit}`}
        </span>
        <select
          value={limit}
          onChange={(e) => onLimitChange(Number(e.target.value))}
          className="input py-1 text-sm w-auto min-w-[110px]"
          aria-label="Jumlah per halaman"
        >
          {PAGE_SIZE_OPTIONS.map((n) => (
            <option key={n} value={n}>{n} / halaman</option>
          ))}
        </select>
      </div>

      {totalPages > 1 && (
        <div className="flex items-center gap-1">
          <button
            onClick={() => onPageChange(1)}
            disabled={page === 1}
            className="btn-ghost p-2"
            aria-label="Halaman pertama"
          >
            <ChevronsLeft className="w-4 h-4" />
          </button>
          <button
            onClick={() => onPageChange(Math.max(1, page - 1))}
            disabled={page === 1}
            className="btn-ghost p-2"
            aria-label="Halaman sebelumnya"
          >
            <ChevronLeft className="w-4 h-4" />
          </button>
          {pages.map((n) => (
            <button
              key={n}
              onClick={() => onPageChange(n)}
              aria-current={page === n ? 'page' : undefined}
              className={`min-w-9 h-9 px-2 rounded-lg text-sm font-medium transition-colors ${
                page === n
                  ? 'bg-primary-600 text-white'
                  : 'text-gray-600 dark:text-slate-400 hover:bg-gray-100 dark:hover:bg-slate-700'
              }`}
            >
              {n.toLocaleString('id-ID')}
            </button>
          ))}
          <button
            onClick={() => onPageChange(Math.min(totalPages, page + 1))}
            disabled={page >= totalPages}
            className="btn-ghost p-2"
            aria-label="Halaman berikutnya"
          >
            <ChevronRight className="w-4 h-4" />
          </button>
          <button
            onClick={() => onPageChange(totalPages)}
            disabled={page >= totalPages}
            className="btn-ghost p-2"
            aria-label="Halaman terakhir"
          >
            <ChevronsRight className="w-4 h-4" />
          </button>
        </div>
      )}

      {children}
    </div>
  )
}
