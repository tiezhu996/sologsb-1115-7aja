import { create } from 'zustand'
import type { Loan, Storage, StorageMethod } from '@/types'
import { db, loadAll } from '@/hooks/usePersistentStore'
import { storageStore } from '@/stores/storageStore'
import { storageSlotText } from '@/utils/codec'

export interface CheckoutInput {
  specimenIds: string[]
  borrower: string
  loanDate: string
  dueDate: string
  handler: string
  note: string
  /** 同一借出批次保持不变，使借据 id 确定化：写入失败重试不会多出记录 */
  batchId: string
}

export interface CheckoutResult {
  checkedOut: string[]
  skipped: { specimenId: string; reason: string }[]
}

export interface ReturnResult {
  /** 原柜位空着、已直接放回的标本 */
  restored: string[]
  /** 原柜位被占用、进入待归位区的标本 */
  awaiting: string[]
  skipped: { specimenId: string; reason: string }[]
}

export interface RehouseInput {
  specimenId: string
  method: StorageMethod
  cabinet: string
  drawer: number
  box: number
  slot: number
  storedDate: string
  handler: string
}

export interface RehouseResult {
  storageId: string
}

export interface LoanState {
  rows: Loan[]
  loaded: boolean
  hydrate: () => Promise<void>
  /** 确认外借：登记借据（借用人/期限/原柜位快照）并释放柜位 */
  checkout: (input: CheckoutInput) => Promise<CheckoutResult>
  /** 归还：原柜位空着放回；被占用则进待归位区并保留原柜位，不挤掉现有标本 */
  returnLoans: (specimenIds: string[], returnedDate: string, handler: string) => Promise<ReturnResult>
  /** 待归位标本重新入柜（可放回原柜位或改入新柜位），入柜后退出待归位状态 */
  rehouse: (input: RehouseInput) => Promise<RehouseResult>
}

/** 借据 id 确定化：同一批次重试为同一 id，put 覆盖而非新增 */
const loanId = (batchId: string, specimenId: string): string => `loan_${batchId}__${specimenId}`

/** 归还/归位产生的柜位记录 id 确定化：重试不产生重复入柜记录 */
const rehouseStorageId = (specimenId: string): string => `stg_rt_${specimenId}`

/** 找到每一份标本当前有效（未归还）的最新借据 */
const activeLoanIndex = (loans: Loan[]): Map<string, Loan> => {
  const map = new Map<string, Loan>()
  for (const loan of loans) {
    if (loan.returnedDate) continue
    const prev = map.get(loan.specimenId)
    if (!prev || loan.loanDate + loan.id > prev.loanDate + prev.id) {
      map.set(loan.specimenId, loan)
    }
  }
  return map
}

/** 最新的一条借据（含已归还） */
const latestLoan = (loans: Loan[], specimenId: string): Loan | undefined => {
  let result: Loan | undefined
  for (const loan of loans) {
    if (loan.specimenId !== specimenId) continue
    if (!result || loan.loanDate + loan.id > result.loanDate + result.id) result = loan
  }
  return result
}

export const loanStore = create<LoanState>((set, get) => ({
  rows: [],
  loaded: false,
  hydrate: async () => {
    const rows = await loadAll<Loan>(db.loans)
    rows.sort((a, b) => (b.loanDate + b.id).localeCompare(a.loanDate + a.id))
    set({ rows, loaded: true })
  },

  checkout: async ({ specimenIds, borrower, loanDate, dueDate, handler, note, batchId }) => {
    // 事务内校验 + 写入：任何一步失败，已写的借据与被删的柜位记录全部回滚
    const result = await db.transaction('rw', db.loans, db.storages, async () => {
      const [loans, storages] = await Promise.all([db.loans.toArray(), db.storages.toArray()])
      const active = activeLoanIndex(loans)
      const storageBySpecimen = new Map(storages.map((item) => [item.specimenId, item]))

      const checkedOut: string[] = []
      const skipped: { specimenId: string; reason: string }[] = []
      const loansToPut: Loan[] = []
      const storageIdsToDelete: string[] = []

      for (const specimenId of Array.from(new Set(specimenIds))) {
        const expectedId = loanId(batchId, specimenId)
        const activeLoan = active.get(specimenId)
        if (activeLoan) {
          // 重试幂等：同批次同标本借据已提交 → 跳过；被别的批次抢先借出 → 冲突跳过
          if (activeLoan.id === expectedId) checkedOut.push(specimenId)
          else skipped.push({ specimenId, reason: '该标本已在外借中' })
          continue
        }
        // 极端情况下借据已归还（对同批次的重复点击），同样按幂等成功处理
        if (loans.some((item) => item.id === expectedId)) {
          checkedOut.push(specimenId)
          continue
        }

        const origin = storageBySpecimen.get(specimenId)
        loansToPut.push({
          id: expectedId,
          specimenId,
          borrower,
          loanDate,
          dueDate,
          returnedDate: '',
          handler,
          note,
          originMethod: origin ? origin.method : '',
          originCabinet: origin ? origin.cabinet : '',
          originDrawer: origin ? origin.drawer : 0,
          originBox: origin ? origin.box : 0,
          originSlot: origin ? origin.slot : 0,
          awaitingSlot: false
        })
        checkedOut.push(specimenId)
        if (origin) storageIdsToDelete.push(origin.id)
      }

      await db.loans.bulkPut(loansToPut)
      await db.storages.bulkDelete(storageIdsToDelete)
      return { checkedOut, skipped }
    })

    // 事务成功提交后才刷新内存镜像；写入失败时 Dexie 自动回滚，hydrate 不执行，
    // 原柜位 / 借出状态 / 待归还清单保持操作前原貌，重试也不会多出借据
    await Promise.all([get().hydrate(), storageStore.getState().hydrate()])
    return result
  },

  returnLoans: async (specimenIds, returnedDate, handler) => {
    const result = await db.transaction('rw', db.loans, db.storages, async () => {
      const [loans, storages] = await Promise.all([db.loans.toArray(), db.storages.toArray()])
      const active = activeLoanIndex(loans)
      const storageBySpecimen = new Map(storages.map((item) => [item.specimenId, item]))

      const restored: string[] = []
      const awaiting: string[] = []
      const skipped: { specimenId: string; reason: string }[] = []
      const loansToPut: Loan[] = []
      const storagesToPut: Storage[] = []
      // 本批次内已决定占住的柜位，避免同批两份借据原柜位相同而重复写入
      const slotsTaken = new Set(storages.map((item) => storageSlotText(item)))

      for (const specimenId of Array.from(new Set(specimenIds))) {
        const loan = active.get(specimenId)
        if (!loan) {
          skipped.push({ specimenId, reason: '没有进行中的外借记录' })
          continue
        }
        const handlerValue = handler.trim() || loan.handler

        // 借出时未入柜：归还即回到在库，无柜位可放
        if (!loan.originCabinet) {
          loansToPut.push({ ...loan, returnedDate, handler: handlerValue, awaitingSlot: false })
          restored.push(specimenId)
          continue
        }

        const originText = storageSlotText({
          cabinet: loan.originCabinet,
          drawer: loan.originDrawer,
          box: loan.originBox,
          slot: loan.originSlot
        } as Storage)
        const occupiedByOther = storages.some(
          (item) => item.specimenId !== specimenId && storageSlotText(item) === originText
        )

        if (!occupiedByOther && !slotsTaken.has(originText)) {
          // 原柜位空着：放回（不挤掉现有标本）
          const current = storageBySpecimen.get(specimenId)
          storagesToPut.push({
            id: current?.id ?? rehouseStorageId(specimenId),
            specimenId,
            method: current?.method ?? (loan.originMethod === '' ? '针插' : loan.originMethod),
            cabinet: loan.originCabinet,
            drawer: loan.originDrawer,
            box: loan.originBox,
            slot: loan.originSlot,
            storedDate: returnedDate,
            handler: handlerValue
          })
          slotsTaken.add(originText)
          loansToPut.push({ ...loan, returnedDate, handler: handlerValue, awaitingSlot: false })
          restored.push(specimenId)
        } else {
          // 原柜位已被占用：进入待归位区，保留原柜位，不动现有标本
          loansToPut.push({ ...loan, returnedDate, handler: handlerValue, awaitingSlot: true })
          awaiting.push(specimenId)
        }
      }

      await db.loans.bulkPut(loansToPut)
      await db.storages.bulkPut(storagesToPut)
      return { restored, awaiting, skipped }
    })

    await Promise.all([get().hydrate(), storageStore.getState().hydrate()])
    return result
  },

  rehouse: async ({ specimenId, method, cabinet, drawer, box, slot, storedDate, handler }) => {
    const result = await db.transaction('rw', db.loans, db.storages, async () => {
      const [loans, storages] = await Promise.all([db.loans.toArray(), db.storages.toArray()])
      // 只有「待归位」标本走这里
      const candidate = latestLoan(loans, specimenId)
      if (!candidate || !candidate.returnedDate || !candidate.awaitingSlot) {
        throw new Error('该标本不在待归位区')
      }

      const target: Storage = {
        id: rehouseStorageId(specimenId),
        specimenId,
        method,
        cabinet,
        drawer,
        box,
        slot,
        storedDate,
        handler: handler.trim() || candidate.handler
      }
      const targetText = storageSlotText(target)
      const conflict = storages.find(
        (item) => item.specimenId !== specimenId && storageSlotText(item) === targetText
      )
      if (conflict) throw new Error(`柜位 ${targetText} 已被占用，请换一个插位`)

      // 柜位记录 id 确定化，重复提交为覆盖；待归位标志清除
      await db.storages.put(target)
      await db.loans.put({ ...candidate, awaitingSlot: false })
      return { storageId: target.id }
    })

    await Promise.all([get().hydrate(), storageStore.getState().hydrate()])
    return result
  }
}))
