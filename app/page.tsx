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
          href="/destinations"
          className="bg-blue-600/90 backdrop-blur text-white text-sm
            px-3 py-1.5 rounded-full border border-blue-500 hover:bg-blue-500 transition-colors"
        >
          Destinations →
        </Link>
        <Link
          href="/board"
          className="bg-gray-900/90 backdrop-blur text-gray-200 text-sm
            px-3 py-1.5 rounded-full border border-gray-700 hover:bg-gray-700 transition-colors"
        >
          Board →
        </Link>
      </div>
    </main>
  )
}
