import Image from "next/image";
import Link from "next/link";

type BrandMarkProps = {
  href?: string | null;
  /** compact = sidebar-sized; default = LP/auth headers */
  size?: "sm" | "md";
  className?: string;
  /** show Sealith as subtitle under Staffpass */
  showSealithSubtitle?: boolean;
};

export function BrandMark({
  href = "/",
  size = "md",
  className = "",
  showSealithSubtitle = true,
}: BrandMarkProps) {
  const markPx = size === "sm" ? 28 : 36;
  const titleClass =
    size === "sm"
      ? "text-[15px] font-semibold tracking-tight leading-none"
      : "text-[17px] font-semibold tracking-tight leading-none";
  const subClass =
    size === "sm"
      ? "text-[10px] faint tracking-wide mt-1 leading-none"
      : "text-[11px] faint tracking-wide mt-1.5 leading-none";

  const content = (
    <span className={`inline-flex items-center gap-2.5 text-[var(--text)] ${className}`}>
      <Image
        src="/brand/staffpass-mark-dark-v2.png"
        alt=""
        width={markPx}
        height={markPx}
        className="shrink-0 object-contain"
        priority
      />
      <span className="flex flex-col min-w-0">
        <span className={titleClass}>Staffpass</span>
        {showSealithSubtitle ? (
          <span className={subClass}>Sealith</span>
        ) : null}
      </span>
    </span>
  );

  if (href === null) return content;
  return (
    <Link href={href} className="inline-flex items-center hover:opacity-95 transition-opacity" aria-label="Staffpass ホーム">
      {content}
    </Link>
  );
}
