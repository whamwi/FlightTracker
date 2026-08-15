import type { NextConfig } from 'next'

const nextConfig: NextConfig = {
  /**
   * The commit this bundle was built from, baked into the client.
   *
   * A browser tab keeps its JavaScript for as long as it stays open, and on an audience that is
   * 78% mobile that can be days. Twice on 15 Aug a tab running old code sent us chasing a defect
   * that did not exist: once hunting why a phrase was not appearing when the code was fine, once
   * over arrived markers piling up at Damascus in behaviour that had been replaced hours earlier.
   *
   * /api/version reports the same value from whatever deployment is currently serving, so the two
   * disagree exactly when a tab is stale — and nothing has to guess.
   */
  env: {
    NEXT_PUBLIC_BUILD_ID: process.env.VERCEL_GIT_COMMIT_SHA ?? 'dev',
  },
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
