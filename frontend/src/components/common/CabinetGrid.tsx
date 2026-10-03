import type { ReactNode } from 'react'
import type { Storage } from '@/types'
import { encodeSlot } from '@/utils/codec'

/** 释放柜位上的借还标记：外借中（空着但保留归属）/ 待归位（归还后等放回） */
export interface SlotMark {
  cabinet: string
  drawer: number
  box: number
  slot: number
  kind: '外借中' | '待归位'
  /** 外借 / 待归位的标本 ID */
  specimenId: string
  /** 标本编号 */
  code: string
  /** 借用人或占用提示 */
  hint: string
  /** 待归位且原柜位已被别人占用时，提示现占用标本 */
  occupiedBy?: string
}

export interface CabinetGridProps {
  cabinet: string
  drawers: number
  boxes: number
  slots: number
  storages: Storage[]
  /** 每个标本编号，用于显示占用 */
  codeOf: (specimenId: string) => string
  /** 当前拖拽中的标本编号 */
  draggingCode: string | null
  /** 已释放柜位上的借还标记 */
  marks?: SlotMark[]
  /** 点击或拖放到某个插位 */
  onDropSlot: (payload: { cabinet: string; drawer: number; box: number; slot: number }) => void
  onPickStorage?: (storage: Storage) => void
  /** 点击借还标记（外借中 / 待归位） */
  onPickMark?: (mark: SlotMark) => void
  footer?: ReactNode
}

/** 柜位网格：柜 → 抽屉 → 盒 → 插位，插位作为拖放目标 */
export default function CabinetGrid({
  cabinet,
  drawers,
  boxes,
  slots,
  storages,
  codeOf,
  draggingCode,
  marks = [],
  onDropSlot,
  onPickStorage,
  onPickMark,
  footer
}: CabinetGridProps): JSX.Element {
  const drawerList = Array.from({ length: drawers }, (_, index) => index + 1)
  const boxList = Array.from({ length: boxes }, (_, index) => index + 1)
  const slotList = Array.from({ length: slots }, (_, index) => index + 1)

  const slotMap = new Map<string, Storage>()
  storages
    .filter((item) => item.cabinet.toUpperCase() === cabinet.toUpperCase())
    .forEach((item) => slotMap.set(encodeSlot(item.cabinet, item.drawer, item.box, item.slot), item))

  const markMap = new Map<string, SlotMark>()
  marks
    .filter((item) => item.cabinet.toUpperCase() === cabinet.toUpperCase())
    .forEach((item) => markMap.set(encodeSlot(item.cabinet, item.drawer, item.box, item.slot), item))

  return (
    <div className="flex flex-col gap-4" data-testid="cabinet-grid">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-semibold text-slate-700">
          标本柜 {cabinet} · {drawers} 抽屉 × {boxes} 盒 × {slots} 位
        </h3>
        <span className="text-xs text-slate-500">
          {draggingCode ? `正在拖动 ${draggingCode}，点击任一空插位即可放置` : '从右侧未入柜列表拖动标本到插位'}
        </span>
      </div>
      {drawerList.map((drawer) => (
        <section key={drawer} className="rounded-xl border border-slate-200 bg-white p-3">
          <header className="mb-2 text-xs font-medium text-slate-500">抽屉 D{drawer}</header>
          <div className="flex flex-col gap-3">
            {boxList.map((box) => (
              <div key={box} className="flex flex-wrap items-center gap-2">
                <span className="w-16 text-xs text-slate-500">盒 B{String(box).padStart(2, '0')}</span>
                <div className="flex flex-wrap gap-1.5">
                  {slotList.map((slot) => {
                    const key = encodeSlot(cabinet, drawer, box, slot)
                    const storage = slotMap.get(key)
                    const mark = slotMap.has(key) ? undefined : markMap.get(key)
                    const code = storage ? codeOf(storage.specimenId) : mark ? mark.code : ''
                    const title = storage
                      ? `占用：${code}`
                      : mark
                        ? `${mark.kind}：${mark.code}${mark.occupiedBy ? `（原柜位已由 ${mark.occupiedBy} 占用）` : `（${mark.hint}）`}`
                        : '空位'
                    return (
                      <button
                        key={slot}
                        type="button"
                        title={title}
                        onClick={() => {
                          if (storage) {
                            onPickStorage?.(storage)
                            return
                          }
                          if (mark) {
                            // 已选/拖着标本时按「尝试放置」处理（页面侧二次确认占用）；否则展示保留信息
                            if (draggingCode) onDropSlot({ cabinet, drawer, box, slot })
                            else onPickMark?.(mark)
                            return
                          }
                          onDropSlot({ cabinet, drawer, box, slot })
                        }}
                        onDragOver={(event) => event.preventDefault()}
                        onDrop={(event) => {
                          event.preventDefault()
                          onDropSlot({ cabinet, drawer, box, slot })
                        }}
                        className={`h-12 w-16 rounded-md border text-[11px] leading-tight transition ${
                          storage
                            ? 'border-field-500 bg-field-50 text-field-700 hover:bg-field-100'
                            : mark
                              ? mark.kind === '待归位'
                                ? 'border-amber-400 border-double bg-amber-50 text-amber-700 hover:bg-amber-100'
                                : 'border-orange-300 border-dashed bg-orange-50/60 text-orange-600 hover:bg-orange-100'
                              : 'border-dashed border-slate-300 bg-slate-50 text-slate-400 hover:border-field-500 hover:text-field-600'
                        }`}
                      >
                        <span className="block font-mono">{storage || mark ? code : `S${String(slot).padStart(2, '0')}`}</span>
                        <span className="block">
                          {storage ? '占用' : mark ? (mark.occupiedBy ? '待归·被占' : mark.kind === '待归位' ? '待归位' : '外借中') : '空位'}
                        </span>
                      </button>
                    )
                  })}
                </div>
              </div>
            ))}
          </div>
        </section>
      ))}
      {footer}
    </div>
  )
}
