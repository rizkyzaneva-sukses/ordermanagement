import type { Metadata, Viewport } from 'next'
import { Inter } from 'next/font/google'
import './globals.css'
import { ThemeProvider } from '@/components/ThemeProvider'
import ServiceWorker from '@/components/ServiceWorker'

const inter = Inter({ subsets: ['latin'] })

export const metadata: Metadata = {
  title: 'OrderPro - Manajemen Pesanan',
  description: 'Aplikasi manajemen pesanan internal',
  // iPhone: "Tambahkan ke Layar Utama" opens full screen instead of in Safari.
  appleWebApp: { capable: true, title: 'OrderPro', statusBarStyle: 'default' },
}

export const viewport: Viewport = {
  themeColor: [
    { media: '(prefers-color-scheme: light)', color: '#f9fafb' },
    { media: '(prefers-color-scheme: dark)', color: '#0f172a' },
  ],
}

export default function RootLayout({
  children,
}: {
  children: React.ReactNode
}) {
  return (
    <html lang="id" suppressHydrationWarning>
      <body className={`${inter.className} bg-gray-50 text-gray-900 dark:bg-slate-900 dark:text-slate-100 min-h-screen`}>
        <ThemeProvider>
          {children}
        </ThemeProvider>
        <ServiceWorker />
      </body>
    </html>
  )
}
