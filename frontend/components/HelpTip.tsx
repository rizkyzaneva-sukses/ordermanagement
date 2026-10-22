'use client'

import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { GLOSSARY, GlossaryEntry, GlossaryKey, glossaryKey } from '@/lib/glossary'

// useLayoutEffect warns during the server render of the static export.
const useIsomorphicLayoutEffect = typeof window !== 'undefined' ? useLayoutEffect : useEffect

/**
 * The tip a tap left open, so opening another one closes it. Several tips are
 * pinned at once only if the operator really wants them to be — and on a phone
 * two popovers would cover the very labels they explain.
 */
let pinned: { close: () => void } | null = null

interface HelpTipProps {
  /** Which glossary entry to show. */
  term: GlossaryKey
  /** On a coloured background (the active tab) a grey "?" would vanish. */
  tone?: 'default' | 'inverse'
  className?: string
}

interface Placement {
  top: number
  left: number
  /** Where the arrow points, measured from the popover's left edge. */
  arrow: number
  above: boolean
}

/**
 * A small "?" that explains what the label beside it means and what to do about it.
 *
 * Tap to open, tap again or anywhere else to close — hovering also opens it with
 * a mouse, but a phone has no hover, and the phone is where this was asked for.
 * The popover is portalled to <body> and positioned against the button: the
 * tables and cards it sits in clip anything that overflows them, and a tip that
 * is cut off is worse than none.
 */
export default function HelpTip({ term, tone = 'default', className = '' }: HelpTipProps) {
  const entry: GlossaryEntry = GLOSSARY[term]
  const id = useId()
  const buttonRef = useRef<HTMLButtonElement>(null)
  const popRef = useRef<HTMLDivElement>(null)
  const [hover, setHover] = useState(false)
  const [open, setOpen] = useState(false)
  const [placement, setPlacement] = useState<Placement | null>(null)
  const shown = hover || open

  const close = useCallback(() => {
    setOpen(false)
    setHover(false)
  }, [])

  // Forget this tip as the pinned one once it is closed or gone. Registered only
  // while open: cleaning up from the closed render would run the moment it
  // opens, and undo the registration made by the same click.
  useEffect(() => {
    if (!open) return
    return () => {
      if (pinned?.close === close) pinned = null
    }
  }, [open, close])

  const place = useCallback(() => {
    const anchor = buttonRef.current?.getBoundingClientRect()
    const pop = popRef.current?.getBoundingClientRect()
    if (!anchor || !pop) return

    const margin = 8
    const gap = 8
    const viewportW = window.innerWidth
    const viewportH = window.innerHeight

    const centre = anchor.left + anchor.width / 2
    const left = Math.max(margin, Math.min(centre - pop.width / 2, viewportW - pop.width - margin))
    // Below by default; above only when there is no room underneath and more
    // above, so a tip near the bottom bar flips instead of being clipped.
    const below = anchor.bottom + gap
    const fitsBelow = below + pop.height + margin <= viewportH
    const above = !fitsBelow && anchor.top - gap - pop.height >= margin
    const top = above ? anchor.top - gap - pop.height : below

    setPlacement({
      top,
      left,
      arrow: Math.max(12, Math.min(centre - left, pop.width - 12)),
      above,
    })
  }, [])

  // Measured before paint so the popover never flashes in the corner.
  useIsomorphicLayoutEffect(() => {
    if (!shown) {
      setPlacement(null)
      return
    }
    place()
  }, [shown, place])

  useEffect(() => {
    if (!shown) return

    const onPointerDown = (e: PointerEvent) => {
      const target = e.target as Node
      if (buttonRef.current?.contains(target) || popRef.current?.contains(target)) return
      close()
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      close()
      buttonRef.current?.focus()
    }

    document.addEventListener('pointerdown', onPointerDown, true)
    document.addEventListener('keydown', onKey)
    // `true` so a scrolling table or dialog is heard, not just the window
    window.addEventListener('scroll', place, true)
    window.addEventListener('resize', place)
    return () => {
      document.removeEventListener('pointerdown', onPointerDown, true)
      document.removeEventListener('keydown', onKey)
      window.removeEventListener('scroll', place, true)
      window.removeEventListener('resize', place)
    }
  }, [shown, close, place])

  const toggle = (e: React.MouseEvent) => {
    // The "?" often sits inside something clickable — a label, a row, a header.
    e.preventDefault()
    e.stopPropagation()
    if (open) {
      close()
      return
    }
    if (pinned && pinned.close !== close) pinned.close()
    pinned = { close }
    setOpen(true)
  }

  const colours =
    tone === 'inverse'
      ? 'bg-white/25 text-white hover:bg-white/40'
      : 'bg-gray-200 text-gray-600 hover:bg-primary-100 hover:text-primary-700 dark:bg-slate-600 dark:text-slate-200 dark:hover:bg-slate-500'

  return (
    <>
      <button
        ref={buttonRef}
        type="button"
        data-helptip=""
        onClick={toggle}
        // Mouse only: a finger's "enter" arrives together with its tap, and
        // treating that as a hover would open the tip and the tap then close it.
        onPointerEnter={(e) => { if (e.pointerType === 'mouse') setHover(true) }}
        onPointerLeave={(e) => { if (e.pointerType === 'mouse') setHover(false) }}
        aria-label={`Penjelasan: ${entry.title}`}
        aria-expanded={shown}
        aria-describedby={shown ? id : undefined}
        // The ::after widens the tap target to ~28px without making the "?" bigger.
        className={`relative inline-flex h-[18px] w-[18px] shrink-0 items-center justify-center rounded-full align-middle text-[11px] font-medium normal-case leading-none tracking-normal transition-colors after:absolute after:-inset-1.5 after:content-[''] sm:h-4 sm:w-4 sm:text-[10px] ${colours} ${className}`}
      >
        ?
      </button>

      {shown && typeof document !== 'undefined' && createPortal(
        <div
          ref={popRef}
          id={id}
          role="tooltip"
          // Portalled React events still bubble to the component tree, so a
          // click in here would otherwise reach a row or header underneath.
          onClick={(e) => e.stopPropagation()}
          style={{
            top: placement?.top ?? 0,
            left: placement?.left ?? 0,
            visibility: placement ? 'visible' : 'hidden',
          }}
          className="fixed z-[80] w-72 max-w-[calc(100vw-1rem)]"
        >
          {/* The scrolling box and the arrow are siblings: overflow on the box
              would clip an arrow that hangs outside its edge. */}
          <div className="max-h-[70vh] overflow-y-auto rounded-lg border border-gray-200 dark:border-slate-600 bg-white dark:bg-slate-800 p-3 text-left text-xs font-normal normal-case leading-relaxed tracking-normal text-gray-700 dark:text-slate-200 shadow-lg">
            <p className="text-[13px] font-semibold text-gray-900 dark:text-slate-100">{entry.title}</p>
            {entry.body && <p className="mt-1">{entry.body}</p>}
            {entry.items && (
              <dl className="mt-2 space-y-1.5">
                {entry.items.map((item) => (
                  <div key={item.term}>
                    <dt className="font-semibold text-gray-900 dark:text-slate-100">{item.term}</dt>
                    <dd className="text-gray-700 dark:text-slate-300">{item.text}</dd>
                  </div>
                ))}
              </dl>
            )}
            {entry.hint && (
              <p className="mt-2 rounded-md bg-primary-50 dark:bg-primary-900/40 px-2 py-1.5 text-primary-800 dark:text-primary-100">
                {entry.hint}
              </p>
            )}
          </div>
          {placement && (
            <span
              aria-hidden
              style={{ left: placement.arrow - 5 }}
              className={`absolute h-2.5 w-2.5 rotate-45 border-gray-200 dark:border-slate-600 bg-white dark:bg-slate-800 ${
                placement.above ? '-bottom-[5px] border-b border-r' : '-top-[5px] border-l border-t'
              }`}
            />
          )}
        </div>,
        document.body,
      )}
    </>
  )
}

/**
 * A "?" for a value that only arrives at runtime — an order status, a listing
 * status. Renders nothing when the glossary has no entry, so a status Shopee
 * adds tomorrow gets no tip rather than a broken one.
 */
export function HelpTipFor({
  prefix,
  value,
  ...rest
}: { prefix: string; value: string | null | undefined } & Omit<HelpTipProps, 'term'>) {
  const key = glossaryKey(prefix, value)
  return key ? <HelpTip term={key} {...rest} /> : null
}

/**
 * A label with its "?" — for a heading or field name that would otherwise have
 * the tip wedged in beside it by hand every time.
 */
export function Labelled({
  children,
  term,
  tone,
  className = '',
}: {
  children: React.ReactNode
  term: GlossaryKey
  tone?: 'default' | 'inverse'
  className?: string
}) {
  return (
    // A div, not a span: in dark mode a global rule recolours every span, which
    // would turn a table header's muted text lighter than its neighbours. Inline
    // flow, so on a narrow column the tip wraps with the last word, not alone.
    <div className={`inline ${className}`}>
      {children}
      <HelpTip term={term} tone={tone} className="ml-1" />
    </div>
  )
}
