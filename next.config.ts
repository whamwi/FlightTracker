import type { NextConfig } from 'next'

const nextConfig: NextConfig = {
  async headers() {
    return [
      {
        /**
         * The Apple App Site Association file has no extension, so it would otherwise be
         * served as application/octet-stream and iOS would reject it. The failure is silent —
         * links simply open Safari — which is easy to misread as the app not being installed.
         *
         * It must also be reachable with no redirect: iOS does not follow one when fetching
         * this file, so www and apex both have to answer directly.
         */
        source: '/.well-known/apple-app-site-association',
        headers: [{ key: 'Content-Type', value: 'application/json' }],
      },
    ]
  },
}

export default nextConfig
