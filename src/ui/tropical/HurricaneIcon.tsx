/** A hurricane as the satellite sees it: the eye, the eyewall round it and two
 *  rain bands spiralling out. Drawn like lucide's icons so it sits beside them
 *  (lucide has no tropical cyclone of its own); the bands are a spiral whose
 *  radius grows from the eyewall out to the edge as it turns. */
export function HurricaneIcon({ size = 16, className }: { size?: number; className?: string }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden="true"
    >
      <circle cx="12" cy="12" r="2.2" fill="currentColor" stroke="none" />
      <circle cx="12" cy="12" r="4.6" />
      <path d="M16.32 10.43L16.12 9.65L15.85 8.85L15.46 8.03L14.92 7.22L14.22 6.45L13.34 5.77L12.3 5.21L11.1 4.81L9.77 4.6L8.34 4.64L6.86 4.94L5.36 5.52L3.91 6.41L2.57 7.6" />
      <path d="M7.68 13.57L7.88 14.35L8.15 15.15L8.54 15.97L9.08 16.78L9.78 17.55L10.66 18.23L11.7 18.79L12.9 19.19L14.23 19.4L15.66 19.36L17.14 19.06L18.64 18.48L20.09 17.59L21.43 16.4" />
    </svg>
  );
}
