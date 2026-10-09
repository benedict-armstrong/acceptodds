/**
 * The hexagon-and-arrows mark. The arrows are cut out of the hexagon, so
 * they show whatever is behind it; the hexagon takes `currentColor`.
 */
export function LogoMark({ size = 22 }: { size?: number }) {
  return (
    <svg
      viewBox="-87 -100 174 200"
      width={(size * 174) / 200}
      height={size}
      aria-hidden="true"
      className="inline align-[-3px] text-accent"
    >
      <path
        fill="currentColor"
        fillRule="evenodd"
        d="M0 -100L86.6 -50L86.6 50L0 100L-86.6 50L-86.6 -50ZM34.5 -59.8L48.4 -7.8L30.2 -18.3L-0.8 35.3L17.4 45.8L-34.5 59.8L-48.4 7.8L-30.2 18.3L0.8 -35.3L-17.4 -45.8Z"
      />
    </svg>
  );
}
