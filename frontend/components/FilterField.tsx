import HelpTip from '@/components/HelpTip'
import type { GlossaryKey } from '@/lib/glossary'

/**
 * A filter control with its name above it and a "?" beside the name.
 *
 * Filters used to be bare dropdowns whose only label was the selected option —
 * "Semua Status" says what is chosen, not what the filter is for or how it
 * differs from "Status Cetak" two boxes along. The caption fixes both.
 */
export default function FilterField({ label, term, className = '', children }: {
  label: string
  term: GlossaryKey
  className?: string
  children: React.ReactNode
}) {
  return (
    <div className={`min-w-0 ${className}`}>
      <div className="mb-1 flex items-center gap-1 text-xs font-medium text-gray-500 dark:text-slate-400">
        {label}
        <HelpTip term={term} />
      </div>
      {children}
    </div>
  )
}
