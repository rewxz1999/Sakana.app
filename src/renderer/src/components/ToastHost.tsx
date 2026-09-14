import { AnimatePresence, motion } from 'framer-motion'
import { CircleAlert, CircleCheck, Info, TriangleAlert, X } from 'lucide-react'
import { useToast } from '@/stores/app'

const KIND_ICON = {
  info: <Info size={14} className="text-accent" />,
  success: <CircleCheck size={14} className="text-ok" />,
  error: <CircleAlert size={14} className="text-danger" />,
  warn: <TriangleAlert size={14} className="text-warn" />
}

export function ToastHost() {
  const { toasts, dismiss } = useToast()
  return (
    <div className="pointer-events-none fixed bottom-5 right-5 z-[99] flex w-80 flex-col gap-2">
      <AnimatePresence>
        {toasts.map((t) => (
          <motion.div
            key={t.id}
            initial={{ opacity: 0, x: 40, scale: 0.95 }}
            animate={{ opacity: 1, x: 0, scale: 1 }}
            exit={{ opacity: 0, x: 24, scale: 0.95 }}
            className="pointer-events-auto flex items-start gap-2.5 rounded-xl border border-border bg-elev1/95 px-3.5 py-2.5 shadow-lg backdrop-blur"
          >
            <span className="mt-0.5 shrink-0">{KIND_ICON[t.kind]}</span>
            <span className="flex-1 text-[13px] leading-snug">{t.text}</span>
            <button className="text-faint hover:text-text" onClick={() => dismiss(t.id)}>
              <X size={13} />
            </button>
          </motion.div>
        ))}
      </AnimatePresence>
    </div>
  )
}
