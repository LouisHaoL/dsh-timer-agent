/**
 * New-job modal: title + description + prompt + session targeting
 * (collapsible workspace tree) + optional cron schedule.
 *
 * The targeting tree is this plugin's headline feature: per workspace
 * (project) group a "new session each run" leaf plus that project's
 * existing sessions (pinned continuation); the leading default group
 * covers the default workspace. Selecting a session pins the job to that
 * conversation (hermes context_from semantics).
 */
import { useEffect, useMemo, useState } from 'react'
import type { TargetGroup } from '../target-options.ts'
import type { BoardControllerFace } from '../controller-face.ts'
import { isValidCron } from '../../core/schedule.ts'
import { t, type TimerAgentKey } from '../locales.ts'
import css from '../board.module.css'

/** One selectable leaf inside a group. */
interface Leaf {
  key: string
  label: string
  workdir: string
  sessionId: string
}

/** Common scheduled-run presets (cron → locale label), task-board parity. */
const SCHEDULE_PRESETS: ReadonlyArray<{ cron: string; label: TimerAgentKey }> = [
  { cron: '0 9 * * *', label: 'detail.schedule.preset.daily9' },
  { cron: '0 * * * *', label: 'detail.schedule.preset.hourly' },
  { cron: '*/10 * * * *', label: 'detail.schedule.preset.tenMin' },
  { cron: '0 9 * * 1', label: 'detail.schedule.preset.weeklyMon9' },
]

/** Flatten a group into its selectable leaves: new-session first, sessions after. */
function leavesOf(group: TargetGroup): Leaf[] {
  return [
    { key: `${group.key}:new`, label: '新增会话', workdir: group.workdir, sessionId: '' },
    ...group.sessions.map(session => ({
      key: `${group.key}:ss:${session.id}`,
      label: session.title,
      workdir: group.workdir,
      sessionId: session.id,
    })),
  ]
}

/** New-job form overlay. */
export function NewJobModal({ controller, targetOptions, onClose }: { controller: BoardControllerFace; targetOptions: () => Promise<TargetGroup[]>; onClose: () => void }) {
  const [title, setTitle] = useState('')
  const [description, setDescription] = useState('')
  const [prompt, setPrompt] = useState('')
  const [groups, setGroups] = useState<TargetGroup[]>([{ key: 'default', name: '默认工作空间', workdir: '', sessions: [] }])
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set<string>())
  const [selectedKey, setSelectedKey] = useState('default:new')
  const [cronEnabled, setCronEnabled] = useState(false)
  const [cron, setCron] = useState('0 9 * * *')
  const [error, setError] = useState<string | undefined>(undefined)

  useEffect(() => {
    let alive = true
    void targetOptions().then(next => {
      if (alive && next.length > 0) {
        setGroups(next)
        // All groups start collapsed; the user expands what they need.
      }
    }).catch(() => undefined)
    return () => { alive = false }
  }, [targetOptions])

  /** All leaves across groups, for resolving the current selection. */
  const leafOf = useMemo(() => {
    const map = new Map<string, Leaf>()
    for (const group of groups) for (const leaf of leavesOf(group)) map.set(leaf.key, leaf)
    return map
  }, [groups])

  const selected = leafOf.get(selectedKey) ?? { key: 'default:new', label: '', workdir: '', sessionId: '' }

  const toggleGroup = (key: string): void => {
    setExpanded(prev => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  }

  const submit = (): void => {
    // Stage the cron so createJob arms the schedule server-side in one call.
    controller.stageCreateCron?.(cronEnabled && isValidCron(cron) ? cron : undefined)
    const created = controller.createJob({
      title,
      description,
      prompt,
      target: { workdir: selected.workdir, sessionId: selected.sessionId },
    })
    void Promise.resolve(created).then(job => {
      if (job === undefined) {
        setError(t('new.required'))
        return
      }
      onClose()
    })
  }

  return (
    <div className={css.modalBackdrop} onMouseDown={event => { if (event.target === event.currentTarget) onClose() }}>
      <form
        className={css.modal}
        role="dialog"
        aria-label={t('board.new')}
        onSubmit={event => { event.preventDefault(); submit() }}
      >
        <h2 className={css.modalTitle}>{t('board.new')}</h2>

        <label className={css.field}>
          <span className={css.fieldLabel}>{t('new.title')}</span>
          <input
            className={css.input}
            value={title}
            autoFocus
            placeholder={t('new.titlePlaceholder')}
            onChange={event => { setTitle(event.target.value); setError(undefined) }}
          />
        </label>

        <label className={css.field}>
          <span className={css.fieldLabel}>{t('new.description')}</span>
          <textarea
            className={css.input}
            rows={1}
            value={description}
            placeholder={t('new.descriptionPlaceholder')}
            onChange={event => { setDescription(event.target.value) }}
          />
        </label>

        <label className={css.field}>
          <span className={css.fieldLabel}>{t('new.prompt')}</span>
          <textarea
            className={css.input}
            rows={3}
            value={prompt}
            placeholder={t('new.promptPlaceholder')}
            onChange={event => { setPrompt(event.target.value) }}
          />
        </label>

        <div className={css.field}>
          <span className={css.fieldLabel}>{t('new.target')}</span>
          <div className={css.targetTree} role="tree" aria-label={t('new.target')}>
            {groups.map(group => {
              const open = expanded.has(group.key)
              const leaves = leavesOf(group)
              return (
                <div key={group.key} className={css.targetGroup} role="group">
                  <button
                    type="button"
                    className={css.targetGroupHeader}
                    aria-expanded={open}
                    onClick={() => { toggleGroup(group.key) }}
                  >
                    <span className={`${css.targetCaret} ${open ? css.targetCaretOpen : ''}`} aria-hidden="true">▸</span>
                    <span className={css.targetGroupName}>{group.name}</span>
                    <span className={css.targetGroupCount}>{group.sessions.length > 0 ? `${group.sessions.length}` : ''}</span>
                  </button>
                  {open && (
                    <div className={css.targetGroupBody}>
                      {leaves.map(leaf => (
                        <button
                          key={leaf.key}
                          type="button"
                          role="treeitem"
                          aria-selected={leaf.key === selectedKey}
                          className={`${css.targetRow} ${leaf.key === selectedKey ? css.targetRowSelected : ''}`}
                          onClick={() => { setSelectedKey(leaf.key) }}
                          title={leaf.sessionId === '' ? `${group.name} · 新增会话` : leaf.label}
                        >
                          <span className={css.targetRowDot} aria-hidden="true" />
                          <span className={css.targetRowLabel}>{leaf.label}</span>
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              )
            })}
          </div>
          <span className={css.fieldHint}>{t('new.target.hint')}</span>
        </div>

        <div className={css.field}>
          <label className={css.scheduleToggle}>
            <input
              type="checkbox"
              checked={cronEnabled}
              onChange={event => { setCronEnabled(event.target.checked) }}
            />
            <span>{t('new.schedule.enable')}</span>
          </label>
          {cronEnabled && (
            <div className={css.scheduleRow}>
              <input
                className={`${css.input} ${css.scheduleInput}`}
                value={cron}
                placeholder="0 9 * * *"
                spellCheck={false}
                aria-label={t('new.schedule.cron')}
                onChange={event => { setCron(event.target.value); setError(undefined) }}
              />
              <select
                className={`${css.input} ${css.schedulePreset}`}
                value=""
                aria-label={t('detail.schedule.presets')}
                onChange={event => {
                  const preset = event.target.value
                  if (preset !== '') {
                    setCron(preset)
                    setError(undefined)
                  }
                }}
              >
                <option value="">{t('detail.schedule.presets')}…</option>
                {SCHEDULE_PRESETS.map(preset => (
                  <option key={preset.cron} value={preset.cron}>{t(preset.label)}</option>
                ))}
              </select>
            </div>
          )}
        </div>

        {error !== undefined && <p className={css.formError}>{error}</p>}

        <footer className={css.modalFooter}>
          <button type="button" className={css.ghostButton} onClick={onClose}>
            {t('new.cancel')}
          </button>
          <button type="submit" className={css.primaryButton}>
            {t('new.submit')}
          </button>
        </footer>
      </form>
    </div>
  )
}
