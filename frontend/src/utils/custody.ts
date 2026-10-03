import type { CustodyStatus, Loan, LoanState, Specimen, Storage } from '@/types'

/** 尚在流程中的借还状态：标本不在柜、库位被释放 */
export function isActiveLoanState(state: LoanState): boolean {
  return state === '外借中' || state === '待归位'
}

/** 判断借还记录是否仍占着流程（外借中 / 待归位） */
export function isActiveLoan(loan: Loan): boolean {
  return isActiveLoanState(loan.state)
}

/** 外借记录确定性 ID：同一批次重试写入会覆盖同一记录，不会多出记录 */
export function loanRecordId(batchId: string, specimenId: string): string {
  return `${batchId}__${specimenId}`
}

/** 以 specimenId 为键的借还流程索引（外借中优先于待归位，正常每标本至多一条） */
export function activeLoanMap(loans: Loan[]): Map<string, Loan> {
  const map = new Map<string, Loan>()
  loans.filter(isActiveLoan).forEach((loan) => {
    const prev = map.get(loan.specimenId)
    if (!prev || (prev.state === '待归位' && loan.state === '外借中')) {
      map.set(loan.specimenId, loan)
    }
  })
  return map
}

/** 以 specimenId 为键的在柜记录索引 */
export function storageMapBySpecimen(storages: Storage[]): Map<string, Storage> {
  const map = new Map<string, Storage>()
  storages.forEach((storage) => {
    if (!map.has(storage.specimenId)) map.set(storage.specimenId, storage)
  })
  return map
}

/**
 * 统一保管状态口径（柜位图 / 标本清单 / 鉴定页共用）：
 * - 在库：有柜位且无进行中的借还；
 * - 外借中 / 待归位：有进行中的借还记录；
 * - 未入柜：无柜位、也无进行中的借还。
 * 旧数据升级后没有任何借还记录，天然按「在库 / 未入柜」兼容处理。
 */
export function custodyStatusOf(
  specimen: Specimen,
  storageBySpecimen: Map<string, Storage>,
  activeBySpecimen: Map<string, Loan>
): CustodyStatus {
  const loan = activeBySpecimen.get(specimen.id)
  if (loan) return loan.state === '外借中' ? '外借中' : '待归位'
  return storageBySpecimen.has(specimen.id) ? '在库' : '未入柜'
}

export interface CustodyBundle {
  storageBySpecimen: Map<string, Storage>
  activeBySpecimen: Map<string, Loan>
  /** 直接按标本 ID 取保管状态 */
  statusOf: Map<string, CustodyStatus>
}

/** 一次构造，供整页复用 */
export function buildCustodyBundle(specimens: Specimen[], storages: Storage[], loans: Loan[]): CustodyBundle {
  const storageBySpecimen = storageMapBySpecimen(storages)
  const activeBySpecimen = activeLoanMap(loans)
  const statusOf = new Map<string, CustodyStatus>()
  specimens.forEach((specimen) => {
    statusOf.set(specimen.id, custodyStatusOf(specimen, storageBySpecimen, activeBySpecimen))
  })
  return { storageBySpecimen, activeBySpecimen, statusOf }
}

/** 日期加天数，返回 YYYY-MM-DD */
export function addDays(dateText: string, days: number): string {
  const date = new Date(`${dateText}T00:00:00`)
  date.setDate(date.getDate() + days)
  return date.toISOString().slice(0, 10)
}
