import type { CustodyStatus, Loan } from '@/types'
import type { Storage } from '@/types'
import { storageSlotText } from './codec'

/** 取一份标本最新的一条借还记录（无记录返回 undefined） */
export function latestLoanOf(loans: Loan[], specimenId: string): Loan | undefined {
  let result: Loan | undefined
  for (const loan of loans) {
    if (loan.specimenId !== specimenId) continue
    if (!result || loan.loanDate + loan.id > result.loanDate + result.id) {
      result = loan
    }
  }
  return result
}

/**
 * 统一保管状态口径（柜位图 / 标本清单 / 鉴定页共用）：
 * - 最新借据未归还：外借中
 * - 已归还但 awaitingSlot：待归位
 * - 其余（含无任何借还记录的旧数据标本）：在库
 */
export function custodyOf(loans: Loan[], specimenId: string): CustodyStatus {
  const loan = latestLoanOf(loans, specimenId)
  if (!loan) return '在库'
  if (!loan.returnedDate) return '外借中'
  return loan.awaitingSlot ? '待归位' : '在库'
}

/** 外借是否已超过应还期限 */
export function isOverdue(loan: Loan, today = new Date().toISOString().slice(0, 10)): boolean {
  return !loan.returnedDate && loan.dueDate < today
}

/** 借据快照中的原柜位编码；借出时未入柜返回空串 */
export function loanOriginText(loan: Loan): string {
  if (!loan.originCabinet) return ''
  return storageSlotText({
    cabinet: loan.originCabinet,
    drawer: loan.originDrawer,
    box: loan.originBox,
    slot: loan.originSlot
  } as Storage)
}

/** 待归位标本的原柜位当前是否已被别的标本占用（空着即可放回） */
export function originSlotTaken(loan: Loan, storages: Storage[]): boolean {
  if (!loan.originCabinet) return false
  const key = loanOriginText(loan)
  return storages.some((item) => item.specimenId !== loan.specimenId && storageSlotText(item) === key)
}
