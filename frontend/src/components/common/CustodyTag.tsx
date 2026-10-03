import type { CustodyStatus } from '@/types'

const STYLES: Record<CustodyStatus, string> = {
  在库: 'bg-emerald-50 text-emerald-700 border-emerald-300',
  外借中: 'bg-orange-50 text-orange-700 border-orange-300',
  待归位: 'bg-amber-50 text-amber-800 border-amber-300',
  未入柜: 'bg-slate-100 text-slate-500 border-slate-300'
}

const DOTS: Record<CustodyStatus, string> = {
  在库: 'bg-emerald-500',
  外借中: 'bg-orange-500',
  待归位: 'bg-amber-500',
  未入柜: 'bg-slate-400'
}

export interface CustodyTagProps {
  status: CustodyStatus
  withDot?: boolean
  className?: string
}

/** 保管状态标签：柜位图 / 标本清单 / 鉴定页共用同一口径 */
export default function CustodyTag({ status, withDot = true, className = '' }: CustodyTagProps): JSX.Element {
  return (
    <span
      data-testid="custody-tag"
      className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-xs leading-5 ${STYLES[status]} ${className}`}
    >
      {withDot ? <i className={`h-1.5 w-1.5 rounded-full ${DOTS[status]}`} /> : null}
      {status}
    </span>
  )
}
