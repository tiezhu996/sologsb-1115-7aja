import 'fake-indexeddb/auto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { db } from '@/hooks/usePersistentStore'
import { loanStore, LoanValidationError, mutateWithRestore } from '@/stores/loanStore'
import { buildCustodyBundle, loanRecordId } from '@/utils/custody'
import type { Loan, Specimen, Storage } from '@/types'

const specimensSeed: Specimen[] = [
  {
    id: 'sp_a',
    code: 'QLB-2026-0001',
    order: '鞘翅目',
    family: '步甲科',
    genus: 'Carabus',
    species: 'sp.',
    tempName: '步甲',
    collectDate: '2026-05-01',
    collector: '陆昀',
    sex: '雄',
    stage: '成虫',
    bodyLength: 28,
    method: '徒手',
    quantity: 1,
    status: '已鉴定',
    determiner: '覃羽',
    siteId: 'site_1',
    note: ''
  },
  {
    id: 'sp_b',
    code: 'QLB-2026-0002',
    order: '鳞翅目',
    family: '夜蛾科',
    genus: '',
    species: '',
    tempName: '夜蛾',
    collectDate: '2026-05-02',
    collector: '陆昀',
    sex: '未知',
    stage: '成虫',
    bodyLength: 16,
    method: '灯诱',
    quantity: 2,
    status: '初鉴',
    determiner: '',
    siteId: 'site_1',
    note: ''
  },
  {
    id: 'sp_c',
    code: 'QLB-2026-0003',
    order: '双翅目',
    family: '摇蚊科',
    genus: '',
    species: '',
    tempName: '摇蚊',
    collectDate: '2026-05-03',
    collector: '蓝澈',
    sex: '未知',
    stage: '幼虫',
    bodyLength: 6,
    method: '巴氏罐诱',
    quantity: 9,
    status: '待鉴定',
    determiner: '',
    siteId: 'site_1',
    note: ''
  }
]

const storage = (id: string, specimenId: string, slot: number): Storage => ({
  id,
  specimenId,
  method: '针插',
  cabinet: 'C01',
  drawer: 1,
  box: 1,
  slot,
  storedDate: '2026-05-10',
  handler: '覃羽'
})

const reload = async (): Promise<void> => {
  await loanStore.getState().hydrate()
}

describe('借还核心流程', () => {
  beforeEach(async () => {
    await db.specimens.bulkPut(specimensSeed)
    await db.storages.bulkPut([storage('stg_a', 'sp_a', 1), storage('stg_b', 'sp_b', 2)])
    await reload()
  })

  afterEach(async () => {
    await db.loans.clear()
    await db.storages.clear()
    await db.specimens.clear()
    vi.restoreAllMocks()
  })

  it('旧数据无借还记录时按在库/未入柜兼容', () => {
    const current = buildCustodyBundle(specimensSeed, [storage('stg_a', 'sp_a', 1), storage('stg_b', 'sp_b', 2)], [])
    expect(current.statusOf.get('sp_a')).toBe('在库')
    expect(current.statusOf.get('sp_b')).toBe('在库')
    expect(current.statusOf.get('sp_c')).toBe('未入柜')
  })

  it('整批外借：记录借用人/期限/原柜位并释放柜位', async () => {
    const records = await loanStore.getState().checkout({
      batchId: 'batch_1',
      specimenIds: ['sp_a', 'sp_b'],
      borrower: '省昆虫研究所',
      loanDate: '2026-06-01',
      dueDate: '2026-07-01',
      handler: '覃羽'
    })
    expect(records).toHaveLength(2)
    expect(await db.storages.count()).toBe(0)
    const loanA = await db.loans.get(loanRecordId('batch_1', 'sp_a'))
    expect(loanA).toMatchObject({
      state: '外借中',
      borrower: '省昆虫研究所',
      originCabinet: 'C01',
      originDrawer: 1,
      originBox: 1,
      originSlot: 1
    })
    await reload()
    const current = buildCustodyBundle(
      specimensSeed,
      await db.storages.toArray(),
      loanStore.getState().rows
    )
    expect(current.statusOf.get('sp_a')).toBe('外借中')
    expect(current.statusOf.get('sp_b')).toBe('外借中')
    expect(current.statusOf.get('sp_c')).toBe('未入柜')
  })

  it('外借校验：未入柜或已在外借流程中的标本拒绝借出（整批驳回，不留记录）', async () => {
    await expect(
      loanStore.getState().checkout({
        batchId: 'batch_unshelved',
        specimenIds: ['sp_c'],
        borrower: '乙单位',
        loanDate: '2026-06-02',
        dueDate: '2026-07-02',
        handler: ''
      })
    ).rejects.toBeInstanceOf(LoanValidationError)
    expect(await db.loans.count()).toBe(0)

    await loanStore.getState().checkout({
      batchId: 'batch_1',
      specimenIds: ['sp_a'],
      borrower: '甲单位',
      loanDate: '2026-06-01',
      dueDate: '2026-07-01',
      handler: ''
    })
    await expect(
      loanStore.getState().checkout({
        batchId: 'batch_2',
        specimenIds: ['sp_a', 'sp_b'],
        borrower: '乙单位',
        loanDate: '2026-06-02',
        dueDate: '2026-07-02',
        handler: ''
      })
    ).rejects.toBeInstanceOf(LoanValidationError)
    // 整批校验失败：同批其他标本也不能被借出，不得留下 batch_2 的任何记录
    expect(await db.loans.where('batchId').equals('batch_2').count()).toBe(0)
    expect((await db.storages.where('specimenId').equals('sp_b').count())).toBe(1)
  })

  it('失败后用同一批次号重试 checkout 不多出记录', async () => {
    const input = {
      batchId: 'batch_retry',
      specimenIds: ['sp_a', 'sp_b'],
      borrower: '省所',
      loanDate: '2026-06-01',
      dueDate: '2026-07-01',
      handler: ''
    }
    // 首次提交在事务中失败 → 事务回滚，柜位与借出状态不变
    vi.spyOn(db.loans, 'bulkPut').mockImplementationOnce((() =>
      Promise.reject(new Error('transient write error mock'))) as unknown as typeof db.loans.bulkPut)
    await expect(loanStore.getState().checkout(input)).rejects.toThrow('transient write error mock')
    expect(await db.loans.count()).toBe(0)
    expect(await db.storages.count()).toBe(2)

    // 页面沿用同一 batchId 重试 → 成功且只有 2 条记录
    const records = await loanStore.getState().checkout({ ...input, borrower: '省所（改名）' })
    expect(records).toHaveLength(2)
    expect(await db.loans.count()).toBe(2)
    const loanA = await db.loans.get(loanRecordId('batch_retry', 'sp_a'))
    expect(loanA?.borrower).toBe('省所（改名）')
    expect(await db.storages.count()).toBe(0)
  })

  it('事务内写入失败自动回滚：原柜位与借出状态保持不变', async () => {
    vi.spyOn(db.loans, 'bulkPut').mockImplementation((() =>
      Promise.reject(new Error('QuotaExceededError mock'))) as unknown as typeof db.loans.bulkPut)
    await expect(
      loanStore.getState().checkout({
        batchId: 'batch_fail',
        specimenIds: ['sp_a', 'sp_b'],
        borrower: '省所',
        loanDate: '2026-06-01',
        dueDate: '2026-07-01',
        handler: ''
      })
    ).rejects.toThrow('QuotaExceededError mock')
    expect(await db.loans.count()).toBe(0)
    const left = await db.storages.orderBy('id').toArray()
    expect(left.map((item) => item.id).sort()).toEqual(['stg_a', 'stg_b'])
  })

  it('归还：原柜位空着放回原柜并置已归位', async () => {
    await loanStore.getState().checkout({
      batchId: 'batch_1',
      specimenIds: ['sp_a'],
      borrower: '省所',
      loanDate: '2026-06-01',
      dueDate: '2026-07-01',
      handler: ''
    })
    const loanId = loanRecordId('batch_1', 'sp_a')
    const result = await loanStore.getState().returnLoans({ loanIds: [loanId], returnedDate: '2026-06-20' })
    expect(result.restored).toBe(1)
    expect(result.pending).toBe(0)
    const back = await db.storages.where('specimenId').equals('sp_a').first()
    expect(back).toMatchObject({ cabinet: 'C01', drawer: 1, box: 1, slot: 1 })
    const loan = await db.loans.get(loanId)
    expect(loan?.state).toBe('已归位')
    expect(loan).toMatchObject({ placedCabinet: 'C01', placedDrawer: 1, placedBox: 1, placedSlot: 1 })
  })

  it('归还：原柜位被占用则进待归位区，保留原柜位且不挤掉现有标本', async () => {
    await loanStore.getState().checkout({
      batchId: 'batch_1',
      specimenIds: ['sp_a'],
      borrower: '省所',
      loanDate: '2026-06-01',
      dueDate: '2026-07-01',
      handler: ''
    })
    // 外借期间 sp_b 被移入 sp_a 的原柜位
    await db.storages.put({ ...storage('stg_b', 'sp_b', 2), slot: 1 })

    const loanId = loanRecordId('batch_1', 'sp_a')
    const result = await loanStore.getState().returnLoans({ loanIds: [loanId], returnedDate: '2026-06-20' })
    expect(result.restored).toBe(0)
    expect(result.pending).toBe(1)
    // sp_b 仍在原位，没有被挤掉
    const occupant = await db.storages.where('specimenId').equals('sp_b').first()
    expect(occupant?.slot).toBe(1)
    const loan = await db.loans.get(loanId)
    expect(loan?.state).toBe('待归位')
    expect(loan).toMatchObject({ originSlot: 1, placedSlot: 0, returnedDate: '2026-06-20' })
    await reload()
    const current = buildCustodyBundle(specimensSeed, await db.storages.toArray(), loanStore.getState().rows)
    expect(current.statusOf.get('sp_a')).toBe('待归位')
    expect(current.statusOf.get('sp_b')).toBe('在库')
  })

  it('待归位：原柜位空后可放回原柜；被占用时改放新柜位', async () => {
    await loanStore.getState().checkout({
      batchId: 'batch_1',
      specimenIds: ['sp_a'],
      borrower: '省所',
      loanDate: '2026-06-01',
      dueDate: '2026-07-01',
      handler: ''
    })
    await db.storages.put({ ...storage('stg_b', 'sp_b', 2), slot: 1 })
    const loanId = loanRecordId('batch_1', 'sp_a')
    await loanStore.getState().returnLoans({ loanIds: [loanId], returnedDate: '2026-06-20' })

    // 原柜仍被占：放回原柜必须被拒绝
    await expect(
      loanStore.getState().reshelve({
        loanId,
        storageId: `stg_rsl_${loanId}`,
        method: '针插',
        cabinet: 'C01',
        drawer: 1,
        box: 1,
        slot: 1,
        storedDate: '2026-06-21',
        handler: ''
      })
    ).rejects.toBeInstanceOf(LoanValidationError)

    // 改放空柜位：成功，不挤掉 sp_b
    await loanStore.getState().reshelve({
      loanId,
      storageId: `stg_rsl_${loanId}`,
      method: '针插',
      cabinet: 'C01',
      drawer: 1,
      box: 1,
      slot: 3,
      storedDate: '2026-06-21',
      handler: ''
    })
    const moved = await db.storages.where('specimenId').equals('sp_a').first()
    expect(moved?.slot).toBe(3)
    const stillThere = await db.storages.where('specimenId').equals('sp_b').first()
    expect(stillThere?.slot).toBe(1)
    const loan = await db.loans.get(loanId)
    expect(loan?.state).toBe('已归位')
    expect(loan?.placedSlot).toBe(3)
    // 原柜位保留在记录中
    expect(loan?.originSlot).toBe(1)
  })

  it('归位事务失败原子回滚：保持待归位状态、不新增柜位记录', async () => {
    await loanStore.getState().checkout({
      batchId: 'batch_1',
      specimenIds: ['sp_a'],
      borrower: '省所',
      loanDate: '2026-06-01',
      dueDate: '2026-07-01',
      handler: ''
    })
    const loanId = loanRecordId('batch_1', 'sp_a')
    // 归还时原柜位已被 sp_b 占用 → sp_a 进入待归位
    await db.storages.put({ ...storage('stg_b', 'sp_b', 2), slot: 1 })
    await loanStore.getState().returnLoans({ loanIds: [loanId], returnedDate: '2026-06-20' })

    // storages.put 在归位事务中必抛错 → 整个事务回滚
    vi.spyOn(db.storages, 'put').mockImplementation((() =>
      Promise.reject(new Error('disk error mock'))) as unknown as typeof db.storages.put)
    await expect(
      loanStore.getState().reshelve({
        loanId,
        storageId: `stg_rsl_${loanId}`,
        method: '针插',
        cabinet: 'C01',
        drawer: 1,
        box: 1,
        slot: 3,
        storedDate: '2026-06-21',
        handler: ''
      })
    ).rejects.toThrow('disk error mock')
    const loan = await db.loans.get(loanId)
    expect(loan?.state).toBe('待归位')
    // 只有 sp_b 的柜位，没有半成品 stg_rsl
    const left = await db.storages.toArray()
    expect(left.map((item) => item.specimenId)).toEqual(['sp_b'])
  })

  it('事务外半成品写入失败时按快照补偿：恢复原柜位、借出状态并删除多余记录', async () => {
    const originalLoan: Loan = {
      id: 'loan_keep',
      batchId: 'b',
      specimenId: 'sp_a',
      borrower: '甲',
      loanDate: '2026-06-01',
      dueDate: '2026-07-01',
      handler: '',
      state: '外借中',
      originCabinet: 'C01',
      originDrawer: 1,
      originBox: 1,
      originSlot: 1,
      originMethod: '针插',
      returnedDate: '',
      placedCabinet: '',
      placedDrawer: 0,
      placedBox: 0,
      placedSlot: 0
    }
    const originalStorage = storage('stg_keep', 'sp_b', 2)
    await db.loans.put(originalLoan)
    await db.storages.put(originalStorage)

    // mutate 内不走事务，写入一半后抛错，补偿应恢复现场
    await expect(
      mutateWithRestore({ storageIds: ['stg_keep', 'stg_new'], loanIds: ['loan_keep', 'loan_new'] }, async () => {
        await db.storages.delete('stg_keep')
        await db.storages.put(storage('stg_new', 'sp_c', 3))
        await db.loans.put({ ...originalLoan, state: '待归位' })
        await db.loans.put({ ...originalLoan, id: 'loan_new' })
        throw new Error('post-commit failure mock')
      })
    ).rejects.toThrow('post-commit failure mock')

    expect(await db.storages.get('stg_keep')).toEqual(originalStorage)
    expect(await db.storages.get('stg_new')).toBeUndefined()
    expect(await db.loans.get('loan_keep')).toEqual(originalLoan)
    expect(await db.loans.get('loan_new')).toBeUndefined()
  })

  it('归还重试不多出柜位或借还记录', async () => {
    await loanStore.getState().checkout({
      batchId: 'batch_1',
      specimenIds: ['sp_a', 'sp_b'],
      borrower: '省所',
      loanDate: '2026-06-01',
      dueDate: '2026-07-01',
      handler: ''
    })
    const ids = [loanRecordId('batch_1', 'sp_a'), loanRecordId('batch_1', 'sp_b')]
    await loanStore.getState().returnLoans({ loanIds: ids, returnedDate: '2026-06-20' })
    // 已归还的记录再次登记归还应被拒绝
    await expect(
      loanStore.getState().returnLoans({ loanIds: ids, returnedDate: '2026-06-21' })
    ).rejects.toBeInstanceOf(LoanValidationError)
    expect(await db.storages.count()).toBe(2)
    expect(await db.loans.count()).toBe(2)
  })
})
