import type { ReactNode } from 'react'

export interface RingSegment {
  value: number
  color: string
  label: string
}

/** 百分比圆环图（方案 3.2：仪表盘统计，SVG 分段圆环） */
export function Ring({
  segments,
  size = 168,
  thickness = 18,
  center
}: {
  segments: RingSegment[]
  size?: number
  thickness?: number
  center?: ReactNode
}) {
  const total = segments.reduce((s, x) => s + x.value, 0)
  const r = (size - thickness) / 2
  const c = 2 * Math.PI * r
  let startFrac = 0

  return (
    <div className="relative" style={{ width: size, height: size }}>
      <svg width={size} height={size} className="-rotate-90">
        <circle
          cx={size / 2}
          cy={size / 2}
          r={r}
          fill="none"
          stroke="var(--elev3)"
          strokeWidth={thickness}
        />
        {total > 0 &&
          segments.map((seg, i) => {
            const frac = seg.value / total
            const dash = Math.max(0, frac * c - 2.5)
            const offset = -startFrac * c
            startFrac += frac
            return (
              <circle
                key={i}
                cx={size / 2}
                cy={size / 2}
                r={r}
                fill="none"
                stroke={seg.color}
                strokeWidth={thickness}
                strokeLinecap="round"
                strokeDasharray={`${dash} ${c - dash}`}
                strokeDashoffset={offset}
                style={{ transition: 'stroke-dasharray 0.6s ease, stroke-dashoffset 0.6s ease' }}
              />
            )
          })}
      </svg>
      {center ? (
        <div className="absolute inset-0 flex flex-col items-center justify-center">{center}</div>
      ) : null}
    </div>
  )
}
