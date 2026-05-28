import type { Metadata, Viewport } from 'next'
import { Geist } from 'next/font/google'
import Script from 'next/script'
import './globals.css'

const geist = Geist({ subsets: ['latin'], variable: '--font-geist-sans' })

export const metadata: Metadata = {
  title: '음대 연습실',
  description: '음악대학 연습실 키오스크 대기 현황을 학우들과 실시간으로 공유해요',
  manifest: '/manifest.json',
  appleWebApp: {
    capable: true,
    statusBarStyle: 'black-translucent',
    title: '음대 연습실',
  },
  openGraph: {
    title: '음대 연습실',
    description: '연습실 공실 현황을 실시간으로 확인하고, 태그·반납 알림을 받아보세요',
    type: 'website',
    locale: 'ko_KR',
    images: [{ url: '/icons/icon-512x512.png', width: 512, height: 512, alt: '음대 연습실' }],
  },
  twitter: {
    card: 'summary',
    title: '음대 연습실',
    description: '연습실 공실 현황을 실시간으로 확인하고, 태그·반납 알림을 받아보세요',
    images: ['/icons/icon-512x512.png'],
  },
}

export const viewport: Viewport = {
  themeColor: '#2563eb',
  width: 'device-width',
  initialScale: 1,
  maximumScale: 1,
  viewportFit: 'cover',
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="ko" className={`${geist.variable} h-full`}>
      <head>
        <link rel="apple-touch-icon" href="/icons/icon-192x192.png" />
      </head>
      <body className="min-h-full font-sans antialiased">
        {children}
      </body>
      
      {/* Google Analytics */}
      <Script
        src="https://www.googletagmanager.com/gtag/js?id=G-RR9QPFPWCP"
        strategy="afterInteractive"
      />
      <Script id="google-analytics" strategy="afterInteractive">
        {`
          window.dataLayer = window.dataLayer || [];
          function gtag(){dataLayer.push(arguments);}
          gtag('js', new Date());
          gtag('config', 'G-RR9QPFPWCP');
        `}
      </Script>
    </html>
  )
}
