// 借还流程冒烟测试（Node + fake-indexeddb），验证：
// 1. 借出释放柜位 2. 归还原柜位空着放回 3. 原柜位占用→待归位 4. 外借中不能入柜/新增鉴定路径的 store 守卫
// 5. 事务失败回滚（原柜位/借出状态/待归还清单恢复）6. 同批次重试不多记录
import 'fake-indexeddb/auto'
import assert from 'node:assert/strict'
import { db } from '../src/hooks/usePersistentStore'
import { loanStore } from '../src/stores/loanStore'
import { storageStore } from '../src/stores/storageStore'
import { specimenStore } from '../src/stores/specimenStore'
import { storageSlotText } from '../src/utils/codec'
import { custodyOf } from '../src/utils/custody'

const today = '2026-10-03'

async function seed() {
  await db.specimens.bulkPut([
    { id: 'sp_a', code: 'A-2026-0001', order: '鞘翅目', family: '步甲科', genus: '', species: '', tempName: '甲', collectDate: today, collector: '陆', sex: '未知', stage: '成虫', bodyLength: 1, method: '扫网', quantity: 1, status: '待鉴定', determiner: '', siteId: 's1', note: '' },
    { id: 'sp_b', code: 'A-2026-0002', order: '鳞翅目', family: '夜蛾科', genus: '', species: '', tempName: '蛾', collectDate: today, collector: '陆', sex: '未知', stage: '成虫', bodyLength: 1, method: '灯诱', quantity: 1, status: '初鉴', determiner: '', siteId: 's1', note: '' },
    { id: 'sp_c', code: 'A-2026-0003', order: '蜻蜓目', family: '蜻科', genus: '', species: '', tempName: '蜻', collectDate: today, collector: '陆', sex: '未知', stage: '成虫', bodyLength: 1, method: '扫网', quantity: 1, status: '已鉴定', determiner: '覃', siteId: 's1', note: '' },
    { id: 'sp_d', code: 'A-2026-0004', order: '双翅目', family: '摇蚊科', genus: '', species: '', tempName: '蚊', collectDate: today, collector: '陆', sex: '未知', stage: '幼虫', bodyLength: 1, method: '巴氏罐诱', quantity: 1, status: '待鉴定', determiner: '', siteId: 's1', note: '' }
  ])
  await db.storages.bulkPut([
    { id: 'stg_a', specimenId: 'sp_a', method: '针插', cabinet: 'C01', drawer: 1, box: 1, slot: 1, storedDate: today, handler: '覃' },
    { id: 'stg_b', specimenId: 'sp_b', method: '针插', cabinet: 'C01', drawer: 1, box: 1, slot: 2, storedDate: today, handler: '覃' }
  ])
  await storageStore.getState().hydrate()
  await loanStore.getState().hydrate()
  await specimenStore.getState().hydrate()
}

async function main() {
  await seed()
  assert.equal(custodyOf(loanStore.getState().rows, 'sp_a'), '在库', '无借还记录应按在库兼容')

  // ---------- 用例 1：借出释放柜位 ----------
  const batchId = 'batch_test_1'
  const r1 = await loanStore.getState().checkout({
    specimenIds: ['sp_a', 'sp_b'],
    borrower: '外单位甲',
    loanDate: today,
    dueDate: '2026-11-03',
    handler: '覃羽',
    note: '',
    batchId
  })
  assert.deepEqual(r1.checkedOut.sort(), ['sp_a', 'sp_b'])
  let loans = await db.loans.toArray()
  assert.equal(loans.length, 2, '应生成 2 条借据')
  assert.equal(await db.storages.count(), 0, '借出后柜位应全部释放')
  assert.equal(custodyOf(loans, 'sp_a'), '外借中')

  // ---------- 用例 2：同批次重试幂等，不多记录 ----------
  const r1retry = await loanStore.getState().checkout({
    specimenIds: ['sp_a', 'sp_b'],
    borrower: '外单位甲',
    loanDate: today,
    dueDate: '2026-11-03',
    handler: '覃羽',
    note: '',
    batchId
  })
  assert.deepEqual(r1retry.checkedOut.sort(), ['sp_a', 'sp_b'])
  assert.equal(r1retry.skipped.length, 0)
  assert.equal(await db.loans.count(), 2, '重试不能多出借据')

  // ---------- 用例 3：外借期间不能入柜（storageStore 守卫）----------
  await assert.rejects(
    () =>
      storageStore.getState().save({
        id: 'stg_a_retry',
        specimenId: 'sp_a',
        method: '针插',
        cabinet: 'C02',
        drawer: 1,
        box: 1,
        slot: 9,
        storedDate: today,
        handler: '覃'
      }),
    /外借中|待归位/
  )
  assert.equal((await db.storages.count()), 0, '守卫抛错后不应留下柜位记录')

  // ---------- 用例 4：归还 sp_a，原柜位空着 → 放回 ----------
  const ret = await loanStore.getState().returnLoans(['sp_a'], '2026-10-20', '')
  assert.deepEqual(ret.restored, ['sp_a'])
  assert.deepEqual(ret.awaiting, [])
  const storages = await db.storages.toArray()
  assert.equal(storages.length, 1)
  assert.equal(storages[0].specimenId, 'sp_a')
  assert.equal(storageSlotText(storages[0]), 'C01-D1-B01-S01', '应放回原柜位')
  loans = await db.loans.toArray()
  assert.equal(custodyOf(loans, 'sp_a'), '在库')

  // 归还重试：已无进行中借据 → skipped，不新增柜位
  const retRetry = await loanStore.getState().returnLoans(['sp_a'], '2026-10-20', '')
  assert.equal(retRetry.skipped.length, 1)
  assert.equal((await db.storages.count()), 1, '归还重试不多出柜位记录')

  // ---------- 用例 5：归还 sp_b 时原柜位被 sp_d 占用 → 待归位，不挤掉 ----------
  await db.storages.put({ id: 'stg_d', specimenId: 'sp_d', method: '针插', cabinet: 'C01', drawer: 1, box: 1, slot: 2, storedDate: today, handler: '覃' })
  await storageStore.getState().hydrate()
  const retB = await loanStore.getState().returnLoans(['sp_b'], '2026-10-21', '覃羽')
  assert.deepEqual(retB.awaiting, ['sp_b'])
  assert.deepEqual(retB.restored, [])
  const afterReturn = await db.storages.toArray()
  assert.equal(afterReturn.length, 2, '只能有 sp_a 与占用人 sp_d 两条柜位')
  const occupant = afterReturn.find((s) => storageSlotText(s) === 'C01-D1-B01-S02')
  assert.equal(occupant?.specimenId, 'sp_d', '不能挤掉现有标本')
  const loanB = (await db.loans.toArray()).find((l) => l.specimenId === 'sp_b')
  assert.equal(loanB?.awaitingSlot, true)
  assert.equal(loanB?.originCabinet, 'C01', '原柜位保留在借据上')

  // 待归位期间普通入柜流程仍被拦截
  await assert.rejects(
    () => storageStore.getState().save({ id: 'x', specimenId: 'sp_b', method: '针插', cabinet: 'C09', drawer: 1, box: 1, slot: 1, storedDate: today, handler: '' }),
    /外借中|待归位/
  )

  // ---------- 用例 6：占用人移出后，一键放回原柜位（UI 走 rehouse 到原柜位）----------
  await db.storages.delete('stg_d')
  await storageStore.getState().hydrate()
  await loanStore.getState().rehouse({
    specimenId: 'sp_b',
    method: '针插',
    cabinet: 'C01',
    drawer: 1,
    box: 1,
    slot: 2,
    storedDate: '2026-10-22',
    handler: '覃'
  })
  assert.equal((await db.storages.where('specimenId').equals('sp_b').count()), 1)
  const loanBAfter = (await db.loans.toArray()).find((l) => l.specimenId === 'sp_b')
  assert.equal(loanBAfter?.awaitingSlot, false)
  assert.equal(custodyOf(await db.loans.toArray(), 'sp_b'), '在库')

  // rehouse 重试幂等：归还放回用确定性 id（stg_rt_<标本>），重复归还不会产生第二条柜位
  // 先占住 sp_c 在别处，不影响；直接验证 sp_b 当前只有一条柜位且 id 确定
  assert.equal((await db.storages.where('specimenId').equals('sp_b').count()), 1)
  const rehousedId = (await db.storages.where('specimenId').equals('sp_b').first())!.id
  assert.equal(rehousedId, 'stg_rt_sp_b', '归位柜位记录 id 应确定化，供重试覆盖')

  // 再走一轮借出→空柜位归还，验证 returnLoans 幂等：第二次 returnLoans 全部 skip，不新增柜位
  await loanStore.getState().checkout({ specimenIds: ['sp_b'], borrower: '乙', loanDate: '2026-10-23', dueDate: '2026-11-23', handler: '', note: '', batchId: 'b_idem' })
  assert.equal((await db.storages.where('specimenId').equals('sp_b').count()), 0, '借出应释放归位柜位')
  await loanStore.getState().returnLoans(['sp_b'], '2026-10-24', '')
  assert.equal((await db.storages.where('specimenId').equals('sp_b').count()), 1, '归还原柜位空着应写回一条')
  await loanStore.getState().returnLoans(['sp_b'], '2026-10-24', '')
  assert.equal((await db.storages.where('specimenId').equals('sp_b').count()), 1, '重复归还不多出柜位记录')
  // 非待归位标本调 rehouse 应被拒绝
  await assert.rejects(
    () =>
      loanStore.getState().rehouse({
        specimenId: 'sp_b',
        method: '针插',
        cabinet: 'C01',
        drawer: 1,
        box: 1,
        slot: 2,
        storedDate: '2026-10-24',
        handler: ''
      }),
    /待归位/
  )

  // rehouse 冲突柜位应抛错且回滚（不改 awaitingSlot，不落柜位）
  await loanStore.getState().checkout({ specimenIds: ['sp_b'], borrower: '乙2', loanDate: '2026-10-25', dueDate: '2026-11-25', handler: '', note: '', batchId: 'b2' })
  await db.storages.put({ id: 'stg_occ2', specimenId: 'sp_c', method: '针插', cabinet: 'C01', drawer: 1, box: 1, slot: 2, storedDate: today, handler: '' })
  await db.storages.put({ id: 'stg_d2', specimenId: 'sp_d', method: '针插', cabinet: 'C01', drawer: 1, box: 1, slot: 5, storedDate: today, handler: '' })
  await storageStore.getState().hydrate()
  await loanStore.getState().returnLoans(['sp_b'], '2026-10-26', '')
  await assert.rejects(
    () =>
      loanStore.getState().rehouse({
        specimenId: 'sp_b',
        method: '针插',
        cabinet: 'C01',
        drawer: 1,
        box: 1,
        slot: 5, // sp_d 占用
        storedDate: '2026-10-26',
        handler: ''
      }),
    /已被占用/
  )
  const loanBRolled = (await db.loans.toArray()).find((l) => l.specimenId === 'sp_b' && l.awaitingSlot)
  assert.ok(loanBRolled, '归位冲突后应仍为待归位')
  assert.equal(
    (await db.storages.where('specimenId').equals('sp_b').count()),
    0,
    '归位冲突回滚后不应留下 sp_b 柜位记录'
  )

  // ---------- 用例 7：借出写入失败整体回滚（模拟 storages 删除抛错）----------
  await db.specimens.bulkPut([
    { id: 'sp_e', code: 'A-2026-0005', order: '鞘翅目', family: '', genus: '', species: '', tempName: '戊', collectDate: today, collector: '', sex: '未知', stage: '成虫', bodyLength: 1, method: '扫网', quantity: 1, status: '待鉴定', determiner: '', siteId: 's1', note: '' },
    { id: 'sp_f', code: 'A-2026-0006', order: '鳞翅目', family: '', genus: '', species: '', tempName: '己', collectDate: today, collector: '', sex: '未知', stage: '成虫', bodyLength: 1, method: '灯诱', quantity: 1, status: '待鉴定', determiner: '', siteId: 's1', note: '' }
  ])
  await db.storages.bulkPut([
    { id: 'stg_e', specimenId: 'sp_e', method: '针插', cabinet: 'C03', drawer: 1, box: 1, slot: 1, storedDate: today, handler: '' },
    { id: 'stg_f', specimenId: 'sp_f', method: '针插', cabinet: 'C03', drawer: 1, box: 1, slot: 2, storedDate: today, handler: '' }
  ])
  await storageStore.getState().hydrate()
  const loansBeforeFail = await db.loans.count()
  const beforeIds = (await db.storages.toArray()).map((s) => s.id).sort()
  const failingHook = (): never => {
    throw new Error('模拟存储故障')
  }
  db.storages.hook('deleting', failingHook)
  await assert.rejects(
    () =>
      loanStore.getState().checkout({
        specimenIds: ['sp_e', 'sp_f'],
        borrower: '丙',
        loanDate: today,
        dueDate: '2026-11-03',
        handler: '',
        note: '',
        batchId: 'b_fail'
      }),
    /模拟存储故障/
  )
  db.storages.hook('deleting').unsubscribe(failingHook)
  assert.equal(await db.loans.count(), loansBeforeFail, '失败后借据必须全部回滚（待归还清单恢复）')
  assert.deepEqual(
    (await db.storages.toArray()).map((s) => s.id).sort(),
    beforeIds,
    '失败后原柜位必须恢复'
  )
  assert.equal(custodyOf(await db.loans.toArray(), 'sp_e'), '在库', '借出状态恢复为在库')

  // ---------- 用例 8：失败后用同一批次号重试，成功且不多记录 ----------
  const r8 = await loanStore.getState().checkout({
    specimenIds: ['sp_e', 'sp_f'],
    borrower: '丙',
    loanDate: today,
    dueDate: '2026-11-03',
    handler: '',
    note: '',
    batchId: 'b_fail'
  })
  assert.deepEqual(r8.skipped, [])
  assert.deepEqual(r8.checkedOut.sort(), ['sp_e', 'sp_f'])
  assert.equal(await db.loans.count(), loansBeforeFail + 2, '重试成功恰好新增 2 条借据')
  assert.equal(custodyOf(await db.loans.toArray(), 'sp_e'), '外借中')
  assert.equal(
    (await db.storages.where('specimenId').anyOf('sp_e', 'sp_f').count()),
    0,
    '重试成功后柜位释放'
  )

  console.log('✅ 全部借还冒烟用例通过')
}

main().catch((err) => {
  console.error('❌ 测试失败：', err)
  process.exit(1)
})
