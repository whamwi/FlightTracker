/**
 * The FlySyria mark and wordmark, shared by every page header.
 *
 * This lived as five byte-identical copies of the logo plus five hand-written wordmarks,
 * which had already drifted: three pages read "FlySyria", two read "FlySyria Tracker", and
 * two carried a "DAM · ALP" subtitle the others did not. One component is the only way that
 * stays fixed.
 *
 * "Fly" is the brand beige taken from the paper plane in the mark; "Syria" is the same deep
 * green as the globe. Both are literals rather than palette references because each page
 * defines its own local `C` object with slightly different values — the brand should not
 * shift depending on which page you are looking at.
 */

const BEIGE = '#B9A779'
const GREEN = '#054239'

export function FlySyriaLogo({ size = 44 }: { size?: number }) {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" width={size} height={size} viewBox="0 0 100 100" fill="none">
      <circle cx="40" cy="58" r="32" stroke={GREEN} strokeWidth="2.6"/>
      <circle cx="40" cy="58" r="25" fill={GREEN} stroke={GREEN} strokeWidth="2.6"/>
      <g transform="rotate(90 40 58)"><path d="M40 33v50M20 38c7 8 7 32 0 40M60 38c-7 8-7 32 0 40M11 58h58" stroke="#EDEBE0" strokeWidth="2.2" strokeLinecap="round"/></g>
      <g transform="translate(58 4) rotate(-12) scale(1.7)">
        <path d="M17.8 19.2 16 11l3.5-3.5C21 6 21.5 4 21 3c-1-.5-3 0-4.5 1.5L13 8 4.8 6.2c-.5-.1-.9.1-1.1.5l-.3.5c-.2.5-.1 1 .3 1.3L9 12l-2 3H4l-1 1 3 2 2 3 1-1v-3l3-2 3.5 5.3c.3.4.8.5 1.3.3l.5-.2c.4-.3.6-.7.5-1.2z" fill={BEIGE} stroke={GREEN} strokeWidth="1.1" strokeLinejoin="round" strokeLinecap="round"/>
      </g>
    </svg>
  )
}

/** Mark plus the two-tone name, laid out for a page header. */
export default function Wordmark({ logoSize = 44, fontSize = 16 }: { logoSize?: number; fontSize?: number }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexShrink: 0 }}>
      <FlySyriaLogo size={logoSize} />
      <span style={{ font: `700 ${fontSize}px/1 'Instrument Sans',system-ui`, letterSpacing: '-.01em', whiteSpace: 'nowrap' }}>
        <span style={{ color: BEIGE }}>Fly</span><span style={{ color: GREEN }}>Syria</span>
      </span>
    </div>
  )
}
