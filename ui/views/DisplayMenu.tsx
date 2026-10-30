/** Display options popover: layout, grouping/columns, rows, ordering, completed issues, toggles, properties. */
import type { CompletedWindow, LabelDef, ViewDisplay } from '../../src/model'
import { Icon } from '../components/icons'
import { Popover } from '../components/Popover'
import { NONE, ORDERINGS, PROPERTIES, ROW_OPTIONS, groupingOptions } from '../viewModel'

const COMPLETED: { value: CompletedWindow | ''; label: string }[] = [
  { value: '', label: 'Per filter' }, { value: 'none', label: 'None' }, { value: 'day', label: 'Past day' },
  { value: 'week', label: 'Past week' }, { value: 'month', label: 'Past month' }, { value: 'all', label: 'All' },
]

function Select({ label, value, options, onChange }: { label: string; value: string; options: { value: string; label: string }[]; onChange: (v: string) => void }) {
  return (
    <label className="dm-row">
      <span className="dm-label">{label}</span>
      <select className="dm-select" value={value} onChange={(e) => onChange(e.target.value)} aria-label={label}>
        {options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
      </select>
    </label>
  )
}

function Toggle({ label, on, onChange }: { label: string; on: boolean; onChange: (on: boolean) => void }) {
  return (
    <label className="dm-row">
      <span className="dm-label">{label}</span>
      <button type="button" role="switch" aria-checked={on} aria-label={label} className={`switch${on ? ' on' : ''}`} onClick={() => onChange(!on)}><span /></button>
    </label>
  )
}

export function DisplayMenu({ display, labels, changed, onChange, onReset }: {
  display: ViewDisplay
  labels: LabelDef[]
  /** The display differs from the saved view / page default. */
  changed: boolean
  onChange: (d: ViewDisplay) => void
  onReset: () => void
}) {
  const set = (patch: Partial<ViewDisplay>) => onChange({ ...display, ...patch })
  const board = display.layout === 'board'
  const groups = groupingOptions(labels)
  if (!groups.some((g) => g.value === display.groupBy)) groups.push({ value: display.groupBy, label: display.groupBy })
  const toggleProp = (k: string) => {
    const on = new Set(display.properties)
    if (on.has(k)) on.delete(k)
    else on.add(k)
    set({ properties: PROPERTIES.map((p) => p.key).filter((p) => on.has(p)) })
  }
  return (
    <Popover label="Display options" button={<Icon name="display" />} active={changed} className="display-menu">
      {() => (
        <div className="dm">
          <div className="dm-layout" role="radiogroup" aria-label="Layout">
            {(['list', 'board'] as const).map((l) => (
              <button key={l} type="button" role="radio" aria-checked={display.layout === l} className={display.layout === l ? 'on' : ''} onClick={() => set({ layout: l })}>
                <Icon name={l} /> {l === 'list' ? 'List' : 'Board'}
              </button>
            ))}
          </div>
          <div className="dm-section">
            <Select label={board ? 'Columns' : 'Grouping'} value={display.groupBy} options={groups} onChange={(groupBy) => set({ groupBy })} />
            {board && <Select label="Rows" value={display.rowsBy ?? NONE} options={ROW_OPTIONS} onChange={(rowsBy) => set({ rowsBy: rowsBy === NONE ? undefined : rowsBy })} />}
            <Select label="Ordering" value={display.orderBy} options={ORDERINGS} onChange={(orderBy) => set({ orderBy })} />
          </div>
          <div className="dm-section">
            <Select label="Completed issues" value={display.completed ?? ''} options={COMPLETED}
              onChange={(v) => set({ completed: v ? (v as CompletedWindow) : undefined })} />
            <Toggle label="Show sub-issues" on={display.showSubIssues} onChange={(showSubIssues) => set({ showSubIssues })} />
          </div>
          <div className="dm-section">
            <div className="dm-heading">{board ? 'Board options' : 'List options'}</div>
            <Toggle label={board ? 'Show empty columns' : 'Show empty groups'} on={!!display.showEmptyColumns} onChange={(showEmptyColumns) => set({ showEmptyColumns })} />
            {board && <Toggle label="Show empty rows" on={!!display.showEmptyRows} onChange={(showEmptyRows) => set({ showEmptyRows })} />}
            <div className="dm-heading muted">Display properties</div>
            <div className="dm-props">
              {PROPERTIES.map((p) => (
                <button key={p.key} type="button" aria-pressed={display.properties.includes(p.key)} className={`dm-prop${display.properties.includes(p.key) ? ' on' : ''}`} onClick={() => toggleProp(p.key)}>{p.label}</button>
              ))}
            </div>
          </div>
          <div className="dm-foot">
            <button type="button" className="ghost-btn" disabled={!changed} onClick={onReset}>Reset</button>
          </div>
        </div>
      )}
    </Popover>
  )
}
