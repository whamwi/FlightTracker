'use client'

import dynamic from 'next/dynamic'
import Link from 'next/link'

const Map = dynamic(() => import('@/components/Map'), { ssr: false })

export default function Home() {
  return (
    <main className="w-screen h-screen relative">
      <Map />
      <div className="absolute top-3 right-4 z-[1000] flex gap-2">
        <Link
          href="/board"
          className="bg-gray-900/90 backdrop-blur text-gray-200 text-sm
            px-3 py-1.5 rounded-full border border-gray-700 hover:bg-gray-700 transition-colors"
        >
          Flight Board →
        </Link>
        <Link
          href="/schedule"
          className="bg-gray-900/90 backdrop-blur text-gray-200 text-sm
            px-3 py-1.5 rounded-full border border-gray-700 hover:bg-gray-700 transition-colors"
        >
          Schedule →
        </Link>
      </div>
    </main>
  )
}
