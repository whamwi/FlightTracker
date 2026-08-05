import type { Metadata } from 'next'

/**
 * Required by the App Store, and short because the app genuinely collects almost nothing.
 *
 * Every claim here was checked against the code before it was written: there is no location
 * permission and no usage descriptions in Info.plist, no accounts, no email, no camera or
 * contacts access. The only thing that leaves a phone is a push token and the flight numbers
 * someone asked to be told about.
 *
 * Written to be read rather than to satisfy a lawyer. A policy nobody understands protects
 * nobody, and overstating what we collect would be as wrong as understating it.
 */

export const metadata: Metadata = {
  title: 'Privacy · FlySyria',
  description: 'What FlySyria collects, what it does not, and how to turn it off.',
  alternates: { canonical: 'https://www.flysyria.app/privacy' },
}

const UPDATED = '5 August 2026'

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section style={{ marginBottom: 30 }}>
      <h2 style={{ font: `700 17px/1.3 'Instrument Sans',system-ui`, color: '#161616', margin: '0 0 8px' }}>
        {title}
      </h2>
      <div style={{ font: `400 14.5px/1.65 'Instrument Sans',system-ui`, color: '#3D3A3B' }}>
        {children}
      </div>
    </section>
  )
}

export default function PrivacyPage() {
  return (
    <div style={{ minHeight: '100vh', background: '#EDEBE0', padding: '40px 20px 60px' }}>
      <div style={{ maxWidth: 680, margin: '0 auto' }}>
        <h1 style={{ font: `700 28px/1.2 'Instrument Sans',system-ui`, color: '#161616', margin: '0 0 6px', letterSpacing: '-0.02em' }}>
          Privacy
        </h1>
        <p style={{ font: `500 13px/1 'IBM Plex Mono',monospace`, color: '#8A8578', margin: '0 0 32px' }}>
          FlySyria · updated {UPDATED}
        </p>

        <Section title="The short version">
          <p style={{ margin: 0 }}>
            FlySyria has no accounts. We never ask for your name, email or phone number, and we
            cannot tell who you are. The website and the app show public flight information;
            almost nothing travels in the other direction.
          </p>
        </Section>

        <Section title="What we store">
          <p style={{ margin: '0 0 10px' }}>
            <strong>If you turn on flight alerts</strong>, your device sends us a notification
            token — an anonymous address Apple or Google uses to deliver a message to that one
            phone — together with the flight numbers you asked to be told about. That is the
            whole of it. The token identifies a device, not a person, and we hold nothing that
            could connect it to you.
          </p>
          <p style={{ margin: 0 }}>
            <strong>Pinned flights stay on your phone.</strong> They are written to the app&rsquo;s
            own storage and never sent anywhere.
          </p>
        </Section>

        <Section title="What we do not collect">
          <p style={{ margin: 0 }}>
            We do not ask for or receive your location. The app draws where aircraft are, not
            where you are — it has no location permission at all. We do not access your
            contacts, photos, camera or microphone, and we do not track you across other apps
            or websites.
          </p>
        </Section>

        <Section title="Website analytics">
          <p style={{ margin: 0 }}>
            The website counts page views through Vercel Web Analytics, which uses no cookies
            and no cross-site identifiers. It tells us that a page was viewed, not who viewed
            it. The app contains no analytics of any kind.
          </p>
        </Section>

        <Section title="Where flight information comes from">
          <p style={{ margin: 0 }}>
            Schedules, arrival and departure times come from public aviation sources, including
            Flightradar24, publicly broadcast ADS-B transponder signals, and the published
            timetables of the airports and airlines themselves. Photographs and videos come
            from the Syrian General Authority of Civil Aviation&rsquo;s own public accounts.
            None of it is about you.
          </p>
        </Section>

        <Section title="Turning alerts off">
          <p style={{ margin: 0 }}>
            Tap the bell on a flight again to stop alerts for it, or turn off notifications for
            FlySyria in your phone&rsquo;s settings. If you delete the app, the delivery service
            tells us the token is dead and we stop using it. To have your token removed sooner,
            email us and we will delete it.
          </p>
        </Section>

        <Section title="Children">
          <p style={{ margin: 0 }}>
            FlySyria is not directed at children and collects nothing that would identify
            anyone, of any age.
          </p>
        </Section>

        <Section title="Changes">
          <p style={{ margin: 0 }}>
            If what we collect ever changes, this page changes with it and the date at the top
            moves. We will not start collecting something new and quietly leave this text as it
            was.
          </p>
        </Section>

        <Section title="Contact">
          <p style={{ margin: 0 }}>
            Questions, or a request to delete your notification token:{' '}
            <a href="mailto:privacy@flysyria.app" style={{ color: '#054239', fontWeight: 600 }}>
              privacy@flysyria.app
            </a>
          </p>
        </Section>

        <p style={{ font: `400 12.5px/1.6 'Instrument Sans',system-ui`, color: '#8A8578', borderTop: '1px solid #D8D3BF', paddingTop: 18, margin: 0 }}>
          FlySyria is an independent service and is not affiliated with any airline or airport
          authority.
        </p>
      </div>
    </div>
  )
}
