import type { MetadataRoute } from 'next'

/** Lets operators install OrderPro to the home screen and open it full screen. */
export default function manifest(): MetadataRoute.Manifest {
  return {
    id: '/',
    name: 'OrderPro — Pesanan Shopee & TikTok Zaneva',
    short_name: 'OrderPro',
    description: 'Aplikasi manajemen pesanan internal',
    lang: 'id',
    start_url: '/dashboard/',
    scope: '/',
    display: 'standalone',
    background_color: '#f9fafb',
    theme_color: '#f9fafb',
    icons: [
      { src: '/icons/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
      { src: '/icons/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
      { src: '/icons/maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
    ],
  }
}
