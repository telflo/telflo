/*
 * The Dynatrace signet, for the OTLP/HTTP exporter's "Dynatrace" quick
 * setup.
 *
 * Source: the npm package `@dynatrace/strato-icons` 2.6.1, its
 * `DynatraceSignetIcon` (`__icons/DynatraceSignetIcon.js`, viewBox
 * 0 0 20 20, fill `currentColor`), from the tarball
 * https://registry.npmjs.org/@dynatrace/strato-icons/-/strato-icons-2.6.1.tgz
 * (sha512-gJWByoJQ7QXxpeduLgLQEvOqUfR2HaM7S+41PGSKDbXJce4UI/D+glM2/LlYYZa1O4AVRvr41XGfOI1j6brJuw==).
 * The four paths' data is the package's exactly. License: Apache-2.0 (the
 * package's LICENSE). Dynatrace is a trademark of Dynatrace LLC; the mark
 * names the backend the quick setup pre-fills. Listed in
 * docs/third-party-assets.md.
 *
 * Monochrome in the surrounding text color; decorative, so hidden from
 * assistive technology (the option's text names the backend).
 */
export function DynatraceIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 20 20" xmlns="http://www.w3.org/2000/svg" className={className} fill="currentColor" aria-hidden="true">
      <path d="M3 8.429a53 53 0 0 0 .12 3.084 56 56 0 0 0 .42 4.024l3.588-3.373s-.134-1.69.08-4.209c0 0-3.975-.473-4.208.474" />
      <path d="M11.275 16.978c.931-.264.659-4.117.659-4.117-2.563.085-4.26-.125-4.26-.125l-3.595 3.367s1.904.368 4.047.611a74 74 0 0 0 3.082.264c.027.006.053 0 .066 0" />
      <path d="M3 8.212v.217c.04-.171.107-.296.253-.474.293-.368.773-.467.966-.493A40 40 0 0 1 8.073 7.14c2.563-.08 4.253.131 4.253.131l3.588-3.373S14.03 3.543 11.88 3.293a58 58 0 0 0-3.335-.29C8.5 3.003 8 2.938 7.534 3.378 7.02 3.858 4.452 6.265 3.42 7.238 2.967 7.672 3 8.166 3 8.212" />
      <path d="M11.461 16.997c-.067-.006-.14-.006-.22-.013.18-.033.3-.092.493-.224.386-.276.512-.736.546-.927a41 41 0 0 0 .519-3.788c.206-2.525.073-4.202.073-4.202L16.46 4.47s.266 1.874.413 4.005a60 60 0 0 1 .126 3.3c0 .047.04.54-.426.98-.512.48-3.075 2.9-4.107 3.874-.46.427-.958.368-1.005.368" />
    </svg>
  );
}
