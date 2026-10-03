// v2 → v3 升级验证：先按旧结构建库写入数据，再打开新版 db 验证升级与兼容派生
import 'fake-indexeddb/auto'
import assert from 'node:assert/strict'
import Dexie from 'dexie'

async function main() {
  // 1) 以旧版（v2）结构建库
  const oldDb = new Dexie('gbinsectlog')
  oldDb.version(1).stores({
    specimens: 'id, code, order, status, siteId',
    sites: 'id, code, name',
    storages: 'id, specimenId, cabinet',
    determinations: 'id, specimenId, determiner',
    meta: 'key'
  })
  oldDb.version(2).stores({
    specimens: 'id, code, order, family, status, siteId, collectDate',
    sites: 'id, code, name, habitat',
    storages: 'id, specimenId, cabinet, drawer',
    determinations: 'id, specimenId, determiner, date',
    meta: 'key'
  })
  await oldDb.open()
  await oldDb.table('specimens').put({
    id: 'sp_old',
    code: 'OLD-2025-0001',
    order: '鞘翅目',
    family: '步甲科',
    genus: '',
    species: '',
    tempName: '旧标本',
    collectDate: '2025-06-01',
    collector: '前人',
    sex: '未知',
    stage: '成虫',
    bodyLength: 10,
    method: '扫网',
    quantity: 1,
    status: '已鉴定',
    determiner: '',
    siteId: '',
    note: ''
  })
  await oldDb.table('storages').put({
    id: 'stg_old',
    specimenId: 'sp_old',
    method: '针插',
    cabinet: 'C09',
    drawer: 1,
    box: 1,
    slot: 1,
    storedDate: '2025-06-02',
    handler: ''
  })
  await oldDb.close()

  // 2) 用新版应用代码打开（触发 v3 升级）
  const { db } = await import('../src/hooks/usePersistentStore')
  const { custodyOf } = await import('../src/utils/custody')
  const { loanStore } = await import('../src/stores/loanStore')
  await loanStore.getState().hydrate()

  assert.equal(await db.loans.count(), 0, '升级后 loans 表存在且为空')
  const sp = await db.specimens.get('sp_old')
  assert.equal(sp?.code, 'OLD-2025-0001')
  assert.equal(sp?.method, '扫网', 'v2 迁移结果保留')
  assert.equal((await db.storages.count()), 1, '旧柜位记录保留')
  assert.equal(custodyOf(loanStore.getState().rows, 'sp_old'), '在库', '无借还记录的旧标本按在库兼容')

  // 3) 升级后借还功能可正常工作
  const r = await loanStore.getState().checkout({
    specimenIds: ['sp_old'],
    borrower: '升级测试单位',
    loanDate: '2026-10-03',
    dueDate: '2026-11-03',
    handler: '',
    note: '',
    batchId: 'upg1'
  })
  assert.deepEqual(r.checkedOut, ['sp_old'])
  assert.equal(await db.storages.count(), 0, '旧标本借出后柜位释放')
  assert.equal(custodyOf((await db.loans.toArray()), 'sp_old'), '外借中')

  console.log('✅ v2→v3 升级与旧数据兼容验证通过')
}

main().catch((err) => {
  console.error('❌ 升级测试失败：', err)
  process.exit(1)
})
