import type { CustodyStatus } from '@/types'

const STYLES: Record<CustodyStatus, string> = {
  在库: 'bg-emerald-50 text-emerald-700 border-emerald-300',
  外借中: 'bg-violet-50 text-violet-700 border-violet-300',
  待归位: 'bg-amber-50 text-amber-700 border-amber-300'
}

const DOTS: Record<CustodyStatus, string> = {
  在库: 'bg-emerald-500',
  外借中: 'bg-violet-500',
  待归位: 'bg-amber-500'
}

export interface CustodyTagProps {
  status: CustodyStatus
  /** 外借已超过应还期限时显示「逾期」 */
  overdue?: boolean
  withDot?: boolean
  className?: string
}

/** 保管状态标签：在库 / 外借中（可标逾期）/ 待归位，三处页面同一配色同一口径 */
export default function CustodyTag({ status, overdue = false, withDot = true, className = '' }: CustodyTagProps): JSX.Element {
  return (
    <span
      data-testid="custody-tag"
      className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-xs leading-5 ${STYLES[status]} ${className}`}
    >
      {withDot ? <i className={`h-1.5 w-1.5 rounded-full ${DOTS[status]}`} /> : null}
      {status}
      {status === '外借中' && overdue ? '·逾期' : ''}
    </span>
  )
}
