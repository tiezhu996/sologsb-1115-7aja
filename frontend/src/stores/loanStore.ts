import { create } from 'zustand'
import type { Loan, Storage } from '@/types'
import { db, loadAll } from '@/hooks/usePersistentStore'
import { isActiveLoanState, loanRecordId } from '@/utils/custody'

/** 业务前置条件不满足（不是写入故障）：直接提示，不需要恢复 */
export class LoanValidationError extends Error {}

export interface CheckoutInput {
  /** 同批外借共用的批次号（页面在首次确认时生成，重试沿用） */
  batchId: string
  specimenIds: string[]
  borrower: string
  loanDate: string
  dueDate: string
  handler: string
  /** 标本 ID → 编号，用于错误提示 */
  labelOf?: (specimenId: string) => string
}

export interface ReturnInput {
  loanIds: string[]
  returnedDate: string
  /** 借还记录 → 展示名（标本编号），用于错误提示 */
  labelOf?: (loan: Loan) => string
}

export interface ReshelveInput {
  loanId: string
  storageId: string
  method: Storage['method']
  cabinet: string
  drawer: number
  box: number
  slot: number
  storedDate: string
  handler: string
}

export interface LoanStateStore {
  rows: Loan[]
  loaded: boolean
  hydrate: () => Promise<void>
  /** 整批外借：校验全部在库 → 同事务删除柜位记录、写借还记录（确定性 ID 幂等） */
  checkout: (input: CheckoutInput) => Promise<Loan[]>
  /** 整批归还：原柜位空着就放回并置「已归位」，被占用则进「待归位」并保留原柜位 */
  returnLoans: (input: ReturnInput) => Promise<{ restored: number; pending: number; loans: Loan[] }>
  /** 待归位标本手动归位：放回原柜或改放新柜位；原柜被占时拒绝，不挤掉现有标本 */
  reshelve: (input: ReshelveInput) => Promise<Loan>
}

interface RestoreSnapshot {
  storageIds: string[]
  loanIds: string[]
  /** 操作前受影响记录的完整快照（含不存在键 => undefined） */
  storages: Map<string, Storage | undefined>
  loans: Map<string, Loan | undefined>
}

const emptySlot = (): Pick<Loan, 'placedCabinet' | 'placedDrawer' | 'placedBox' | 'placedSlot'> => ({
  placedCabinet: '',
  placedDrawer: 0,
  placedBox: 0,
  placedSlot: 0
})

export const loanStore = create<LoanStateStore>((set) => ({
  rows: [],
  loaded: false,

  hydrate: async () => {
    const rows = await loadAll<Loan>(db.loans)
    rows.sort((a, b) => (b.loanDate + b.batchId).localeCompare(a.loanDate + a.batchId))
    set({ rows, loaded: true })
  },

  checkout: async (input) => {
    const specimenIds = Array.from(new Set(input.specimenIds))
    if (specimenIds.length === 0) throw new LoanValidationError('请先勾选要外借的标本')
    if (!input.borrower.trim()) throw new LoanValidationError('请填写借用人 / 借用单位')
    if (!input.loanDate) throw new LoanValidationError('请填写借出日期')
    if (!input.dueDate) throw new LoanValidationError('请填写归还期限')
    if (input.dueDate < input.loanDate) throw new LoanValidationError('归还期限不能早于借出日期')

    const beforeStorages = await db.storages.where('specimenId').anyOf(specimenIds).toArray()
    const storageBySpecimen = new Map<string, Storage>()
    beforeStorages.forEach((storage) => {
      if (storage) storageBySpecimen.set(storage.specimenId, storage)
    })
    const activeLoans = (await db.loans.where('specimenId').anyOf(specimenIds).toArray()).filter((loan) =>
      isActiveLoanState(loan.state)
    )
    const activeSpecimenIds = new Set(activeLoans.map((loan) => loan.specimenId))
    const notStored: string[] = []
    const notAvailable: string[] = []
    specimenIds.forEach((id) => {
      if (activeSpecimenIds.has(id)) notAvailable.push(id)
      else if (!storageBySpecimen.has(id)) notStored.push(id)
    })
    if (notAvailable.length > 0 || notStored.length > 0) {
      const label = (id: string): string => input.labelOf?.(id) ?? id
      throw new LoanValidationError(
        [
          notStored.length > 0 ? `未在柜中，不能外借：${notStored.map(label).join('、')}` : '',
          notAvailable.length > 0 ? `已在外借流程中，不能重复外借：${notAvailable.map(label).join('、')}` : ''
        ]
          .filter(Boolean)
          .join('；')
      )
    }

    const loanIds = specimenIds.map((id) => loanRecordId(input.batchId, id))
    const storageIds = specimenIds.map((id) => storageBySpecimen.get(id)!.id)

    const records: Loan[] = specimenIds.map((specimenId) => {
      const origin = storageBySpecimen.get(specimenId)!
      return {
        id: loanRecordId(input.batchId, specimenId),
        batchId: input.batchId,
        specimenId,
        borrower: input.borrower.trim(),
        loanDate: input.loanDate,
        dueDate: input.dueDate,
        handler: input.handler.trim(),
        state: '外借中',
        originCabinet: origin.cabinet,
        originDrawer: origin.drawer,
        originBox: origin.box,
        originSlot: origin.slot,
        originMethod: origin.method,
        returnedDate: '',
        ...emptySlot()
      }
    })

    await withRestore({ storageIds, loanIds }, async () => {
      await db.transaction('rw', db.storages, db.loans, async () => {
        await db.storages.bulkDelete(storageIds)
        // put + 确定性 ID：整批失败重试时覆盖同一批记录，不会多出借还记录
        await db.loans.bulkPut(records)
      })
    })
    await loanStore.getState().hydrate()
    return records
  },

  returnLoans: async (input) => {
    const loanIds = Array.from(new Set(input.loanIds))
    if (loanIds.length === 0) throw new LoanValidationError('请先勾选要归还的外借记录')
    if (!input.returnedDate) throw new LoanValidationError('请填写归还日期')

    const loans = (await db.loans.bulkGet(loanIds)).filter((loan): loan is Loan => Boolean(loan))
    const invalid = loans.filter((loan) => loan.state !== '外借中')
    if (invalid.length > 0) {
      throw new LoanValidationError(
        `只有「外借中」的记录可以登记归还，跳过：${invalid.map((loan) => input.labelOf?.(loan) ?? loan.id).join('、')}`
      )
    }

    // 原柜位是否仍空着：同柜屉盒位无在柜记录才算空
    const allStorages = await db.storages.toArray()
    const occupiedSlots = new Set(
      allStorages.map((storage) => `${storage.cabinet.toUpperCase()}-${storage.drawer}-${storage.box}-${storage.slot}`)
    )
    const slotFree = (loan: Loan): boolean =>
      !occupiedSlots.has(`${loan.originCabinet.toUpperCase()}-${loan.originDrawer}-${loan.originBox}-${loan.originSlot}`)

    const updatedLoans: Loan[] = []
    const restoredStorages: Storage[] = []
    loans.forEach((loan) => {
      const free = slotFree(loan)
      updatedLoans.push({
        ...loan,
        state: free ? '已归位' : '待归位',
        returnedDate: input.returnedDate,
        ...(free
          ? {
              placedCabinet: loan.originCabinet,
              placedDrawer: loan.originDrawer,
              placedBox: loan.originBox,
              placedSlot: loan.originSlot
            }
          : emptySlot())
      })
      if (free) {
        restoredStorages.push({
          // 确定性柜位 ID：归还重试时覆盖同一记录，不会多出柜位记录
          id: `stg_rtn_${loan.id}`,
          specimenId: loan.specimenId,
          method: (loan.originMethod as Storage['method']) || '针插',
          cabinet: loan.originCabinet,
          drawer: loan.originDrawer,
          box: loan.originBox,
          slot: loan.originSlot,
          storedDate: input.returnedDate,
          handler: loan.handler
        })
      }
    })
    const storageIds = restoredStorages.map((storage) => storage.id)

    await withRestore({ storageIds, loanIds }, async () => {
      await db.transaction('rw', db.storages, db.loans, async () => {
        await db.storages.bulkPut(restoredStorages)
        await db.loans.bulkPut(updatedLoans)
      })
    })
    await loanStore.getState().hydrate()
    return {
      restored: restoredStorages.length,
      pending: updatedLoans.length - restoredStorages.length,
      loans: updatedLoans
    }
  },

  reshelve: async (input) => {
    if (!input.loanId) throw new LoanValidationError('缺少待归位记录')
    const loan = await db.loans.get(input.loanId)
    if (!loan) throw new LoanValidationError('借还记录不存在')
    if (loan.state !== '待归位') throw new LoanValidationError('只有「待归位」的标本需要归位')
    if (!input.cabinet.trim()) throw new LoanValidationError('请填写标本柜编号')

    const targetKey = `${input.cabinet.toUpperCase()}-${input.drawer}-${input.box}-${input.slot}`
    const occupant = (await db.storages.toArray()).find(
      (storage) =>
        storage.specimenId !== loan.specimenId &&
        `${storage.cabinet.toUpperCase()}-${storage.drawer}-${storage.box}-${storage.slot}` === targetKey
    )
    if (occupant) {
      throw new LoanValidationError('目标柜位已被其他标本占用，不能挤掉现有标本')
    }

    const updatedLoan: Loan = {
      ...loan,
      state: '已归位',
      placedCabinet: input.cabinet,
      placedDrawer: input.drawer,
      placedBox: input.box,
      placedSlot: input.slot
    }
    const storage: Storage = {
      id: input.storageId,
      specimenId: loan.specimenId,
      method: input.method,
      cabinet: input.cabinet,
      drawer: input.drawer,
      box: input.box,
      slot: input.slot,
      storedDate: input.storedDate,
      handler: input.handler
    }

    await withRestore({ storageIds: [input.storageId], loanIds: [input.loanId] }, async () => {
      await db.transaction('rw', db.storages, db.loans, async () => {
        await db.storages.put(storage)
        await db.loans.put(updatedLoan)
      })
    })
    await loanStore.getState().hydrate()
    return updatedLoan
  }
}))

/**
 * 借还写入：先快照受影响记录，再执行写入；失败时按快照恢复原柜位、借出状态与待归还清单。
 * 业务动作内部使用 Dexie 原子事务（事务失败会自行回滚），外层补偿用于事务之后仍失败的场景，
 * 保证重试不会多出记录。
 */
async function withRestore(
  scope: { storageIds: string[]; loanIds: string[] },
  action: () => Promise<void>
): Promise<void> {
  await mutateWithRestore(scope, action)
}

/**
 * 快照 + 写入 + 失败补偿的通用封装。
 * @internal 导出供单元测试直接传入「非事务写入」验证补偿逻辑
 */
export async function mutateWithRestore(
  scope: { storageIds: string[]; loanIds: string[] },
  mutate: () => Promise<void>
): Promise<void> {
  const snapshot: RestoreSnapshot = {
    storageIds: scope.storageIds,
    loanIds: scope.loanIds,
    storages: new Map(),
    loans: new Map()
  }
  const [beforeStorages, beforeLoans] = await Promise.all([
    db.storages.bulkGet(scope.storageIds),
    db.loans.bulkGet(scope.loanIds)
  ])
  scope.storageIds.forEach((id, index) => snapshot.storages.set(id, beforeStorages[index]))
  scope.loanIds.forEach((id, index) => snapshot.loans.set(id, beforeLoans[index]))

  try {
    await mutate()
  } catch (error) {
    await restoreSnapshot(snapshot)
    throw error
  }
}

/** 按快照恢复：原有的写回去，操作中新出现的记录删掉 */
async function restoreSnapshot(snapshot: RestoreSnapshot): Promise<void> {
  await db.transaction('rw', db.storages, db.loans, async () => {
    const storagesNow = await db.storages.bulkGet(snapshot.storageIds)
    const loansNow = await db.loans.bulkGet(snapshot.loanIds)
    const restoreStorages: Storage[] = []
    const restoreLoans: Loan[] = []
    const toDeleteStorages: string[] = []
    const toDeleteLoans: string[] = []
    snapshot.storageIds.forEach((id, index) => {
      const original = snapshot.storages.get(id)
      if (original) restoreStorages.push(original)
      else if (storagesNow[index]) toDeleteStorages.push(id)
    })
    snapshot.loanIds.forEach((id, index) => {
      const original = snapshot.loans.get(id)
      if (original) restoreLoans.push(original)
      else if (loansNow[index]) toDeleteLoans.push(id)
    })
    if (toDeleteStorages.length > 0) await db.storages.bulkDelete(toDeleteStorages)
    if (toDeleteLoans.length > 0) await db.loans.bulkDelete(toDeleteLoans)
    if (restoreStorages.length > 0) await db.storages.bulkPut(restoreStorages)
    if (restoreLoans.length > 0) await db.loans.bulkPut(restoreLoans)
  })
}
