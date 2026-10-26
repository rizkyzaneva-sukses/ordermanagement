'use client'

import { useEffect } from 'react'

/** Registers public/sw.js so the app is installable and shows a page when offline. */
export default function ServiceWorker() {
  useEffect(() => {
    if (process.env.NODE_ENV !== 'production' || !('serviceWorker' in navigator)) return
    navigator.serviceWorker.register('/sw.js').catch(() => {
      // Not fatal: the app works the same without it, it just can't be installed.
    })
  }, [])
  return null
}
