"use client";

type LogoProps = {
  /** "orbit" 方案A：轨道环绕书本；"wave" 方案B：书本 + 海浪 */
  variant?: "orbit" | "wave";
  size?: number;
  /** 是否开启动效（轨道旋转/翻页/腾飞/海浪起伏） */
  animated?: boolean;
  color?: string;
  accent?: string;
  className?: string;
};

/**
 * 校园AI助手 Logo
 * - orbit（主标）：椭圆轨道 + 翻开的书本，呼应中科大校徽「轨道」意象
 * - wave（场景变体）：书本浮于海浪之上，用于开机画面 / 加载态 / 空状态
 */
export function Logo({
  variant = "orbit",
  size = 40,
  animated = false,
  color = "#0046AD",
  accent = "#3B82F6",
  className,
}: LogoProps) {
  if (variant === "wave") {
    return (
      <svg
        viewBox="0 0 64 64"
        width={size}
        height={size}
        fill="none"
        className={className}
        xmlns="http://www.w3.org/2000/svg"
      >
        <g className={animated ? "logo-float" : undefined}>
          <path
            d="M32 26 C27 23 22 25 20 28 L20 39 C24 37 28 39 32 42"
            stroke={color}
            strokeWidth="3"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
          <path
            d="M32 26 C37 23 42 25 44 28 L44 39 C40 37 36 39 32 42"
            stroke={color}
            strokeWidth="3"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
          <path d="M32 26 V42" stroke={color} strokeWidth="3" strokeLinecap="round" />
        </g>
        <g className={animated ? "logo-wave" : undefined}>
          <path
            d="M12 50 Q 22 44 32 50 T 52 50"
            stroke={color}
            strokeWidth="2.5"
            strokeLinecap="round"
          />
          <path
            d="M16 56 Q 26 50 36 56 T 52 56"
            stroke={color}
            strokeWidth="2.5"
            strokeLinecap="round"
            opacity="0.45"
          />
        </g>
      </svg>
    );
  }

  return (
    <svg
      viewBox="0 0 64 64"
      width={size}
      height={size}
      fill="none"
      className={className}
      xmlns="http://www.w3.org/2000/svg"
    >
      <g className={animated ? "orbit-spin" : undefined}>
        <ellipse
          cx="32"
          cy="37"
          rx="26"
          ry="11"
          transform="rotate(-16 32 37)"
          stroke={color}
          strokeWidth="3"
          strokeLinecap="round"
        />
        <circle cx="52" cy="29" r="2.5" fill={accent} />
      </g>
      <path
        className={animated ? "page-flip-l" : undefined}
        d="M32 26 C27 23 22 25 20 28 L20 39 C24 37 28 39 32 42"
        stroke={color}
        strokeWidth="3"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        className={animated ? "page-flip-r" : undefined}
        d="M32 26 C37 23 42 25 44 28 L44 39 C40 37 36 39 32 42"
        stroke={color}
        strokeWidth="3"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path d="M32 26 V42" stroke={color} strokeWidth="3" strokeLinecap="round" />
    </svg>
  );
}
