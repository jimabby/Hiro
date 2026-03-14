export default function HiroLogo({ size = 32, style }) {
  return (
    <svg
      viewBox="0 0 512 512"
      width={size}
      height={size}
      style={style}
      xmlns="http://www.w3.org/2000/svg"
    >
      <defs>
        <linearGradient id="hiro-bg" x1="0" y1="0" x2="512" y2="512" gradientUnits="userSpaceOnUse">
          <stop offset="0%" stopColor="#818CF8" />
          <stop offset="100%" stopColor="#4F46E5" />
        </linearGradient>
      </defs>
      {/* Rounded square background */}
      <rect width="512" height="512" rx="112" fill="url(#hiro-bg)" />
      {/* H left bar (full height) */}
      <rect x="108" y="118" width="64" height="276" rx="18" fill="white" />
      {/* Crossbar */}
      <rect x="152" y="240" width="204" height="52" rx="14" fill="white" />
      {/* i stem (right bar, shorter — starts below dot) */}
      <rect x="336" y="200" width="64" height="194" rx="18" fill="white" />
      {/* i dot */}
      <circle cx="368" cy="148" r="30" fill="white" />
    </svg>
  )
}
