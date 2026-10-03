import type { StorageMethod } from './storage'

/** 保管状态（由借还记录派生，不在标本表上落字段） */
export const CUSTODY_STATUSES = ['在库', '外借中', '待归位'] as const
export type CustodyStatus = (typeof CUSTODY_STATUSES)[number]

/** Loan 借还记录：一条记录对应一次借出/归还 */
export interface Loan {
  id: string
  specimenId: string
  /** 借用人 / 借入单位 */
  borrower: string
  /** 借出日期 */
  loanDate: string
  /** 应还期限 */
  dueDate: string
  /** 实际归还日期；空串表示仍在外借中 */
  returnedDate: string
  /** 经手人（借出登记人，归还时可覆盖） */
  handler: string
  note: string
  /** 借出时原柜位快照；借出时未入柜则 originCabinet 为空串 */
  originMethod: StorageMethod | ''
  originCabinet: string
  originDrawer: number
  originBox: number
  originSlot: number
  /** 归还时原柜位已被占用、暂存待归位区；重新入柜后置回 false */
  awaitingSlot: boolean
}
