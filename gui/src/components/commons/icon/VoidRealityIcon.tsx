export function VoidRealityIcon({ drag }: { drag?: boolean }) {
  // follows the theme text color so it stays visible on light themes
  const color = 'rgb(var(--default-color))';
  return (
    <svg
      width="29"
      height="29"
      viewBox="0 0 29 29"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      data-electron-drag-region={drag}
    >
      <circle
        cx="14.5"
        cy="14.5"
        r="11"
        style={{ stroke: color }}
        strokeWidth="3"
        strokeLinecap="round"
        strokeDasharray="48 21"
      />
      <circle cx="14.5" cy="14.5" r="4.5" style={{ fill: color }} />
    </svg>
  );
}
