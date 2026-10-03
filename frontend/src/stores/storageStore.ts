import { create } from 'zustand'
import type { Storage } from '@/types'
import { db, deleteRow, loadAll } from '@/hooks/usePersistentStore'
import { storageSlotText } from '@/utils/codec'

export interface StorageState {
  rows: Storage[]
  loaded: boolean
  hydrate: () => Promise<void>
  save: (row: Storage) => Promise<void>
  remove: (id: string) => Promise<void>
  removeBySpecimen: (specimenId: string) => Promise<void>
}

/** 外借中或待归位的标本不能入柜（待归位标本走借还的归位动作） */
async function assertStorable(specimenId: string): Promise<void> {
  const loans = await db.loans.where('specimenId').equals(specimenId).toArray()
  const blocked = loans.some((loan) => !loan.returnedDate || loan.awaitingSlot)
  if (blocked) {
    throw new Error('该标本正处于外借中或待归位状态，不能直接入柜')
  }
}

export const storageStore = create<StorageState>((set, get) => ({
  rows: [],
  loaded: false,
  hydrate: async () => {
    const rows = await loadAll<Storage>(db.storages)
    rows.sort((a, b) => storageSlotText(a).localeCompare(storageSlotText(b)))
    set({ rows, loaded: true })
  },
  save: async (row) => {
    // 与借据同事务校验，保证外借期间不能入柜；冲突时事务回滚，不留半截记录
    await db.transaction('rw', db.storages, db.loans, async () => {
      await assertStorable(row.specimenId)
      await db.storages.put(row)
    })
    await get().hydrate()
  },
  remove: async (id) => {
    await deleteRow<Storage>(db.storages, id)
    await get().hydrate()
  },
  removeBySpecimen: async (specimenId) => {
    const targets = get().rows.filter((row) => row.specimenId === specimenId)
    await Promise.all(targets.map((row) => deleteRow<Storage>(db.storages, row.id)))
    await get().hydrate()
  }
}))
