import Image from "next/image";
import type { CSSProperties } from "react";

const PALETTES = [
  { from: "#30d9ff", to: "#137eeb", glow: "rgba(48, 217, 255, .44)" },
  { from: "#9d7bff", to: "#5b55d6", glow: "rgba(157, 123, 255, .42)" },
  { from: "#ff8a68", to: "#d64d7a", glow: "rgba(255, 138, 104, .4)" },
  { from: "#a7db55", to: "#3c9b68", glow: "rgba(167, 219, 85, .38)" },
  { from: "#ffc85a", to: "#dc7440", glow: "rgba(255, 200, 90, .4)" },
  { from: "#56a6ff", to: "#3460c9", glow: "rgba(86, 166, 255, .42)" },
] as const;

const SHAPES: CSSProperties[] = [
  { borderRadius: "46% 54% 48% 52% / 52% 45% 55% 48%" },
  { borderRadius: "31% 31% 44% 44% / 26% 26% 53% 53%" },
  { borderRadius: "50% 50% 35% 35% / 38% 38% 58% 58%" },
  { borderRadius: "28% 46% 28% 46% / 42% 30% 42% 30%" },
] as const;

function stableHash(value: string) {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

export function EmployeeAvatar({
  seed,
  size = 64,
  className = "",
}: {
  seed: string;
  size?: number;
  className?: string;
}) {
  const hash = stableHash(seed);
  const palette = PALETTES[hash % PALETTES.length];
  const shapeIndex = Math.floor(hash / PALETTES.length) % SHAPES.length;
  const dotPosition = Math.floor(hash / (PALETTES.length * SHAPES.length)) % 4;
  const dotStyles: CSSProperties[] = [
    { left: "10%", top: "19%" },
    { right: "9%", top: "26%" },
    { right: "13%", bottom: "13%" },
    { left: "9%", bottom: "22%" },
  ];

  return (
    <span
      role="img"
      aria-label="オリジナルAIクルーアバター"
      className={`relative inline-grid shrink-0 place-items-center overflow-hidden border border-white/20 shadow-[inset_0_1px_0_rgba(255,255,255,.28)] ${className}`}
      style={{
        width: size,
        height: size,
        background: `linear-gradient(145deg, ${palette.from}, ${palette.to})`,
        boxShadow: `inset 0 1px 0 rgba(255,255,255,.28), 0 8px 24px ${palette.glow}`,
        ...SHAPES[shapeIndex],
      }}
      data-avatar-variant={`${shapeIndex + 1}-${(hash % PALETTES.length) + 1}`}
    >
      <span className="absolute inset-[7%] rounded-[inherit] border border-black/10 bg-[radial-gradient(circle_at_32%_16%,rgba(255,255,255,.34),transparent_38%)]" />
      <Image
        src="/brand/ai-employee-pebble-core.png"
        alt=""
        width={size}
        height={size}
        sizes={`${size}px`}
        className="relative z-[1] h-[92%] w-[92%] translate-y-[3%] object-contain drop-shadow-[0_3px_5px_rgba(3,8,16,.28)]"
      />
      <span
        className="absolute z-[2] h-[8%] w-[8%] rounded-full border border-white/50 bg-white/70 shadow-[0_0_8px_rgba(255,255,255,.65)]"
        style={dotStyles[dotPosition]}
      />
      {shapeIndex === 1 ? (
        <>
          <span className="absolute -left-[3%] top-[34%] h-[20%] w-[12%] rotate-[-18deg] rounded-full bg-[color-mix(in_oklab,var(--bg)_45%,transparent)]" />
          <span className="absolute -right-[3%] top-[34%] h-[20%] w-[12%] rotate-[18deg] rounded-full bg-[color-mix(in_oklab,var(--bg)_45%,transparent)]" />
        </>
      ) : null}
      {shapeIndex === 2 ? (
        <span className="absolute left-1/2 top-[2%] h-[8%] w-[30%] -translate-x-1/2 rounded-full bg-white/24" />
      ) : null}
    </span>
  );
}
