/** 借还记录生命周期 */
export const LOAN_STATES = ['外借中', '待归位', '已归位'] as const
export type LoanState = (typeof LOAN_STATES)[number]

/** Loan 外借记录（一次外借一份标本一条记录，整批外借共用 batchId） */
export interface Loan {
  /** 由批次号与标本 ID 派生的确定性 ID：`${batchId}__${specimenId}`，保证重试不产生重复记录 */
  id: string
  /** 同批外借的批次号 */
  batchId: string
  specimenId: string
  borrower: string
  /** 借出日期 */
  loanDate: string
  /** 应还期限 */
  dueDate: string
  /** 经手人 */
  handler: string
  state: LoanState
  /** 借出时的原柜位快照 */
  originCabinet: string
  originDrawer: number
  originBox: number
  originSlot: number
  originMethod: string
  /** 归还登记日期（state 进入 待归位 / 已归位 时写入） */
  returnedDate: string
  /** 实际归位柜位；放回原柜时与原柜位一致，改放新柜位后记录新位置 */
  placedCabinet: string
  placedDrawer: number
  placedBox: number
  placedSlot: number
}

/** 保管状态：柜位图、标本清单与鉴定页统一展示 */
export const CUSTODY_STATUSES = ['在库', '外借中', '待归位', '未入柜'] as const
export type CustodyStatus = (typeof CUSTODY_STATUSES)[number]
