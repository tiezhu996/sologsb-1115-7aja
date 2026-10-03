import { useMemo, useState } from 'react'
import type { Loan, Storage, StorageMethod, CustodyStatus } from '@/types'
import { STORAGE_METHODS } from '@/types'
import CabinetGrid from '@/components/common/CabinetGrid'
import CustodyTag from '@/components/common/CustodyTag'
import StatusTag from '@/components/common/StatusTag'
import { usePersistentStore } from '@/hooks/usePersistentStore'
import { specimenStore } from '@/stores/specimenStore'
import { storageStore } from '@/stores/storageStore'
import { siteStore } from '@/stores/siteStore'
import { loanStore } from '@/stores/loanStore'
import { custodyOf, isOverdue, latestLoanOf, loanOriginText, originSlotTaken } from '@/utils/custody'
import { encodeSlot, findSlotConflicts, specimenTaxon, storageSlotText } from '@/utils/codec'
import { uid } from '@/utils/id'

/** 保藏柜位图：柜-抽屉-盒-位三级展开，拖拽入柜；接入整批标本借出/归还/待归位流程 */
export default function StoragePage(): JSX.Element {
  const specimens = usePersistentStore(specimenStore, (state) => state.rows)
  const storages = usePersistentStore(storageStore, (state) => state.rows)
  const sites = usePersistentStore(siteStore, (state) => state.rows)
  const loans = usePersistentStore(loanStore, (state) => state.rows)

  const [cabinet, setCabinet] = useState('C01')
  const [drawers, setDrawers] = useState(2)
  const [boxes, setBoxes] = useState(3)
  const [slots, setSlots] = useState(8)
  const [method, setMethod] = useState<StorageMethod>('针插')
  const [handler, setHandler] = useState('')
  const [picked, setPicked] = useState('')
  const [dragging, setDragging] = useState<string | null>(null)
  /** 待归位标本点「放入新柜位」后进入归位模式，目标插位走借还归位动作 */
  const [rehousingId, setRehousingId] = useState<string | null>(null)
  const [message, setMessage] = useState('')
  const [warning, setWarning] = useState('')
  const [detail, setDetail] = useState<Storage | null>(null)

  // 借出办理
  const [loanPickOpen, setLoanPickOpen] = useState(false)
  const [loanPickIds, setLoanPickIds] = useState<string[]>([])
  const [borrower, setBorrower] = useState('')
  const [loanDate, setLoanDate] = useState(new Date().toISOString().slice(0, 10))
  const [dueDate, setDueDate] = useState('')
  const [loanNote, setLoanNote] = useState('')
  const [loanBusy, setLoanBusy] = useState(false)
  const [loanBatchId, setLoanBatchId] = useState('')

  // 归还办理
  const [returnDate, setReturnDate] = useState(new Date().toISOString().slice(0, 10))
  const [returnHandler, setReturnHandler] = useState('')
  const [returnBusy, setReturnBusy] = useState(false)

  const codeOf = (specimenId: string): string => specimens.find((item) => item.id === specimenId)?.code ?? '未知标本'
  const siteName = (siteId: string): string => sites.find((site) => site.id === siteId)?.name ?? '未关联采集地'
  const custodyMap = useMemo(() => {
    const map = new Map<string, CustodyStatus>()
    specimens.forEach((item) => map.set(item.id, custodyOf(loans, item.id)))
    return map
  }, [specimens, loans])
  const loanOf = (specimenId: string): Loan | undefined => latestLoanOf(loans, specimenId)

  const placedIds = useMemo(() => new Set(storages.map((item) => item.specimenId)), [storages])
  // 在库且未入柜：可拖入插位、可借出
  const unplaced = specimens.filter((item) => !placedIds.has(item.id) && custodyMap.get(item.id) === '在库')
  // 归还后原柜位被占、暂存待归位区
  const awaitingList = specimens.filter((item) => custodyMap.get(item.id) === '待归位')
  // 外借中
  const activeList = specimens.filter((item) => custodyMap.get(item.id) === '外借中')
  const storedCount = specimens.filter((item) => custodyMap.get(item.id) === '在库' && placedIds.has(item.id)).length

  const toggleLoanPick = (id: string): void => {
    setLoanPickIds((prev) => (prev.includes(id) ? prev.filter((item) => item !== id) : [...prev, id]))
  }

  const openLoanPick = (preset: string[] = []): void => {
    setLoanPickIds(preset)
    setBorrower('')
    setLoanDate(new Date().toISOString().slice(0, 10))
    setDueDate('')
    setLoanNote('')
    setWarning('')
    // 每次重新打开换一个批次号；同一面板内重试保持同一批次号 → 借据 id 确定化，不产生重复记录
    setLoanBatchId(uid('batch'))
    setLoanPickOpen(true)
  }

  const submitCheckout = async (): Promise<void> => {
    const valid = loanPickIds.filter((id) => custodyMap.get(id) === '在库')
    if (valid.length === 0) {
      setWarning('请至少勾选一份在库标本（外借中/待归位标本不能重复借出）')
      return
    }
    if (!borrower.trim()) {
      setWarning('请填写借用人 / 借入单位')
      return
    }
    if (!loanDate || !dueDate) {
      setWarning('请填写借出日期与应还期限')
      return
    }
    if (dueDate < loanDate) {
      setWarning('应还期限不能早于借出日期')
      return
    }
    setWarning('')
    setLoanBusy(true)
    try {
      const result = await loanStore.getState().checkout({
        specimenIds: valid,
        borrower: borrower.trim(),
        loanDate,
        dueDate,
        handler: handler.trim(),
        note: loanNote.trim(),
        batchId: loanBatchId
      })
      const parts = [`已为 ${result.checkedOut.length} 份标本登记外借并释放柜位，借用人：${borrower.trim()}`]
      if (result.skipped.length > 0) {
        parts.push(`跳过 ${result.skipped.length} 份（${result.skipped.map((s) => `${codeOf(s.specimenId)} ${s.reason}`).join('、')}）`)
      }
      setMessage(parts.join('；'))
      setLoanPickOpen(false)
      setLoanPickIds([])
      setPicked('')
      setDragging(null)
    } catch (error) {
      // 写入失败：事务已回滚，原柜位/借出状态/待归还清单保持不变；保留面板与同一批次号供重试
      setWarning(`外借登记写入失败，已恢复原状，可直接重试：${error instanceof Error ? error.message : String(error)}`)
    } finally {
      setLoanBusy(false)
    }
  }

  const submitReturn = async (presetIds?: string[]): Promise<void> => {
    const ids = presetIds ?? activeList.map((item) => item.id)
    if (ids.length === 0) {
      setWarning('没有外借中的标本需要归还')
      return
    }
    if (!returnDate) {
      setWarning('请填写归还日期')
      return
    }
    setWarning('')
    setReturnBusy(true)
    try {
      const result = await loanStore.getState().returnLoans(ids, returnDate, returnHandler.trim())
      const parts: string[] = []
      if (result.restored.length > 0) parts.push(`${result.restored.length} 份已放回原柜位`)
      if (result.awaiting.length > 0) {
        parts.push(`${result.awaiting.length} 份原柜位被占用，已进入待归位区（原柜位保留，未挤出现有标本）`)
      }
      if (result.skipped.length > 0) {
        parts.push(`跳过 ${result.skipped.length} 份（${result.skipped.map((s) => `${codeOf(s.specimenId)} ${s.reason}`).join('、')}）`)
      }
      setMessage(parts.join('；') || '没有需要归还的标本')
    } catch (error) {
      // 归还写入失败：借据仍为外借中、柜位未改动、待归位清单未变，可直接重试
      setWarning(`归还写入失败，已恢复原状，可直接重试：${error instanceof Error ? error.message : String(error)}`)
    } finally {
      setReturnBusy(false)
    }
  }

  const restoreOrigin = async (specimenId: string): Promise<void> => {
    const loan = loanOf(specimenId)
    if (!loan || !loan.originCabinet) {
      setWarning('该标本借出时未入柜，没有原柜位可放回')
      return
    }
    setWarning('')
    try {
      await loanStore.getState().rehouse({
        specimenId,
        method: loan.originMethod === '' ? method : loan.originMethod,
        cabinet: loan.originCabinet,
        drawer: loan.originDrawer,
        box: loan.originBox,
        slot: loan.originSlot,
        storedDate: new Date().toISOString().slice(0, 10),
        handler: returnHandler.trim() || handler.trim()
      })
      setMessage(`${codeOf(specimenId)} 已放回原柜位 ${loanOriginText(loan)}`)
    } catch (error) {
      setWarning(`放回失败，状态未改变：${error instanceof Error ? error.message : String(error)}`)
    }
  }

  const place = async (position: { cabinet: string; drawer: number; box: number; slot: number }): Promise<void> => {
    // 待归位标本落插位 → 走借还归位
    if (rehousingId) {
      const origin = loanOf(rehousingId)
      const usingMethod: StorageMethod = origin?.originMethod ? origin.originMethod : method
      try {
        await loanStore.getState().rehouse({
          specimenId: rehousingId,
          method: usingMethod,
          cabinet: position.cabinet,
          drawer: position.drawer,
          box: position.box,
          slot: position.slot,
          storedDate: new Date().toISOString().slice(0, 10),
          handler: handler.trim()
        })
        setMessage(`${codeOf(rehousingId)} 已入柜 ${encodeSlot(position.cabinet, position.drawer, position.box, position.slot)}，退出待归位`)
        setRehousingId(null)
      } catch (error) {
        setWarning(`归位失败：${error instanceof Error ? error.message : String(error)}`)
      }
      return
    }

    const specimenId = dragging ?? picked
    if (!specimenId) {
      setWarning('请先在右侧选择或拖动一份在库未入柜标本')
      return
    }
    const custody = custodyMap.get(specimenId)
    if (custody !== '在库') {
      setWarning(`${codeOf(specimenId)} 当前为「${custody}」，${custody === '待归位' ? '请用待归位区的「放入新柜位」' : '归还前不能入柜'}`)
      return
    }
    const candidate: Storage = {
      id: storages.find((item) => item.specimenId === specimenId)?.id ?? uid('stg'),
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
    setWarning('')
    try {
      await storageStore.getState().save(candidate)
      setMessage(`${codeOf(specimenId)} 已入柜 ${storageSlotText(candidate)}`)
      setPicked('')
      setDragging(null)
    } catch (error) {
      setWarning(`入柜失败：${error instanceof Error ? error.message : String(error)}`)
    }
  }

  const takeOut = async (storage: Storage): Promise<void> => {
    await storageStore.getState().remove(storage.id)
    setMessage(`${codeOf(storage.specimenId)} 已从 ${storageSlotText(storage)} 出柜`)
    setDetail(null)
  }

  const draggingCode = rehousingId
    ? `${codeOf(rehousingId)}（待归位）`
    : dragging
      ? codeOf(dragging)
      : picked
        ? codeOf(picked)
        : null

  return (
    <div className="flex flex-col gap-5">
      <header>
        <h1 className="page-title">保藏柜位图</h1>
        <p className="page-sub">
          按柜—抽屉—盒三级展开插位，空位虚线显示；多选在库标本可整批确认外借（登记借用人、期限并释放原柜位），
          归还时原柜位空着自动放回、被占用则进待归位区且不挤出现有标本。
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
          在柜 {storedCount} 份 · 未入柜 {unplaced.length} 份 · 外借中 {activeList.length} 份 · 待归位 {awaitingList.length} 份
          {picked ? ` · 当前选中 ${codeOf(picked)}` : ''}
        </div>
      </section>

      {warning ? <p className="rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-800" data-testid="loan-warning">{warning}</p> : null}
      {message ? <p className="rounded-lg border border-field-100 bg-field-50 px-3 py-2 text-sm text-field-700" data-testid="loan-message">{message}</p> : null}

      <section className="grid gap-4 lg:grid-cols-[1fr_340px]">
        <CabinetGrid
          cabinet={cabinet}
          drawers={drawers}
          boxes={boxes}
          slots={slots}
          storages={storages}
          codeOf={codeOf}
          draggingCode={draggingCode}
          onDropSlot={(position) => void place(position)}
          onPickStorage={(storage) => {
            if (rehousingId) {
              setWarning(`柜位 ${storageSlotText(storage)} 已被 ${codeOf(storage.specimenId)} 占用，请点一个空插位`)
              return
            }
            setDetail(storage)
          }}
        />

        <div className="flex flex-col gap-4">
          <div className="panel">
            <div className="flex items-center justify-between">
              <h2 className="text-sm font-semibold text-slate-700">在库未入柜（拖到插位 / 勾选外借）</h2>
              <button
                className="btn-primary px-2 py-1 text-xs"
                type="button"
                onClick={() => openLoanPick(specimens.filter((item) => custodyMap.get(item.id) === '在库').map((item) => item.id))}
              >
                整批外借
              </button>
            </div>
            <div className="mt-2 max-h-60 space-y-2 overflow-auto">
              {unplaced.map((specimen) => (
                <div
                  key={specimen.id}
                  draggable
                  onDragStart={() => {
                    setDragging(specimen.id)
                    setRehousingId(null)
                  }}
                  onDragEnd={() => setDragging(null)}
                  onClick={() => {
                    setPicked(specimen.id)
                    setRehousingId(null)
                  }}
                  className={`cursor-grab rounded-lg border px-3 py-2 text-xs transition ${
                    picked === specimen.id ? 'border-field-500 bg-field-50' : 'border-slate-200 hover:bg-slate-50'
                  }`}
                >
                  <p className="flex items-center justify-between">
                    <span className="font-mono text-field-700">{specimen.code}</span>
                    <label className="inline-flex items-center gap-1 text-slate-500" onClick={(e) => e.stopPropagation()}>
                      <input
                        type="checkbox"
                        className="h-3.5 w-3.5 accent-field-600"
                        checked={loanPickIds.includes(specimen.id)}
                        onChange={() => toggleLoanPick(specimen.id)}
                      />
                      外借
                    </label>
                  </p>
                  <p className="text-slate-600">{specimenTaxon(specimen)}</p>
                  <p className="text-slate-400">
                    {siteName(specimen.siteId)} · <StatusTag status={specimen.status} />
                  </p>
                </div>
              ))}
              {unplaced.length === 0 ? <p className="text-xs text-slate-400">没有在库未入柜标本</p> : null}
            </div>
            {loanPickIds.length > 0 ? (
              <button className="btn-primary mt-2 w-full py-1.5 text-xs" type="button" onClick={() => openLoanPick(loanPickIds)}>
                确认外借所选 {loanPickIds.length} 份
              </button>
            ) : null}
          </div>

          <div className="panel" data-testid="awaiting-panel">
            <h2 className="text-sm font-semibold text-amber-700">待归位区（{awaitingList.length}）</h2>
            <p className="mt-0.5 text-[11px] text-slate-400">归还时原柜位被占，原柜位已保留；空出后可一键放回，也可改放新插位</p>
            <div className="mt-2 max-h-60 space-y-2 overflow-auto">
              {awaitingList.map((specimen) => {
                const loan = loanOf(specimen.id)
                const origin = loan ? loanOriginText(loan) : ''
                const taken = loan ? originSlotTaken(loan, storages) : false
                return (
                  <div
                    key={specimen.id}
                    draggable
                    onDragStart={() => {
                      setDragging(null)
                      setPicked('')
                      setRehousingId(specimen.id)
                    }}
                    onDragEnd={() => undefined}
                    className="cursor-grab rounded-lg border border-amber-200 bg-amber-50/50 px-3 py-2 text-xs hover:bg-amber-50"
                  >
                    <p className="flex items-center justify-between">
                      <span className="font-mono text-amber-800">{specimen.code}</span>
                      <CustodyTag status="待归位" />
                    </p>
                    <p className="mt-0.5 text-slate-600">
                      原柜位 <span className="font-mono">{origin || '（借出时未入柜）'}</span>
                      {origin ? (taken ? ' · 仍被占用' : ' · 已空出') : ''}
                    </p>
                    <p className="text-slate-400">
                      借自 {loan?.borrower || '—'} · 归还日 {loan?.returnedDate || '—'}
                    </p>
                    <div className="mt-1.5 flex gap-2">
                      <button
                        className="btn-ghost px-2 py-0.5 text-[11px]"
                        type="button"
                        disabled={taken || !origin}
                        title={!origin ? '借出时未入柜，无原柜位可放回' : taken ? '原柜位仍被占用' : '放回原柜位'}
                        onClick={() => void restoreOrigin(specimen.id)}
                      >
                        放回原柜位
                      </button>
                      <button
                        className={`btn-ghost px-2 py-0.5 text-[11px] ${rehousingId === specimen.id ? 'border-field-500 bg-field-50 text-field-700' : ''}`}
                        type="button"
                        title="进入归位模式后，点击柜位图任一空插位"
                        onClick={() => {
                          setDragging(null)
                          setPicked('')
                          setRehousingId((prev) => (prev === specimen.id ? null : specimen.id))
                        }}
                      >
                        {rehousingId === specimen.id ? '请点击目标插位…' : '放入新柜位'}
                      </button>
                    </div>
                  </div>
                )
              })}
              {awaitingList.length === 0 ? <p className="text-xs text-slate-400">暂无待归位标本</p> : null}
            </div>
          </div>

          <div className="panel" data-testid="active-loan-panel">
            <div className="flex items-center justify-between">
              <h2 className="text-sm font-semibold text-violet-700">外借中（{activeList.length}）</h2>
              <button className="btn-primary px-2 py-1 text-xs" type="button" disabled={returnBusy || activeList.length === 0} onClick={() => void submitReturn()}>
                全部归还
              </button>
            </div>
            <div className="mt-2 max-h-60 space-y-2 overflow-auto">
              {activeList.map((specimen) => {
                const loan = loanOf(specimen.id)
                return (
                  <div key={specimen.id} className="rounded-lg border border-violet-200 px-3 py-2 text-xs">
                    <p className="flex items-center justify-between">
                      <span className="font-mono text-violet-800">{specimen.code}</span>
                      <CustodyTag status="外借中" overdue={loan ? isOverdue(loan) : false} />
                    </p>
                    <p className="mt-0.5 text-slate-600">
                      {loan?.borrower || '—'} · 期限 {loan?.dueDate || '—'}
                    </p>
                    <p className="text-slate-400">
                      原柜位 <span className="font-mono">{loan ? loanOriginText(loan) || '借出时未入柜' : ''}</span>
                    </p>
                    <button className="btn-ghost mt-1 px-2 py-0.5 text-[11px]" type="button" onClick={() => void submitReturn([specimen.id])}>
                      归还
                    </button>
                  </div>
                )
              })}
              {activeList.length === 0 ? <p className="text-xs text-slate-400">当前没有外借中的标本</p> : null}
            </div>
            <div className="mt-2 flex flex-wrap items-end gap-2">
              <div>
                <span className="field-label">归还日期</span>
                <input type="date" className="field-input w-36" value={returnDate} onChange={(e) => setReturnDate(e.target.value)} />
              </div>
              <div>
                <span className="field-label">归还经手人</span>
                <input className="field-input w-28" value={returnHandler} onChange={(e) => setReturnHandler(e.target.value)} placeholder="默认沿用借出经手人" />
              </div>
            </div>
          </div>

          <div className="panel">
            <div className="flex items-center justify-between">
              <h2 className="text-sm font-semibold text-slate-700">已入柜明细（{storages.length}）</h2>
              {loanPickIds.length > 0 ? (
                <button className="btn-primary px-2 py-1 text-xs" type="button" onClick={() => openLoanPick(loanPickIds)}>
                  外借所选 {loanPickIds.length} 份
                </button>
              ) : null}
            </div>
            <ul className="mt-2 max-h-56 space-y-1.5 overflow-auto text-xs">
              {storages.map((storage) => (
                <li key={storage.id} className="flex items-center justify-between gap-2 rounded-lg border border-slate-200 px-2 py-1.5">
                  <span>
                    <span className="font-mono text-field-700">{storageSlotText(storage)}</span>
                    <span className="ml-2 text-slate-600">{codeOf(storage.specimenId)}</span>
                    <span className="ml-1 text-slate-400">{storage.method}</span>
                  </span>
                  <span className="inline-flex items-center gap-2">
                    <label className="inline-flex items-center gap-1 text-[11px] text-violet-600">
                      <input
                        type="checkbox"
                        className="h-3.5 w-3.5 accent-violet-600"
                        checked={loanPickIds.includes(storage.specimenId)}
                        onChange={() => toggleLoanPick(storage.specimenId)}
                      />
                      借出
                    </label>
                    <button className="btn-danger" type="button" onClick={() => void takeOut(storage)}>
                      出柜
                    </button>
                  </span>
                </li>
              ))}
              {storages.length === 0 ? <li className="text-slate-400">暂无入柜记录</li> : null}
            </ul>
          </div>

          {detail ? (
            <div className="panel">
              <h2 className="text-sm font-semibold text-slate-700">插位明细</h2>
              <p className="mt-1 text-xs text-slate-600">
                柜位 {storageSlotText(detail)} · {detail.method} · 入柜日期 {detail.storedDate} · 经手人{' '}
                {detail.handler || '—'}
              </p>
              <p className="text-xs text-slate-600">标本：{codeOf(detail.specimenId)}</p>
              <button className="btn-ghost mt-2" type="button" onClick={() => setDetail(null)}>
                关闭
              </button>
            </div>
          ) : null}
        </div>
      </section>

      {loanPickOpen ? (
        <div className="fixed inset-0 z-20 flex items-center justify-center bg-slate-900/40 p-4" role="dialog" aria-modal="true">
          <div className="w-full max-w-2xl rounded-2xl bg-white p-5 shadow-xl" data-testid="loan-dialog">
            <h2 className="text-base font-semibold text-slate-800">确认外借（{loanPickIds.filter((id) => custodyMap.get(id) === '在库').length} 份在库标本）</h2>
            <div className="mt-3 grid gap-3 md:grid-cols-2">
              <div className="md:col-span-2">
                <span className="field-label">借用人 / 借入单位</span>
                <input className="field-input" value={borrower} onChange={(e) => setBorrower(e.target.value)} placeholder="如 省林科院昆虫研究所" />
              </div>
              <div>
                <span className="field-label">借出日期</span>
                <input type="date" className="field-input" value={loanDate} onChange={(e) => setLoanDate(e.target.value)} />
              </div>
              <div>
                <span className="field-label">应还期限</span>
                <input type="date" className="field-input" value={dueDate} onChange={(e) => setDueDate(e.target.value)} />
              </div>
              <div className="md:col-span-2">
                <span className="field-label">外借备注</span>
                <input className="field-input" value={loanNote} onChange={(e) => setLoanNote(e.target.value)} placeholder="如 比对模式标本，整批外借" />
              </div>
            </div>
            <div className="mt-3 max-h-44 overflow-auto rounded-lg border border-slate-200">
              <table className="w-full text-xs">
                <thead className="bg-slate-50 text-slate-500">
                  <tr>
                    <th className="px-2 py-1 text-left">标本编号</th>
                    <th className="px-2 py-1 text-left">当前柜位</th>
                    <th className="px-2 py-1 text-left">保管状态</th>
                  </tr>
                </thead>
                <tbody>
                  {loanPickIds.map((id) => {
                    const storage = storages.find((item) => item.specimenId === id)
                    const status = custodyMap.get(id) ?? '在库'
                    return (
                      <tr key={id} className="border-t border-slate-100">
                        <td className="px-2 py-1 font-mono">
                          <label className="inline-flex items-center gap-1.5">
                            <input
                              type="checkbox"
                              className="h-3.5 w-3.5 accent-field-600"
                              checked
                              onChange={() => toggleLoanPick(id)}
                            />
                            {codeOf(id)}
                          </label>
                        </td>
                        <td className="px-2 py-1 font-mono text-slate-500">{storage ? storageSlotText(storage) : '未入柜'}</td>
                        <td className="px-2 py-1">
                          <CustodyTag status={status} />
                          {status !== '在库' ? <span className="ml-1 text-rose-500">将跳过</span> : null}
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
            <div className="mt-4 flex justify-end gap-2">
              <button className="btn-ghost" type="button" disabled={loanBusy} onClick={() => setLoanPickOpen(false)}>
                取消
              </button>
              <button className="btn-primary" type="button" disabled={loanBusy} data-testid="loan-confirm" onClick={() => void submitCheckout()}>
                {loanBusy ? '提交中…' : '确认外借并释放柜位'}
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  )
}
