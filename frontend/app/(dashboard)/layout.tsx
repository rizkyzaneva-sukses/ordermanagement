'use client'

import { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import Sidebar from '@/components/Sidebar'
import { User, getMe, getToken } from '@/lib/auth'
import { Loader2 } from 'lucide-react'

export default function DashboardLayout({
  children,
}: {
  children: React.ReactNode
}) {
  const router = useRouter()
  const [user, setUser] = useState<User | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    const token = getToken()
    if (!token) {
      router.push('/login')
      return
    }

    getMe()
      .then(setUser)
      .catch(() => {
        router.push('/login')
      })
      .finally(() => setLoading(false))
  }, [router])

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-gray-50 dark:bg-slate-900">
        <Loader2 className="w-8 h-8 animate-spin text-primary-600" />
      </div>
    )
  }

  return (
    <div className="min-h-screen bg-gray-50 dark:bg-slate-900 transition-colors">
      <Sidebar user={user} />
      {/* Top padding spelled out per breakpoint: a bare `sm:p-6` would undo
          the room left for the fixed mobile header on tablets. */}
      <main className="lg:ml-64 px-4 pb-6 pt-20 sm:px-6 sm:pt-[5.5rem] lg:pt-6 max-w-7xl min-w-0 transition-all duration-200">
        {children}
      </main>
    </div>
  )
}
