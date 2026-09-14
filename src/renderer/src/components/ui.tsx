import { AnimatePresence, motion } from 'framer-motion'
import { Loader2, X, type LucideIcon } from 'lucide-react'
import {
  forwardRef,
  type ButtonHTMLAttributes,
  type InputHTMLAttributes,
  type ReactNode,
  type SelectHTMLAttributes
} from 'react'

// ---------------- Button ----------------

type BtnVariant = 'primary' | 'soft' | 'ghost' | 'danger' | 'outline'

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: BtnVariant
  size?: 'sm' | 'md'
  icon?: LucideIcon
  loading?: boolean
}

const btnVariants: Record<BtnVariant, string> = {
  primary: 'bg-accent text-white hover:brightness-110 shadow-sm shadow-accent/30',
  soft: 'bg-accent-soft text-accent hover:bg-accent/20',
  ghost: 'bg-transparent text-dim hover:bg-elev2 hover:text-text',
  danger: 'bg-danger/12 text-danger hover:bg-danger/20',
  outline: 'border border-border text-dim hover:bg-elev2 hover:text-text bg-transparent'
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = 'primary', size = 'md', icon: Icon, loading, className = '', children, disabled, ...rest },
  ref
) {
  return (
    <motion.button
      ref={ref}
      whileTap={{ scale: 0.97 }}
      disabled={disabled || loading}
      className={`inline-flex items-center justify-center gap-1.5 rounded-lg font-medium transition-colors disabled:opacity-50 disabled:pointer-events-none ${
        size === 'sm' ? 'h-7 px-2.5 text-xs' : 'h-9 px-3.5 text-sm'
      } ${btnVariants[variant]} ${className}`}
      {...(rest as object)}
    >
      {loading ? <Loader2 size={size === 'sm' ? 12 : 15} className="animate-spin" /> : Icon ? <Icon size={size === 'sm' ? 13 : 15} /> : null}
      {children}
    </motion.button>
  )
})

// ---------------- IconButton ----------------

export interface IconButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  title?: string
  active?: boolean
}

export function IconButton({ title, active, className = '', children, ...rest }: IconButtonProps) {
  return (
    <motion.button
      whileTap={{ scale: 0.92 }}
      title={title}
      className={`inline-flex h-8 w-8 items-center justify-center rounded-lg text-dim transition-colors hover:bg-elev2 hover:text-text disabled:opacity-40 disabled:pointer-events-none ${
        active ? 'bg-accent-soft text-accent' : ''
      } ${className}`}
      {...(rest as object)}
    >
      {children}
    </motion.button>
  )
}

// ---------------- Badge ----------------

export type BadgeTone = 'neutral' | 'accent' | 'ok' | 'warn' | 'danger'

const badgeTones: Record<BadgeTone, string> = {
  neutral: 'bg-elev2 text-dim',
  accent: 'bg-accent-soft text-accent',
  ok: 'bg-ok/15 text-ok',
  warn: 'bg-warn/15 text-warn',
  danger: 'bg-danger/15 text-danger'
}

export function Badge({ tone = 'neutral', className = '', children }: { tone?: BadgeTone; className?: string; children: ReactNode }) {
  return (
    <span className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-medium ${badgeTones[tone]} ${className}`}>
      {children}
    </span>
  )
}

// ---------------- Input / Select ----------------

export const Input = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement>>(
  function Input({ className = '', ...rest }, ref) {
    return (
      <input
        ref={ref}
        className={`h-9 w-full rounded-lg border border-border bg-elev1 px-3 text-sm text-text outline-none transition-colors placeholder:text-faint focus:border-accent ${className}`}
        {...rest}
      />
    )
  }
)

export function Select({
  className = '',
  ...rest
}: SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <select
      className={`h-9 rounded-lg border border-border bg-elev1 px-2.5 text-sm text-text outline-none transition-colors focus:border-accent ${className}`}
      {...rest}
    />
  )
}

export function Textarea({ className = '', ...rest }: React.TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return (
    <textarea
      className={`w-full rounded-lg border border-border bg-elev1 px-3 py-2 text-sm text-text outline-none transition-colors placeholder:text-faint focus:border-accent ${className}`}
      {...rest}
    />
  )
}

// ---------------- Switch ----------------

export function Switch({ checked, onChange, disabled }: { checked: boolean; onChange: (v: boolean) => void; disabled?: boolean }) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={`relative h-5 w-9 rounded-full transition-colors disabled:opacity-40 ${checked ? 'bg-accent' : 'bg-elev3'}`}
    >
      <motion.span
        layout
        className={`absolute top-0.5 h-4 w-4 rounded-full bg-white shadow ${checked ? 'left-[18px]' : 'left-0.5'}`}
      />
    </button>
  )
}

// ---------------- Modal ----------------

export function Modal({
  open,
  onClose,
  title,
  children,
  width = 520
}: {
  open: boolean
  onClose: () => void
  title: ReactNode
  children: ReactNode
  width?: number
}) {
  return (
    <AnimatePresence>
      {open && (
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          className="fixed inset-0 z-[80] flex items-center justify-center bg-black/45 backdrop-blur-sm"
          onMouseDown={(e) => {
            if (e.target === e.currentTarget) onClose()
          }}
        >
          <motion.div
            initial={{ opacity: 0, scale: 0.94, y: 12 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.96, y: 8 }}
            transition={{ type: 'spring', duration: 0.32 }}
            className="flex max-h-[86vh] w-full flex-col overflow-hidden rounded-2xl border border-border bg-elev1 shadow-2xl"
            style={{ maxWidth: width }}
          >
            <div className="flex items-center justify-between border-b border-border px-5 py-3.5">
              <div className="text-sm font-semibold">{title}</div>
              <IconButton onClick={onClose} title="关闭">
                <X size={15} />
              </IconButton>
            </div>
            <div className="flex-1 overflow-y-auto p-5">{children}</div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  )
}

// ---------------- ConfirmModal ----------------

export function ConfirmModal({
  open,
  title,
  message,
  confirmText = '确认',
  danger = false,
  onConfirm,
  onClose
}: {
  open: boolean
  title: string
  message: ReactNode
  confirmText?: string
  danger?: boolean
  onConfirm: () => void
  onClose: () => void
}) {
  return (
    <Modal open={open} onClose={onClose} title={title} width={420}>
      <div className="text-sm leading-relaxed text-dim">{message}</div>
      <div className="mt-5 flex justify-end gap-2">
        <Button variant="ghost" onClick={onClose}>
          取消
        </Button>
        <Button
          variant={danger ? 'danger' : 'primary'}
          onClick={() => {
            onConfirm()
            onClose()
          }}
        >
          {confirmText}
        </Button>
      </div>
    </Modal>
  )
}

// ---------------- EmptyState ----------------

export function EmptyState({
  icon: Icon,
  title,
  desc,
  children
}: {
  icon: LucideIcon
  title: string
  desc?: string
  children?: ReactNode
}) {
  return (
    <div className="flex flex-col items-center justify-center gap-2 py-14 text-center">
      <div className="flex h-14 w-14 items-center justify-center rounded-2xl bg-elev2 text-faint">
        <Icon size={24} />
      </div>
      <div className="text-sm font-medium">{title}</div>
      {desc ? <div className="max-w-sm text-xs leading-relaxed text-faint">{desc}</div> : null}
      {children ? <div className="mt-2">{children}</div> : null}
    </div>
  )
}

// ---------------- Spinner ----------------

export function Spinner({ size = 18 }: { size?: number }) {
  return <Loader2 size={size} className="animate-spin text-accent" />
}

// ---------------- ProgressBar ----------------

export function ProgressBar({ value, className = '' }: { value: number; className?: string }) {
  const v = Math.max(0, Math.min(100, value))
  return (
    <div className={`h-1.5 w-full overflow-hidden rounded-full bg-elev3 ${className}`}>
      <motion.div
        className="h-full rounded-full bg-accent"
        initial={false}
        animate={{ width: `${v}%` }}
        transition={{ duration: 0.4 }}
      />
    </div>
  )
}

// ---------------- SectionTitle ----------------

export function SectionTitle({ icon: Icon, title, desc, extra }: { icon?: LucideIcon; title: string; desc?: string; extra?: ReactNode }) {
  return (
    <div className="mb-3 flex items-end justify-between">
      <div>
        <h2 className="flex items-center gap-2 text-base font-semibold">
          {Icon ? <Icon size={17} className="text-accent" /> : null}
          {title}
        </h2>
        {desc ? <p className="mt-0.5 text-xs text-faint">{desc}</p> : null}
      </div>
      {extra}
    </div>
  )
}
