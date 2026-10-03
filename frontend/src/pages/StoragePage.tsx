import { useMemo, useState } from 'react'
import type { Loan, Storage, StorageMethod } from '@/types'
import { STORAGE_METHODS } from '@/types'
import CabinetGrid, { type SlotMark } from '@/components/common/CabinetGrid'
import CustodyTag from '@/components/common/CustodyTag'
import StatusTag from '@/components/common/StatusTag'
import { usePersistentStore } from '@/hooks/usePersistentStore'
import { specimenStore } from '@/stores/specimenStore'
import { storageStore } from '@/stores/storageStore'
import { loanStore, LoanValidationError } from '@/stores/loanStore'
import { siteStore } from '@/stores/siteStore'
import { buildCustodyBundle, addDays } from '@/utils/custody'
import { encodeSlot, findSlotConflicts, specimenTaxon, storageSlotText } from '@/utils/codec'
import { uid } from '@/utils/id'

/** 保藏柜位图：柜-抽屉-盒-位三级展开，拖拽入柜；整批外借释放柜位，归还自动回原柜或进待归位区 */
export default function StoragePage(): JSX.Element {
  const specimens = usePersistentStore(specimenStore, (state) => state.rows)
  const storages = usePersistentStore(storageStore, (state) => state.rows)
  const loans = usePersistentStore(loanStore, (state) => state.rows)
  const sites = usePersistentStore(siteStore, (state) => state.rows)

  const [cabinet, setCabinet] = useState('C01')
  const [drawers, setDrawers] = useState(2)
  const [boxes, setBoxes] = useState(3)
  const [slots, setSlots] = useState(8)
  const [method, setMethod] = useState<StorageMethod>('针插')
  const [handler, setHandler] = useState('')
  const [picked, setPicked] = useState('')
  const [dragging, setDragging] = useState<string | null>(null)
  const [message, setMessage] = useState('')
  const [warning, setWarning] = useState('')
  const [detail, setDetail] = useState<Storage | null>(null)

  // 外借登记
  const [loanPicks, setLoanPicks] = useState<string[]>([])
  const [borrower, setBorrower] = useState('')
  const [loanDate, setLoanDate] = useState(new Date().toISOString().slice(0, 10))
  const [dueDate, setDueDate] = useState(addDays(new Date().toISOString().slice(0, 10), 30))
  const [loanHandler, setLoanHandler] = useState('')
  const [checkoutBatch, setCheckoutBatch] = useState('')
  const [loanBusy, setLoanBusy] = useState(false)
  const [returnPicks, setReturnPicks] = useState<string[]>([])
  const [returnedDate, setReturnedDate] = useState(new Date().toISOString().slice(0, 10))
  /** 拖入被借还流程保留的柜位时，需要二次确认才允许占用 */
  const [forceSlotKey, setForceSlotKey] = useState('')

  const custody = useMemo(() => buildCustodyBundle(specimens, storages, loans), [specimens, storages, loans])

  const codeOf = (specimenId: string): string => specimens.find((item) => item.id === specimenId)?.code ?? '未知'
  const siteName = (siteId: string): string => sites.find((site) => site.id === siteId)?.name ?? '未关联采集地'
  const statusOf = (specimenId: string) => custody.statusOf.get(specimenId) ?? '未入柜'

  const inCabinet = useMemo(
    () => specimens.filter((item) => custody.statusOf.get(item.id) === '在库'),
    [custody, specimens]
  )
  const activeLoans = useMemo(() => loans.filter((item) => item.state === '外借中'), [loans])
  const pendingLoans = useMemo(() => loans.filter((item) => item.state === '待归位'), [loans])
  const unplaced = useMemo(() => specimens.filter((item) => custody.statusOf.get(item.id) === '未入柜'), [custody, specimens])

  const today = new Date().toISOString().slice(0, 10)
  const slotKeyOf = (cabinetName: string, drawer: number, box: number, slot: number): string =>
    `${cabinetName.toUpperCase()}-${drawer}-${box}-${slot}`
  const marks: SlotMark[] = ([] as SlotMark[])
    .concat(
      activeLoans.map((loan) => ({
        cabinet: loan.originCabinet,
        drawer: loan.originDrawer,
        box: loan.originBox,
        slot: loan.originSlot,
        kind: '外借中' as const,
        specimenId: loan.specimenId,
        code: codeOf(loan.specimenId),
        hint: `${loan.borrower} · 期限 ${loan.dueDate}`
      }))
    )
    .concat(
      pendingLoans.map((loan) => {
        const originKey = slotKeyOf(loan.originCabinet, loan.originDrawer, loan.originBox, loan.originSlot)
        const occupant = storages.find(
          (storage) => slotKeyOf(storage.cabinet, storage.drawer, storage.box, storage.slot) === originKey
        )
        return {
          cabinet: loan.originCabinet,
          drawer: loan.originDrawer,
          box: loan.originBox,
          slot: loan.originSlot,
          kind: '待归位' as const,
          specimenId: loan.specimenId,
          code: codeOf(loan.specimenId),
          hint: encodeSlot(loan.originCabinet, loan.originDrawer, loan.originBox, loan.originSlot),
          occupiedBy: occupant ? codeOf(occupant.specimenId) : undefined
        }
      })
    )
  const markByKey = new Map<string, SlotMark>()
  marks.forEach((mark) => markByKey.set(slotKeyOf(mark.cabinet, mark.drawer, mark.box, mark.slot), mark))

  const place = async (position: { cabinet: string; drawer: number; box: number; slot: number }): Promise<void> => {
    const specimenId = dragging ?? picked
    if (!specimenId) {
      setWarning('请先在右侧选择或拖动一份未入柜 / 待归位标本')
      return
    }
    const currentStatus = statusOf(specimenId)
    if (currentStatus === '外借中') {
      setWarning(`${codeOf(specimenId)} 正在外借中，归还前不能入柜`)
      return
    }
    const pendingLoan = custody.activeBySpecimen.get(specimenId)
    const positionKey = slotKeyOf(position.cabinet, position.drawer, position.box, position.slot)
    const reservedMark = markByKey.get(positionKey)
    if (reservedMark && reservedMark.specimenId !== specimenId && forceSlotKey !== positionKey) {
      setWarning(
        reservedMark.kind === '外借中'
          ? `${encodeSlot(position.cabinet, position.drawer, position.box, position.slot)} 是 ${reservedMark.code} 外借保留的原柜位（${reservedMark.hint}）。如确认让当前标本占用（其归还后将进待归位区），请再次点击/拖入同一插位`
          : `${encodeSlot(position.cabinet, position.drawer, position.box, position.slot)} 是待归位标本 ${reservedMark.code} 保留的原柜位${
              reservedMark.occupiedBy ? '' : '，现仍空着'
            }。如确认让当前标本占用（${reservedMark.code} 继续留在待归位区），请再次点击/拖入同一插位`
      )
      setForceSlotKey(positionKey)
      return
    }
    const candidate: Storage = {
      id: pendingLoan?.state === '待归位' ? `stg_rsl_${pendingLoan.id}` : uid('stg'),
      specimenId,
      method,
      cabinet: position.cabinet,
      drawer: position.drawer,
      box: position.box,
      slot: position.slot,
      storedDate: new Date().toISOString().slice(0, 10),
      handler: handler.trim()
    }
    const conflicts = findSlotConflicts(storages, candidate)
    if (conflicts.length > 0) {
      setWarning(
        `柜位 ${encodeSlot(position.cabinet, position.drawer, position.box, position.slot)} 已被占用：` +
          conflicts.map((item) => `${codeOf(item.specimenId)}（${item.method}）`).join('、') +
          '，请换一个插位'
      )
      return
    }

    try {
      if (pendingLoan?.state === '待归位') {
        await loanStore.getState().reshelve({
          loanId: pendingLoan.id,
          storageId: candidate.id,
          method,
          cabinet: candidate.cabinet,
          drawer: candidate.drawer,
          box: candidate.box,
          slot: candidate.slot,
          storedDate: candidate.storedDate,
          handler: candidate.handler
        })
        setMessage(`${codeOf(specimenId)} 已归位 ${storageSlotText(candidate)}`)
      } else {
        await storageStore.getState().save(candidate)
        setMessage(`${codeOf(specimenId)} 已入柜 ${storageSlotText(candidate)}`)
      }
      setWarning('')
      setForceSlotKey('')
    } catch (error) {
      setWarning(error instanceof LoanValidationError ? error.message : '写入失败，已恢复原柜位与借还状态，请重试')
    }
    setPicked('')
    setDragging(null)
  }

  /** 待归位标本放回原柜：仅原柜位仍空时成功，不挤掉现有标本 */
  const restoreToOrigin = async (loan: Loan): Promise<void> => {
    const candidate = {
      cabinet: loan.originCabinet,
      drawer: loan.originDrawer,
      box: loan.originBox,
      slot: loan.originSlot
    }
    const originKey = slotKeyOf(candidate.cabinet, candidate.drawer, candidate.box, candidate.slot)
    const occupant = storages.find(
      (storage) => slotKeyOf(storage.cabinet, storage.drawer, storage.box, storage.slot) === originKey
    )
    if (occupant) {
      setWarning(`原柜位 ${encodeSlot(candidate.cabinet, candidate.drawer, candidate.box, candidate.slot)} 已被 ${codeOf(occupant.specimenId)} 占用，可把该标本拖到其他空插位`)
      return
    }
    try {
      await loanStore.getState().reshelve({
        loanId: loan.id,
        storageId: `stg_rsl_${loan.id}`,
        method: (loan.originMethod as StorageMethod) || method,
        ...candidate,
        storedDate: new Date().toISOString().slice(0, 10),
        handler: handler.trim() || loan.handler
      })
      setMessage(`${codeOf(loan.specimenId)} 已放回原柜位 ${encodeSlot(candidate.cabinet, candidate.drawer, candidate.box, candidate.slot)}`)
      setWarning('')
    } catch (error) {
      setWarning(error instanceof LoanValidationError ? error.message : '归位写入失败，已恢复待归位清单，请重试')
    }
  }

  const takeOut = async (storage: Storage): Promise<void> => {
    await storageStore.getState().remove(storage.id)
    setMessage(`${codeOf(storage.specimenId)} 已从 ${storageSlotText(storage)} 出柜`)
    setDetail(null)
  }

  const toggleLoanPick = (specimenId: string): void => {
    setLoanPicks((prev) => (prev.includes(specimenId) ? prev.filter((id) => id !== specimenId) : [...prev, specimenId]))
  }

  const toggleReturnPick = (loanId: string): void => {
    setReturnPicks((prev) => (prev.includes(loanId) ? prev.filter((id) => id !== loanId) : [...prev, loanId]))
  }

  /** 整批确认外借；batchId 在首次确认时生成并固定，失败后整批重试不会多出借还记录 */
  const confirmCheckout = async (): Promise<void> => {
    if (loanPicks.length === 0) {
      setWarning('请先勾选要外借的在库标本')
      return
    }
    const batchId = checkoutBatch || uid('loanbatch')
    setCheckoutBatch(batchId)
    setLoanBusy(true)
    try {
      const records = await loanStore.getState().checkout({
        batchId,
        specimenIds: loanPicks,
        borrower,
        loanDate,
        dueDate,
        handler: loanHandler.trim() || handler.trim(),
        labelOf: codeOf
      })
      setMessage(`已登记外借 ${records.length} 份给「${records[0].borrower}」，原柜位已释放并保留归属，期限至 ${dueDate}`)
      setWarning('')
      setLoanPicks([])
      setBorrower('')
      setCheckoutBatch('')
    } catch (error) {
      setWarning(
        error instanceof LoanValidationError
          ? error.message
          : '外借写入失败，已恢复原柜位、借出状态与待归还清单，可直接重试（不会产生重复记录）'
      )
    } finally {
      setLoanBusy(false)
    }
  }

  const confirmReturn = async (): Promise<void> => {
    if (returnPicks.length === 0) {
      setWarning('请先勾选要归还的外借记录')
      return
    }
    try {
      const result = await loanStore.getState().returnLoans({
        loanIds: returnPicks,
        returnedDate,
        labelOf: (loan) => codeOf(loan.specimenId)
      })
      const parts: string[] = []
      if (result.restored > 0) parts.push(`${result.restored} 份原柜位空着，已放回原柜`)
      if (result.pending > 0) parts.push(`${result.pending} 份原柜位已被占用，进入待归位区并保留原柜位`)
      setMessage(`归还 ${result.restored + result.pending} 份：${parts.join('；') || '无变化'}`)
      setWarning('')
      setReturnPicks([])
    } catch (error) {
      setWarning(
        error instanceof LoanValidationError
          ? error.message
          : '归还写入失败，已恢复借出状态与待归还清单，可直接重试（不会产生重复记录）'
      )
    }
  }

  const renderLoanState = (loan: Loan): JSX.Element => (
    <span className="text-slate-400">
      原柜位 {encodeSlot(loan.originCabinet, loan.originDrawer, loan.originBox, loan.originSlot)} · 借于 {loan.loanDate} · 期限{' '}
      {loan.dueDate}
      {loan.state === '外借中' && loan.dueDate < today ? <b className="text-rose-600">（已逾期）</b> : null}
      {loan.returnedDate ? ` · 归还于 ${loan.returnedDate}` : ''}
    </span>
  )

  return (
    <div className="flex flex-col gap-5">
      <header>
        <h1 className="page-title">保藏柜位图</h1>
        <p className="page-sub">
          按柜—抽屉—盒三级展开插位；勾选多份在库标本可整批外借并释放柜位，归还时原柜位空着自动放回、被占用则进待归位区。
        </p>
      </header>

      <section className="panel flex flex-wrap items-end gap-3">
        <div>
          <span className="field-label">标本柜编号</span>
          <input className="field-input w-28" value={cabinet} onChange={(e) => setCabinet(e.target.value.toUpperCase())} />
        </div>
        <div>
          <span className="field-label">抽屉数</span>
          <input type="number" min={1} max={8} className="field-input w-20" value={drawers} onChange={(e) => setDrawers(Math.max(1, Number(e.target.value) || 1))} />
        </div>
        <div>
          <span className="field-label">每屉盒数</span>
          <input type="number" min={1} max={8} className="field-input w-20" value={boxes} onChange={(e) => setBoxes(Math.max(1, Number(e.target.value) || 1))} />
        </div>
        <div>
          <span className="field-label">每盒插位</span>
          <input type="number" min={1} max={20} className="field-input w-20" value={slots} onChange={(e) => setSlots(Math.max(1, Number(e.target.value) || 1))} />
        </div>
        <div>
          <span className="field-label">保藏方式</span>
          <select className="field-input w-28" value={method} onChange={(e) => setMethod(e.target.value as StorageMethod)}>
            {STORAGE_METHODS.map((item) => (
              <option key={item} value={item}>
                {item}
              </option>
            ))}
          </select>
        </div>
        <div>
          <span className="field-label">经手人</span>
          <input className="field-input w-32" value={handler} onChange={(e) => setHandler(e.target.value)} placeholder="如 覃羽" />
        </div>
        <div className="text-xs text-slate-500">
          在库 {inCabinet.length} · 外借中 {activeLoans.length} · 待归位 {pendingLoans.length} · 未入柜 {unplaced.length}
          {picked ? ` · 当前选中 ${codeOf(picked)}` : ''}
        </div>
      </section>

      {warning ? <p className="rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-800">{warning}</p> : null}
      {message ? <p className="rounded-lg border border-field-100 bg-field-50 px-3 py-2 text-sm text-field-700">{message}</p> : null}

      <section className="grid gap-4 lg:grid-cols-[1fr_340px]">
        <CabinetGrid
          cabinet={cabinet}
          drawers={drawers}
          boxes={boxes}
          slots={slots}
          storages={storages}
          marks={marks}
          codeOf={codeOf}
          draggingCode={dragging ? codeOf(dragging) : picked ? codeOf(picked) : null}
          onDropSlot={(position) => void place(position)}
          onPickStorage={(storage) => setDetail(storage)}
          onPickMark={(mark) => {
            setWarning(
              mark.kind === '外借中'
                ? `${mark.code} 外借中：${mark.hint}；原柜位已释放并保留归属，归还前不可入柜或新增鉴定`
                : `${mark.code} 处于待归位区，保留原柜位${mark.occupiedBy ? `（已被 ${mark.occupiedBy} 占用，不挤出现有标本）` : '（现仍空着，可在右侧待归位区一键放回）'}`
            )
            setDetail(null)
          }}
        />

        <div className="flex flex-col gap-4">
          {/* 整批外借登记 */}
          <div className="panel">
            <h2 className="text-sm font-semibold text-slate-700">整批外借登记（勾选在库标本）</h2>
            <div className="mt-2 grid grid-cols-2 gap-2">
              <div className="col-span-2">
                <span className="field-label">借用人 / 单位</span>
                <input className="field-input" value={borrower} onChange={(e) => setBorrower(e.target.value)} placeholder="如 省昆虫研究所标本馆" />
              </div>
              <div>
                <span className="field-label">借出日期</span>
                <input type="date" className="field-input" value={loanDate} onChange={(e) => setLoanDate(e.target.value)} />
              </div>
              <div>
                <span className="field-label">归还期限</span>
                <input type="date" className="field-input" value={dueDate} onChange={(e) => setDueDate(e.target.value)} />
              </div>
              <div className="col-span-2">
                <span className="field-label">经手人</span>
                <input className="field-input" value={loanHandler} onChange={(e) => setLoanHandler(e.target.value)} placeholder="默认同柜位图经手人" />
              </div>
            </div>
            <div className="mt-2 max-h-56 space-y-1.5 overflow-auto rounded-lg border border-slate-100 p-2">
              {inCabinet.map((specimen) => (
                <label
                  key={specimen.id}
                  className={`flex cursor-pointer items-center gap-2 rounded-lg border px-2 py-1.5 text-xs transition ${
                    loanPicks.includes(specimen.id) ? 'border-orange-400 bg-orange-50' : 'border-slate-200 hover:bg-slate-50'
                  }`}
                >
                  <input
                    type="checkbox"
                    className="h-4 w-4 accent-orange-500"
                    checked={loanPicks.includes(specimen.id)}
                    onChange={() => toggleLoanPick(specimen.id)}
                  />
                  <span className="flex-1">
                    <span className="font-mono text-field-700">{specimen.code}</span>
                    <span className="ml-2 text-slate-600">{specimenTaxon(specimen)}</span>
                    <span className="block text-slate-400">
                      {storageSlotText(custody.storageBySpecimen.get(specimen.id)!)} · {siteName(specimen.siteId)}
                    </span>
                  </span>
                </label>
              ))}
              {inCabinet.length === 0 ? <p className="text-xs text-slate-400">暂无可外借的在库标本</p> : null}
            </div>
            <button className="btn-primary mt-2 w-full justify-center" type="button" disabled={loanBusy} onClick={() => void confirmCheckout()}>
              {loanBusy ? '提交中…' : `确认外借 ${loanPicks.length} 份（记录借用人/期限/原柜位并释放柜位）`}
            </button>
          </div>

          {/* 外借中：登记归还 */}
          <div className="panel">
            <h2 className="flex items-center justify-between text-sm font-semibold text-slate-700">
              外借中（{activeLoans.length}）
              <label className="flex items-center gap-1 text-xs font-normal text-slate-500">
                归还日期
                <input type="date" className="field-input w-36 py-1" value={returnedDate} onChange={(e) => setReturnedDate(e.target.value)} />
              </label>
            </h2>
            <div className="mt-2 max-h-56 space-y-1.5 overflow-auto">
              {activeLoans.map((loan) => (
                <label
                  key={loan.id}
                  className={`flex cursor-pointer items-start gap-2 rounded-lg border px-2 py-1.5 text-xs ${
                    returnPicks.includes(loan.id) ? 'border-orange-400 bg-orange-50' : 'border-slate-200'
                  }`}
                >
                  <input
                    type="checkbox"
                    className="mt-0.5 h-4 w-4 accent-orange-500"
                    checked={returnPicks.includes(loan.id)}
                    onChange={() => toggleReturnPick(loan.id)}
                  />
                  <span className="flex-1">
                    <span className="font-mono text-field-700">{codeOf(loan.specimenId)}</span>
                    <span className="ml-2 text-slate-700">{loan.borrower}</span>
                    <span className="block">{renderLoanState(loan)}</span>
                  </span>
                </label>
              ))}
              {activeLoans.length === 0 ? <p className="text-xs text-slate-400">当前没有外借中的标本</p> : null}
            </div>
            <button className="btn-primary mt-2 w-full justify-center" type="button" onClick={() => void confirmReturn()}>
              登记归还 {returnPicks.length} 份（原柜位空则放回，否则进待归位区）
            </button>
          </div>

          {/* 待归位区 */}
          <div className="panel border-amber-300">
            <h2 className="text-sm font-semibold text-amber-800">待归位区（{pendingLoans.length}）</h2>
            <div className="mt-2 max-h-56 space-y-2 overflow-auto">
              {pendingLoans.map((loan) => {
                const originKey = slotKeyOf(loan.originCabinet, loan.originDrawer, loan.originBox, loan.originSlot)
                const occupant = storages.find(
                  (storage) => slotKeyOf(storage.cabinet, storage.drawer, storage.box, storage.slot) === originKey
                )
                return (
                  <div key={loan.id} className="rounded-lg border border-amber-200 bg-amber-50/60 px-2 py-1.5 text-xs">
                    <p>
                      <span className="font-mono text-field-700">{codeOf(loan.specimenId)}</span>
                      <span className="ml-2 text-slate-600">
                        {(() => {
                          const sp = specimens.find((item) => item.id === loan.specimenId)
                          return sp ? specimenTaxon(sp) : '标本已删除'
                        })()}
                      </span>
                    </p>
                    <p className="text-slate-500">
                      原柜位 {encodeSlot(loan.originCabinet, loan.originDrawer, loan.originBox, loan.originSlot)}
                      {occupant ? (
                        <b className="text-rose-600"> 已被 {codeOf(occupant.specimenId)} 占用，不挤出现有标本</b>
                      ) : (
                        <span className="text-emerald-600"> 现仍空着</span>
                      )}
                    </p>
                    <p className="text-slate-400">
                      {loan.borrower} · 归还于 {loan.returnedDate} · 鉴定状态{' '}
                      <StatusTag status={specimens.find((sp) => sp.id === loan.specimenId)?.status ?? '待鉴定'} />
                    </p>
                    <div className="mt-1 flex gap-2">
                      <button className="btn-ghost px-2 py-1" type="button" disabled={Boolean(occupant)} onClick={() => void restoreToOrigin(loan)}>
                        放回原柜位
                      </button>
                      <button
                        className="btn-ghost px-2 py-1"
                        type="button"
                        onClick={() => {
                          setPicked(loan.specimenId)
                          setDragging(null)
                          setMethod((loan.originMethod as StorageMethod) || method)
                          setForceSlotKey('')
                          setWarning(`已选中 ${codeOf(loan.specimenId)}，点击左侧任一空插位完成归位（不会挤掉现有标本）`)
                        }}
                      >
                        选到插位
                      </button>
                    </div>
                  </div>
                )
              })}
              {pendingLoans.length === 0 ? <p className="text-xs text-slate-400">待归位区为空</p> : null}
            </div>
          </div>

          {/* 未入柜 / 可拖放入柜 */}
          <div className="panel">
            <h2 className="text-sm font-semibold text-slate-700">未入柜标本（拖到插位）</h2>
            <div className="mt-2 max-h-56 space-y-2 overflow-auto">
              {unplaced.map((specimen) => (
                <div
                  key={specimen.id}
                  draggable
                  onDragStart={() => {
                    setDragging(specimen.id)
                    setForceSlotKey('')
                  }}
                  onDragEnd={() => setDragging(null)}
                  onClick={() => {
                    setPicked(specimen.id)
                    setForceSlotKey('')
                  }}
                  className={`cursor-grab rounded-lg border px-3 py-2 text-xs transition ${
                    picked === specimen.id ? 'border-field-500 bg-field-50' : 'border-slate-200 hover:bg-slate-50'
                  }`}
                >
                  <p className="font-mono text-field-700">{specimen.code}</p>
                  <p className="text-slate-600">{specimenTaxon(specimen)}</p>
                  <p className="text-slate-400">
                    {siteName(specimen.siteId)} · <StatusTag status={specimen.status} />
                  </p>
                </div>
              ))}
              {unplaced.length === 0 ? <p className="text-xs text-slate-400">没有未入柜标本</p> : null}
            </div>
          </div>

          {/* 在柜明细 */}
          <div className="panel">
            <h2 className="text-sm font-semibold text-slate-700">在柜明细（{storages.length}）</h2>
            <ul className="mt-2 space-y-1.5 text-xs">
              {storages.map((storage) => (
                <li key={storage.id} className="flex items-center justify-between gap-2 rounded-lg border border-slate-200 px-2 py-1.5">
                  <span>
                    <span className="font-mono text-field-700">{storageSlotText(storage)}</span>
                    <span className="ml-2 text-slate-600">{codeOf(storage.specimenId)}</span>
                    <span className="ml-1 text-slate-400">{storage.method}</span>
                  </span>
                  <button className="btn-danger" type="button" onClick={() => void takeOut(storage)}>
                    出柜
                  </button>
                </li>
              ))}
              {storages.length === 0 ? <li className="text-slate-400">暂无在柜记录</li> : null}
            </ul>
          </div>

          {detail ? (
            <div className="panel">
              <h2 className="text-sm font-semibold text-slate-700">插位明细</h2>
              <p className="mt-1 text-xs text-slate-600">
                柜位 {storageSlotText(detail)} · {detail.method} · 入柜日期 {detail.storedDate} · 经手人{' '}
                {detail.handler || '—'}
              </p>
              <p className="text-xs text-slate-600">
                标本：{codeOf(detail.specimenId)} · <CustodyTag status={statusOf(detail.specimenId)} />
              </p>
              <button className="btn-ghost mt-2" type="button" onClick={() => setDetail(null)}>
                关闭
              </button>
            </div>
          ) : null}
        </div>
      </section>
    </div>
  )
}
