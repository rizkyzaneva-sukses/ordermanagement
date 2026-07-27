'use client'

import { useState } from 'react'
import { usePathname } from 'next/navigation'
import Link from 'next/link'
import {
  LayoutDashboard,
  ShoppingBag,
  Printer,
  Users,
  Store,
  LogOut,
  Package,
  Sun,
  Moon,
  Menu,
  X,
} from 'lucide-react'
import { User, logout } from '@/lib/auth'
import { useTheme } from './ThemeProvider'

interface SidebarProps {
  user: User | null
}

const navItems = [
  { href: '/dashboard', label: 'Dashboard', icon: LayoutDashboard },
  { href: '/orders', label: 'Pesanan', icon: ShoppingBag },
  { href: '/print', label: 'Cetak Resi', icon: Printer },
]

const adminItems = [
  { href: '/admin/users', label: 'Kelola User', icon: Users },
  { href: '/admin/stores', label: 'Kelola Toko', icon: Store },
]

export default function Sidebar({ user }: SidebarProps) {
  const pathname = usePathname()
  const { theme, toggleTheme } = useTheme()
  const [mobileOpen, setMobileOpen] = useState(false)

  const isActive = (href: string) => {
    if (href === '/dashboard') return pathname === '/dashboard'
    return pathname.startsWith(href)
  }

  return (
    <>
      {/* Mobile Top Header */}
      <header className="lg:hidden fixed top-0 left-0 right-0 h-16 bg-white dark:bg-slate-800 border-b border-gray-200 dark:border-slate-700 px-4 flex items-center justify-between z-40">
        <div className="flex items-center gap-3">
          <button
            onClick={() => setMobileOpen(!mobileOpen)}
            className="p-2 rounded-lg text-gray-600 dark:text-slate-300 hover:bg-gray-100 dark:hover:bg-slate-700 focus:outline-none"
            aria-label="Toggle menu"
          >
            {mobileOpen ? <X className="w-6 h-6" /> : <Menu className="w-6 h-6" />}
          </button>
          <div className="flex items-center gap-2">
            <div className="w-7 h-7 bg-primary-600 rounded-md flex items-center justify-center">
              <Package className="w-4 h-4 text-white" />
            </div>
            <span className="font-bold text-gray-900 dark:text-slate-100">OrderPro</span>
          </div>
        </div>

        <button
          onClick={toggleTheme}
          className="p-2 rounded-lg text-gray-600 dark:text-slate-300 hover:bg-gray-100 dark:hover:bg-slate-700 transition-colors"
          title={theme === 'light' ? 'Aktifkan Dark Mode' : 'Aktifkan Light Mode'}
        >
          {theme === 'light' ? (
            <Moon className="w-5 h-5 text-slate-700" />
          ) : (
            <Sun className="w-5 h-5 text-amber-400" />
          )}
        </button>
      </header>

      {/* Mobile Backdrop */}
      {mobileOpen && (
        <div
          onClick={() => setMobileOpen(false)}
          className="lg:hidden fixed inset-0 bg-black/50 z-40 backdrop-blur-sm transition-opacity"
        />
      )}

      {/* Sidebar Content */}
      <aside
        className={`fixed left-0 top-0 bottom-0 w-64 bg-white dark:bg-slate-800 border-r border-gray-200 dark:border-slate-700 flex flex-col z-50 transition-transform duration-200 ease-in-out ${
          mobileOpen ? 'translate-x-0' : '-translate-x-full lg:translate-x-0'
        }`}
      >
        {/* Logo */}
        <div className="h-16 flex items-center justify-between px-6 border-b border-gray-200 dark:border-slate-700">
          <div className="flex items-center gap-3">
            <div className="w-8 h-8 bg-primary-600 rounded-lg flex items-center justify-center">
              <Package className="w-5 h-5 text-white" />
            </div>
            <span className="text-lg font-bold text-gray-900 dark:text-slate-100">OrderPro</span>
          </div>
          <button
            onClick={() => setMobileOpen(false)}
            className="lg:hidden text-gray-400 hover:text-gray-600 dark:hover:text-slate-200"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Navigation */}
        <nav className="flex-1 px-3 py-4 space-y-1 overflow-y-auto">
          {navItems.map((item) => {
            const Icon = item.icon
            const active = isActive(item.href)
            return (
              <Link
                key={item.href}
                href={item.href}
                onClick={() => setMobileOpen(false)}
                className={`flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm font-medium transition-colors ${
                  active
                    ? 'bg-primary-50 dark:bg-primary-950/50 text-primary-600 dark:text-primary-400 font-semibold'
                    : 'text-gray-600 dark:text-slate-300 hover:bg-gray-50 dark:hover:bg-slate-700/60 hover:text-gray-900 dark:hover:text-white'
                }`}
              >
                <Icon
                  className={`w-5 h-5 ${
                    active ? 'text-primary-600 dark:text-primary-400' : 'text-gray-400 dark:text-slate-400'
                  }`}
                />
                {item.label}
              </Link>
            )
          })}

          {/* Admin section */}
          {user?.role === 'ADMIN' && (
            <>
              <div className="pt-4 pb-2 px-3">
                <p className="text-xs font-semibold text-gray-400 dark:text-slate-500 uppercase tracking-wider">
                  Admin
                </p>
              </div>
              {adminItems.map((item) => {
                const Icon = item.icon
                const active = isActive(item.href)
                return (
                  <Link
                    key={item.href}
                    href={item.href}
                    onClick={() => setMobileOpen(false)}
                    className={`flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm font-medium transition-colors ${
                      active
                        ? 'bg-primary-50 dark:bg-primary-950/50 text-primary-600 dark:text-primary-400 font-semibold'
                        : 'text-gray-600 dark:text-slate-300 hover:bg-gray-50 dark:hover:bg-slate-700/60 hover:text-gray-900 dark:hover:text-white'
                    }`}
                  >
                    <Icon
                      className={`w-5 h-5 ${
                        active ? 'text-primary-600 dark:text-primary-400' : 'text-gray-400 dark:text-slate-400'
                      }`}
                    />
                    {item.label}
                  </Link>
                )
              })}
            </>
          )}
        </nav>

        {/* Theme Toggle & User profile */}
        <div className="border-t border-gray-200 dark:border-slate-700 p-4 space-y-3">
          {/* Dark Mode Switcher */}
          <button
            onClick={toggleTheme}
            className="flex items-center justify-between w-full px-3 py-2 text-sm rounded-lg bg-gray-50 dark:bg-slate-700/60 text-gray-700 dark:text-slate-200 hover:bg-gray-100 dark:hover:bg-slate-700 transition-colors"
          >
            <div className="flex items-center gap-2">
              {theme === 'light' ? (
                <Sun className="w-4 h-4 text-amber-500" />
              ) : (
                <Moon className="w-4 h-4 text-indigo-400" />
              )}
              <span className="font-medium">
                {theme === 'light' ? 'Mode Terang' : 'Mode Gelap'}
              </span>
            </div>
            <span className="text-xs px-2 py-0.5 rounded bg-gray-200 dark:bg-slate-600 text-gray-600 dark:text-slate-300 font-semibold">
              {theme === 'light' ? 'Light' : 'Dark'}
            </span>
          </button>

          {/* User profile info */}
          <div className="flex items-center gap-3 pt-1">
            <div className="w-9 h-9 bg-primary-100 dark:bg-primary-950 rounded-full flex items-center justify-center">
              <span className="text-sm font-semibold text-primary-700 dark:text-primary-300">
                {user?.name?.charAt(0)?.toUpperCase() || '?'}
              </span>
            </div>
            <div className="flex-1 min-w-0">
              <p className="text-sm font-medium text-gray-900 dark:text-slate-100 truncate">
                {user?.name || 'Loading...'}
              </p>
              <p className="text-xs text-gray-500 dark:text-slate-400 truncate">
                {user?.email || ''}
              </p>
            </div>
          </div>

          <button
            onClick={logout}
            className="flex items-center gap-2 w-full px-3 py-2 text-sm text-gray-600 dark:text-slate-300 rounded-lg hover:bg-gray-50 dark:hover:bg-slate-700/60 hover:text-gray-900 dark:hover:text-white transition-colors"
          >
            <LogOut className="w-4 h-4" />
            Keluar
          </button>
        </div>
      </aside>
    </>
  )
}
