/**
 * Job detail: the full view of one job — content, prompt, session target,
 * execution history — and the only place execution can be triggered. Also
 * offers delete (with confirmation) and a jump to the execution's session
 * transcript.
 *
 * Editing is job-level and manual: one 编辑 button puts the WHOLE job
 * (prompt + session target + cron schedule) into a draft state, and a single
 * 保存 in the footer persists everything in one PATCH. No field saves on
 * its own while editing.
 */
import { useEffect, useMemo, useState } from 'react'
import { isIntervalRule, isSchedulable, isValidCron, nextRunAtMs, scheduleNextMs } from '../../core/schedule.ts'
import { commandLine, jobKind, timeoutLabel, type ExecutionRecord, type JobRecord, type ScheduleRule } from '../../core/jobs.ts'
import type { ModelOptions, PresetOptions, TargetGroup } from '../target-options.ts'
import type { BoardControllerFace } from '../controller-face.ts'
import { t, type TimerAgentKey } from '../locales.ts'
import css from '../board.module.css'
import { formatTime, STATUS_LABEL_KEY } from './TimerBoard.tsx'
import { DEFAULT_TARGET_GROUPS, intervalDraftMinutes, leavesOf, modelLeavesOf, TargetTree } from './NewJobModal.tsx'

/** How many execution rows show before the 全部/收起 toggle. */
const EXECUTION_PREVIEW_COUNT = 3
/** Collapsed prompt height, in text lines (line-clamp). */
const PROMPT_PREVIEW_LINES = 4

/** Execution outcome → locale key. */
const RESULT_KEY: Record<NonNullable<ExecutionRecord['result']>, TimerAgentKey> = {
  succeeded: 'detail.result.succeeded',
  failed: 'detail.result.failed',
  cancelled: 'detail.result.cancelled',
}

/** One execution-history row. */
function ExecutionRow({ execution, onOpen }: { execution: ExecutionRecord; onOpen: (sessionId: string) => void }) {
  const result = execution.result
  const isCommand = execution.targeting === 'command'
  return (
    <li className={css.executionRow} data-result={result}>
      <span className={css.executionBadge} data-result={result}>
        {result === undefined ? t('detail.result.running') : t(RESULT_KEY[result])}
      </span>
      <span className={css.executionTimes}>
        {isCommand
          ? `(${t('detail.execution.command')})`
          : execution.targeting === 'specified-session'
            ? `(${t('detail.target.session')})`
            : `(${t('detail.target.new')})`}
        {' '}
        {t('detail.executionStarted')} {formatTime(execution.startedAt)}
        {execution.endedAt !== undefined && ` · ${t('detail.executionEnded')} ${formatTime(execution.endedAt)}`}
        {isCommand && execution.exitCode !== undefined && ` · ${t('detail.execution.exitCode')} ${execution.exitCode}`}
      </span>
      {execution.sessionId !== undefined && (
        <button
          type="button"
          className={css.linkButton}
          onClick={() => { onOpen(execution.sessionId as string) }}
          title={execution.sessionId}
        >
          {t('detail.viewSession')} ⌁
        </button>
      )}
      {execution.error !== undefined && execution.error !== '' && (
        <span className={css.executionError}>{execution.error}</span>
      )}
      {isCommand && execution.output !== undefined && execution.output !== '' && (
        <details className={css.executionOutput}>
          <summary>{t('detail.output')}</summary>
          <pre className={css.outputBlock}>{execution.output}</pre>
        </details>
      )}
    </li>
  )
}

/** Common scheduled-run presets (cron → locale label). */
const SCHEDULE_PRESETS: ReadonlyArray<{ cron: string; label: TimerAgentKey }> = [
  { cron: '0 9 * * *', label: 'detail.schedule.preset.daily9' },
  { cron: '0 * * * *', label: 'detail.schedule.preset.hourly' },
  { cron: '*/10 * * * *', label: 'detail.schedule.preset.tenMin' },
  { cron: '0 9 * * 1', label: 'detail.schedule.preset.weeklyMon9' },
]

/** Human label for a fixed-interval rule: 每 N 分钟 / 小时 / 天. */
function intervalLabel(minutes: number): string {
  if (minutes % 1440 === 0) return t('detail.schedule.every', { n: String(minutes / 1440), unit: t('detail.schedule.unit.days') })
  if (minutes % 60 === 0) return t('detail.schedule.every', { n: String(minutes / 60), unit: t('detail.schedule.unit.hours') })
  return t('detail.schedule.every', { n: String(minutes), unit: t('detail.timeout.minutes') })
}

/** Read-mode label for a schedule rule: the cron expression or a prettified interval. */
function scheduleLabel(schedule: ScheduleRule | undefined): string {
  if (schedule === undefined) return t('detail.schedule.notScheduled')
  return isIntervalRule(schedule) ? intervalLabel(schedule.intervalMinutes!) : schedule.cron
}

/** Split stored interval minutes into the value/unit draft fields. */
function intervalDraftOf(minutes: number): { value: string; unit: '1' | '60' | '1440' } {
  const unit = minutes % 1440 === 0 ? '1440' : minutes % 60 === 0 ? '60' : '1'
  return { value: String(minutes / Number(unit)), unit }
}

/** Human label for a job's session target. */
function targetLabel(job: JobRecord): string {
  if (job.target.sessionId !== '') return `${t('detail.target.session')} (${job.target.sessionId})`
  const base = job.target.workdir !== '' ? `${job.target.workdir} · ${t('detail.target.new')}` : t('detail.target.default')
  // Only new-session targets carry a preset (pinned sessions keep their own).
  if (job.preset !== undefined && job.preset !== '') return `${base} · ${t('detail.target.preset')}: ${job.preset}`
  return base
}

/** Normalize a path for matching (case-fold, forward slashes, no trailing). */
function normPath(path: string): string {
  let p = path.replaceAll('\\', '/').replace(/\/+$/, '').toLowerCase()
  if (p.length >= 2 && p[1] === ':') p = p[0].toUpperCase() + p.slice(1)
  return p
}

/** Resolve the tree-leaf key matching a job's current target (undefined = none). */
function keyForTarget(groups: TargetGroup[], job: JobRecord): string | undefined {
  for (const group of groups) {
    if (normPath(group.workdir) !== normPath(job.target.workdir)) continue
    if (job.target.sessionId === '') return `${group.key}:new`
    if (group.sessions.some(session => session.id === job.target.sessionId)) {
      return `${group.key}:ss:${job.target.sessionId}`
    }
  }
  return undefined
}

/** Confirm-dialog shape (inline; the board owns no shared dialog). */
function Confirm({ message, confirmLabel, onConfirm, onCancel }: {
  message: string
  confirmLabel: string
  onConfirm: () => void
  onCancel: () => void
}) {
  return (
    <div className={css.modalBackdrop} onMouseDown={event => { if (event.target === event.currentTarget) onCancel() }}>
      <div className={css.modal} role="alertdialog" style={{ width: 'min(380px, 100%)' }}>
        <p className={css.confirmText}>{message}</p>
        <footer className={css.modalFooter}>
          <button type="button" className={css.ghostButton} onClick={onCancel}>{t('delete.cancel')}</button>
          <button type="button" className={css.dangerButton} onClick={onConfirm}>{confirmLabel}</button>
        </footer>
      </div>
    </div>
  )
}

/** Human label for a job's current model resolution. */
function modelLabel(job: JobRecord): string {
  if (job.modelSelection !== undefined) {
    return `${job.modelSelection.provider} · ${job.modelSelection.model}`
  }
  return job.target.sessionId !== '' ? t('new.model.followSession') : t('new.model.followDefault')
}

/** Job detail overlay. */
export function JobDetail({ controller, job, targetOptions, modelOptions, presetOptions }: { controller: BoardControllerFace; job: JobRecord; targetOptions: () => Promise<TargetGroup[]>; modelOptions: () => Promise<ModelOptions>; presetOptions: () => Promise<PresetOptions> }) {
  const [confirmDelete, setConfirmDelete] = useState(false)
  const running = job.status === 'running'
  const archived = job.status === 'archived'

  // Keep the overlay in sync if the job record changes underneath.
  const [latest, setLatest] = useState(job)
  useEffect(() => { setLatest(job) }, [job])
  const current = latest

  // Read-mode fold states; reset when the detail switches to another job.
  const [showAllExecutions, setShowAllExecutions] = useState(false)
  const [promptExpanded, setPromptExpanded] = useState(false)
  useEffect(() => {
    setShowAllExecutions(false)
    setPromptExpanded(false)
  }, [job.id])

  const canEdit = !running && !archived
  const isCommand = jobKind(current) === 'command'

  // --- unified edit state (drafts; nothing persists until 保存) ---------------
  const [editing, setEditing] = useState(false)
  const [saving, setSaving] = useState(false)
  const [promptDraft, setPromptDraft] = useState(current.prompt)
  const [commandDraft, setCommandDraft] = useState(current.command ?? '')
  const [argsDraft, setArgsDraft] = useState(current.args ?? '')
  const [workdirDraft, setWorkdirDraft] = useState(current.target.workdir)
  const [groups, setGroups] = useState<TargetGroup[]>(DEFAULT_TARGET_GROUPS)
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set<string>())
  const [selectedKey, setSelectedKey] = useState('')
  const [cronDraft, setCronDraft] = useState(current.schedule?.cron ?? '0 9 * * *')
  const [scheduleModeDraft, setScheduleModeDraft] = useState<'cron' | 'interval'>(isIntervalRule(current.schedule) ? 'interval' : 'cron')
  const [intervalValueDraft, setIntervalValueDraft] = useState(current.schedule !== undefined && isIntervalRule(current.schedule) ? intervalDraftOf(current.schedule.intervalMinutes!).value : '')
  const [intervalUnitDraft, setIntervalUnitDraft] = useState<'1' | '60' | '1440'>(current.schedule !== undefined && isIntervalRule(current.schedule) ? intervalDraftOf(current.schedule.intervalMinutes!).unit : '1')
  const [scheduleEnabledDraft, setScheduleEnabledDraft] = useState(current.schedule?.enabled ?? false)
  const [timeoutDraft, setTimeoutDraft] = useState(current.timeoutMs !== undefined ? String(Math.round(current.timeoutMs / 60_000)) : '')
  const [modelOptionsState, setModelOptionsState] = useState<ModelOptions>({ groups: [] })
  const [modelKey, setModelKey] = useState('')
  const [presetOptionsState, setPresetOptionsState] = useState<PresetOptions>({ presets: [] })
  const [presetDraft, setPresetDraft] = useState(current.preset ?? '')
  const [error, setError] = useState<string | undefined>(undefined)

  /** All leaves across groups, for resolving the current selection. */
  const leafMap = useMemo(() => {
    const map = new Map<string, ReturnType<typeof leavesOf>>()
    for (const group of groups) map.set(group.key, leavesOf(group))
    return map
  }, [groups])

  /** The leaf the selection resolves to (falls back to the job's target). */
  const selectedTarget = useMemo(() => {
    for (const leaves of leafMap.values()) {
      const hit = leaves.find(leaf => leaf.key === selectedKey)
      if (hit !== undefined) return { workdir: hit.workdir, sessionId: hit.sessionId }
    }
    return { workdir: current.target.workdir, sessionId: current.target.sessionId }
  }, [leafMap, selectedKey, current.target.workdir, current.target.sessionId])

  /** Enter edit mode: stage drafts from the current record + load the tree. */
  const startEdit = (): void => {
    setPromptDraft(current.prompt)
    setCommandDraft(current.command ?? '')
    setArgsDraft(current.args ?? '')
    setWorkdirDraft(current.target.workdir)
    setPresetDraft(current.preset ?? '')
    setCronDraft(current.schedule?.cron ?? '0 9 * * *')
    setScheduleModeDraft(current.schedule !== undefined && isIntervalRule(current.schedule) ? 'interval' : 'cron')
    setIntervalValueDraft(current.schedule !== undefined && isIntervalRule(current.schedule) ? intervalDraftOf(current.schedule.intervalMinutes!).value : '')
    setIntervalUnitDraft(current.schedule !== undefined && isIntervalRule(current.schedule) ? intervalDraftOf(current.schedule.intervalMinutes!).unit : '1')
    setScheduleEnabledDraft(current.schedule?.enabled ?? false)
    setTimeoutDraft(current.timeoutMs !== undefined ? String(Math.round(current.timeoutMs / 60_000)) : '')
    setError(undefined)
    setSaving(false)
    // Model picker: '' = follow default/session, else provider\u0000model.
    const sel = current.modelSelection
    setModelKey(sel === undefined ? '' : `${sel.provider}\u0000${sel.model}`)
    void modelOptions().then(next => { setModelOptionsState(next) }).catch(() => undefined)
    void presetOptions().then(next => { setPresetOptionsState(next) }).catch(() => undefined)
    void targetOptions().then(next => {
      const loaded = next.length > 0 ? next : DEFAULT_TARGET_GROUPS
      setGroups(loaded)
      const key = keyForTarget(loaded, current)
      if (key !== undefined) {
        setSelectedKey(key)
        // Auto-expand the group holding the current target for context.
        const group = loaded.find(g => key === `${g.key}:new` || key.startsWith(`${g.key}:ss:`))
        setExpanded(new Set<string>(group !== undefined ? [group.key] : []))
      } else {
        setSelectedKey('')
      }
    }).catch(() => undefined)
    setEditing(true)
  }

  const cancelEdit = (): void => {
    setEditing(false)
    setSaving(false)
    setError(undefined)
  }

  /** One PATCH: prompt + target + schedule (cron or interval) + armed state, all at once. */
  const saveEdit = (): void => {
    const cron = cronDraft.trim()
    const draftInterval = scheduleModeDraft === 'interval'
      ? intervalDraftMinutes(intervalValueDraft, intervalUnitDraft)
      : undefined
    // Cron mode: an empty expression only passes while disarmed; interval
    // mode needs a whole number > 0 whenever it will be sent (always OK to
    // omit while disarmed with a junk draft — the field is then untouched).
    const schedulePatch: { cron?: string; intervalMinutes?: number } = scheduleModeDraft === 'interval'
      ? (draftInterval !== undefined ? { intervalMinutes: draftInterval } : {})
      : { cron, intervalMinutes: 0 }
    if (scheduleModeDraft === 'interval'
      ? (scheduleEnabledDraft && draftInterval === undefined)
      : (cron === '' ? scheduleEnabledDraft : !isValidCron(cron))) {
      setError(scheduleModeDraft === 'interval' ? t('detail.schedule.interval.invalid') : t('detail.schedule.invalid'))
      return
    }
    if (isCommand && commandDraft.trim() === '') {
      setError(t('new.commandRequired'))
      return
    }
    setError(undefined)
    setSaving(true)
    if (isCommand) {
      // Command jobs edit the exec line + workdir only.
      void Promise.resolve(controller.updateJob(current.id, {
        command: commandDraft,
        args: argsDraft,
        target: { workdir: workdirDraft.trim(), sessionId: '' },
        ...schedulePatch,
        scheduleEnabled: scheduleEnabledDraft,
        ...(() => {
          const timeoutMinutes = timeoutDraft.trim() === '' ? 0 : Number(timeoutDraft)
          return Number.isFinite(timeoutMinutes) ? { timeoutMinutes } : {}
        })(),
      })).then(() => {
        setEditing(false)
        setSaving(false)
      }).catch(() => { setSaving(false) })
      return
    }
    // Blank / 0 / negative timeout clears the limit (host normalizes).
    const timeoutMinutes = timeoutDraft.trim() === '' ? 0 : Number(timeoutDraft)
    // Model picker resolution: untouched → omit (keep stored); '' → clear
    // (null); a leaf → pin it. A stored override absent from the live catalog
    // still resolves to "untouched" so it is never silently dropped.
    const initialKey = current.modelSelection === undefined
      ? ''
      : `${current.modelSelection.provider}\u0000${current.modelSelection.model}`
    const modelLeaves = modelLeavesOf(modelOptionsState)
    const leaf = modelLeaves.find(item => item.key === modelKey)
    const modelSelection = modelKey === initialKey
      ? undefined
      : modelKey === ''
        ? null
        : leaf === undefined ? undefined : { provider: leaf.provider, model: leaf.model }
    void Promise.resolve(controller.updateJob(current.id, {
      prompt: promptDraft,
      target: { workdir: selectedTarget.workdir, sessionId: selectedTarget.sessionId },
      // Preset follows the target: a new session carries the pinned preset,
      // switching to a pinned session clears it (that session keeps its own).
      preset: selectedTarget.sessionId === '' ? presetDraft.trim() : '',
      ...schedulePatch,
      scheduleEnabled: scheduleEnabledDraft,
      ...(Number.isFinite(timeoutMinutes) ? { timeoutMinutes } : {}),
      ...(modelSelection !== undefined ? { modelSelection } : {}),
    })).then(() => {
      setEditing(false)
      setSaving(false)
    }).catch(() => { setSaving(false) })
  }

  const toggleGroup = (key: string): void => {
    setExpanded(prev => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  }

  // Read-only schedule labels.
  const enabled = current.schedule?.enabled ?? false
  const nextRunAt = current.schedule?.nextRunAt
  const nextLabel = !enabled || nextRunAt === undefined
    ? t('detail.schedule.notScheduled')
    : nextRunAt <= Date.now()
      ? t('detail.schedule.dueSoon')
      : new Date(nextRunAt).toLocaleString()
  const lastLabel = current.schedule?.lastTriggeredAt === undefined
    ? '—'
    : new Date(current.schedule.lastTriggeredAt).toLocaleString()
  const draftCronValid = cronDraft.trim() !== '' && isValidCron(cronDraft.trim())
  const draftNextRun = !scheduleEnabledDraft
    ? undefined
    : scheduleModeDraft === 'interval'
      ? (() => {
          const minutes = intervalDraftMinutes(intervalValueDraft, intervalUnitDraft)
          return minutes !== undefined ? Date.now() + minutes * 60_000 : undefined
        })()
      : draftCronValid ? nextRunAtMs(cronDraft.trim(), Date.now()) : undefined
  // Skip-once preview: where 下次运行 lands if the next fire is skipped
  // (same max(nextRunAt, now) base the host uses; re-render keeps it fresh).
  const liveSchedule = current.schedule
  const skipTarget = enabled && nextRunAt !== undefined && liveSchedule !== undefined && isSchedulable(liveSchedule)
    ? isIntervalRule(liveSchedule)
      ? scheduleNextMs(liveSchedule, Math.max(nextRunAt, Date.now()))
      : nextRunAtMs(liveSchedule.cron, Math.max(nextRunAt, Date.now()))
    : undefined

  return (
    <div className={css.modalBackdrop} onMouseDown={event => { if (event.target === event.currentTarget) controller.closeJob() }}>
      <div className={css.detail} role="dialog" aria-label={t('detail.title')}>
        <header className={css.detailHeader}>
          <h2 className={css.detailTitle}>{current.title}</h2>
          <span className={css.kindBadge} data-kind={isCommand ? 'command' : 'agent'}>
            {isCommand ? `⌘ ${t('detail.kind.command')}` : t('detail.kind.agent')}
          </span>
          <span className={css.statusBadge} data-status={current.status}>
            <span className={css.statusDot} aria-hidden="true" />
            {t(STATUS_LABEL_KEY[current.status])}
          </span>
          <button
            type="button"
            className={css.iconButton}
            aria-label={t('detail.close')}
            onClick={() => { controller.closeJob() }}
          >
            ×
          </button>
        </header>

        <div className={css.detailBody}>
          {!editing && (
            <section className={css.detailSection}>
              <h4>{t('detail.description')}</h4>
              <p className={css.detailText}>{current.description !== '' ? current.description : '—'}</p>
            </section>
          )}

          {isCommand ? (
            <section className={css.detailSection}>
              <h4>{t('detail.command')}</h4>
              {editing ? (
                <>
                  <label className={css.field}>
                    <span className={css.fieldLabel}>{t('new.command')}</span>
                    <input
                      className={css.input}
                      style={{ width: '100%' }}
                      value={commandDraft}
                      placeholder={t('new.commandPlaceholder')}
                      aria-label={t('new.command')}
                      spellCheck={false}
                      onChange={event => { setCommandDraft(event.target.value); setError(undefined) }}
                    />
                  </label>
                  <label className={css.field}>
                    <span className={css.fieldLabel}>{t('new.args')}</span>
                    <input
                      className={css.input}
                      style={{ width: '100%' }}
                      value={argsDraft}
                      placeholder={t('new.argsPlaceholder')}
                      aria-label={t('new.args')}
                      spellCheck={false}
                      onChange={event => { setArgsDraft(event.target.value) }}
                    />
                  </label>
                  <label className={css.field}>
                    <span className={css.fieldLabel}>{t('new.workdir')}</span>
                    <input
                      className={css.input}
                      style={{ width: '100%' }}
                      value={workdirDraft}
                      placeholder={t('new.workdirPlaceholder')}
                      aria-label={t('new.workdir')}
                      spellCheck={false}
                      onChange={event => { setWorkdirDraft(event.target.value) }}
                    />
                  </label>
                </>
              ) : (
                <pre className={css.promptBlock}>{commandLine(current)}</pre>
              )}
            </section>
          ) : (
            <section className={css.detailSection}>
              <h4>{t('detail.prompt')}</h4>
              {editing ? (
                <textarea
                  className={css.input}
                  style={{ width: '100%', minHeight: '96px', resize: 'vertical', fontFamily: 'inherit', lineHeight: '1.5', boxSizing: 'border-box' }}
                  value={promptDraft}
                  placeholder={t('new.promptPlaceholder')}
                  aria-label={t('detail.prompt')}
                  onChange={event => { setPromptDraft(event.target.value) }}
                />
              ) : (
                (() => {
                  const text = current.prompt !== '' ? current.prompt : current.title
                  const foldable = text.split('\n').length > PROMPT_PREVIEW_LINES
                  return (
                    <>
                      <pre
                        className={`${css.promptBlock}${promptExpanded || !foldable ? '' : ` ${css.promptBlockClamped}`}`}
                      >
                        {text}
                      </pre>
                      {foldable && (
                        <button
                          type="button"
                          className={css.linkButton}
                          onClick={() => { setPromptExpanded(prev => !prev) }}
                        >
                          {promptExpanded ? t('detail.prompt.collapse') : t('detail.prompt.view')}
                        </button>
                      )}
                    </>
                  )
                })()
              )}
            </section>
          )}

          {!isCommand && (
            <section className={css.detailSection}>
              <h4>{t('new.target')}</h4>
              {editing ? (
                <>
                  <TargetTree
                    groups={groups}
                    expanded={expanded}
                    selectedKey={selectedKey}
                    onToggle={toggleGroup}
                    onSelect={setSelectedKey}
                    presetOptions={presetOptionsState.presets}
                    presetDefault={presetOptionsState.default}
                    presetId={presetDraft}
                    onPresetChange={setPresetDraft}
                  />
                  <span className={css.fieldHint}>{t('new.target.hint')}</span>
                </>
              ) : (
                <p className={css.detailText}>{targetLabel(current)}</p>
              )}
            </section>
          )}

          {!isCommand && (
            <section className={css.detailSection}>
              <h4>{t('new.model')}</h4>
            {editing ? (
              (() => {
                const leaves = modelLeavesOf(modelOptionsState)
                const modelDefaultLabel = selectedTarget.sessionId !== ''
                  ? t('new.model.followSession')
                  : modelOptionsState.default !== undefined
                    ? `${modelOptionsState.default.provider} · ${modelOptionsState.default.model}（${t('new.model.followDefault')}）`
                    : t('new.model.followDefault')
                const known = modelKey === '' || leaves.some(item => item.key === modelKey)
                return (
                  <select
                    className={css.input}
                    style={{ width: '100%' }}
                    value={modelKey}
                    aria-label={t('new.model')}
                    onChange={event => { setModelKey(event.target.value) }}
                  >
                    <option value="">{modelDefaultLabel}</option>
                    {!known && current.modelSelection !== undefined && (
                      <option value={modelKey}>
                        {current.modelSelection.provider} · {current.modelSelection.model}
                      </option>
                    )}
                    {leaves.map(item => (
                      <option key={item.key} value={item.key}>{item.label}</option>
                    ))}
                  </select>
                )
              })()
            ) : (
              <p className={css.detailText}>{modelLabel(current)}</p>
            )}
          </section>
          )}

          <section className={css.detailSection}>
            <h4>{t('detail.schedule')}</h4>
            {editing ? (
              <>
                <label className={css.scheduleToggle}>
                  <input
                    type="checkbox"
                    checked={scheduleEnabledDraft}
                    onChange={event => { setScheduleEnabledDraft(event.target.checked); setError(undefined) }}
                  />
                  <span>{t('detail.schedule.enable')}</span>
                </label>
                <div className={css.kindToggle} role="radiogroup" aria-label={t('detail.schedule')}>
                  <button
                    type="button"
                    role="radio"
                    aria-checked={scheduleModeDraft === 'cron'}
                    className={`${css.kindOption} ${scheduleModeDraft === 'cron' ? css.kindOptionActive : ''}`}
                    onClick={() => { setScheduleModeDraft('cron'); setError(undefined) }}
                  >
                    {t('detail.schedule.cron')}
                  </button>
                  <button
                    type="button"
                    role="radio"
                    aria-checked={scheduleModeDraft === 'interval'}
                    className={`${css.kindOption} ${scheduleModeDraft === 'interval' ? css.kindOptionActive : ''}`}
                    onClick={() => { setScheduleModeDraft('interval'); setError(undefined) }}
                  >
                    {t('detail.schedule.modeInterval')}
                  </button>
                </div>
                {scheduleModeDraft === 'cron' ? (
                  <div className={css.scheduleRow}>
                    <input
                      className={`${css.input} ${css.scheduleInput}${!draftCronValid ? ` ${css.scheduleInputInvalid}` : ''}`}
                      value={cronDraft}
                      placeholder="0 9 * * *"
                      spellCheck={false}
                      aria-label={t('detail.schedule.cron')}
                      onChange={event => { setCronDraft(event.target.value); setError(undefined) }}
                    />
                    <select
                      className={`${css.input} ${css.schedulePreset}`}
                      value=""
                      aria-label={t('detail.schedule.presets')}
                      onChange={event => {
                        const preset = event.target.value
                        if (preset !== '') {
                          setCronDraft(preset)
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
                ) : (
                  <>
                    <div className={css.scheduleRow}>
                      <input
                        className={css.input}
                        style={{ width: '120px' }}
                        type="number"
                        min={1}
                        value={intervalValueDraft}
                        placeholder="如 302"
                        aria-label={t('detail.schedule.interval')}
                        onChange={event => { setIntervalValueDraft(event.target.value); setError(undefined) }}
                      />
                      <select
                        className={css.input}
                        value={intervalUnitDraft}
                        aria-label={t('detail.schedule.unit')}
                        onChange={event => { setIntervalUnitDraft(event.target.value as '1' | '60' | '1440'); setError(undefined) }}
                      >
                        <option value="1">{t('detail.timeout.minutes')}</option>
                        <option value="60">{t('detail.schedule.unit.hours')}</option>
                        <option value="1440">{t('detail.schedule.unit.days')}</option>
                      </select>
                    </div>
                    <span className={css.fieldHint}>{t('detail.schedule.intervalHint')}</span>
                  </>
                )}
                {scheduleEnabledDraft && (
                  <p className={css.scheduleMeta}>
                    {t('detail.schedule.nextRun')}{' '}
                    {draftNextRun === undefined ? t('detail.schedule.notScheduled') : new Date(draftNextRun).toLocaleString()}
                  </p>
                )}
              </>
            ) : (
              <>
                <p className={css.detailText}>
                  {enabled ? scheduleLabel(current.schedule) : t('detail.schedule.notScheduled')}
                </p>
                <p className={css.scheduleMeta}>
                  {t('detail.schedule.lastTriggered')} {lastLabel}
                  {' · '}{t('detail.schedule.nextRun')} {nextLabel}
                  {skipTarget !== undefined && !archived && (
                    <button
                      type="button"
                      className={css.linkButton}
                      title={t('detail.schedule.skipHint', { time: new Date(skipTarget).toLocaleString() })}
                      onClick={() => { void controller.skipNextRun(current.id) }}
                    >
                      {t('detail.schedule.skip')} ⏭
                    </button>
                  )}
                </p>
              </>
            )}
          </section>

          <section className={css.detailSection}>
            <h4>{t('detail.timeout')}</h4>
            {editing ? (
              <>
                <div className={css.scheduleRow}>
                  <input
                    className={css.input}
                    style={{ width: '120px' }}
                    type="number"
                    min={0}
                    value={timeoutDraft}
                    placeholder="∞"
                    aria-label={t('detail.timeout')}
                    onChange={event => { setTimeoutDraft(event.target.value); setError(undefined) }}
                  />
                  <span className={css.fieldHint}>{t('detail.timeout.minutes')}</span>
                </div>
                <span className={css.fieldHint}>{t('detail.timeout.hint')}</span>
              </>
            ) : (
              <p className={css.detailText}>
                {current.timeoutMs !== undefined && current.timeoutMs > 0
                  ? `${timeoutLabel(current)} · ${t('detail.timeout.minutes')}`
                  : t('detail.timeout.unlimited')}
              </p>
            )}
          </section>

          <section className={css.detailSection}>
            <h4>{t('detail.execution')}</h4>
            {current.executions.length === 0 ? (
              <p className={css.detailText}>{t('detail.noExecution')}</p>
            ) : (() => {
              // Most recent first; collapsed shows only the latest few.
              const all = [...current.executions].reverse()
              const shown = showAllExecutions ? all : all.slice(0, EXECUTION_PREVIEW_COUNT)
              return (
                <>
                  <ul className={css.executionList}>
                    {shown.map(execution => (
                      <ExecutionRow
                        key={execution.id}
                        execution={execution}
                        onOpen={sessionId => { controller.openSession(sessionId) }}
                      />
                    ))}
                  </ul>
                  {all.length > EXECUTION_PREVIEW_COUNT && (
                    <button
                      type="button"
                      className={css.linkButton}
                      onClick={() => { setShowAllExecutions(prev => !prev) }}
                    >
                      {showAllExecutions
                        ? t('detail.execution.collapse')
                        : t('detail.execution.showAll', { count: String(all.length) })}
                    </button>
                  )}
                </>
              )
            })()}
          </section>
        </div>

        {editing && error !== undefined && <p className={css.formError}>{error}</p>}

        <footer className={css.detailFooter}>
          {editing ? (
            <>
              <button
                type="button"
                className={css.ghostButton}
                disabled={saving}
                onClick={cancelEdit}
              >
                {t('detail.editCancel')}
              </button>
              <button
                type="button"
                className={css.primaryButton}
                disabled={saving}
                onClick={saveEdit}
              >
                {t('detail.save')}
              </button>
            </>
          ) : (
            <>
              {archived && (
                <span className={css.detailText}>{t('detail.archivedHint')}</span>
              )}
              {canEdit && (
                <button
                  type="button"
                  className={css.ghostButton}
                  onClick={startEdit}
                >
                  {t('detail.edit')}
                </button>
              )}
              <button
                type="button"
                className={css.primaryButton}
                disabled={running || archived}
                onClick={() => {
                  // Running kicks off a real agent session; close the detail so
                  // the whole board stays visible while the job executes.
                  controller.closeJob()
                  void controller.rerunJob(current.id)
                }}
              >
                {current.executions.length === 0 ? t('detail.run') : t('detail.rerun')}
              </button>
              {archived ? (
                <button
                  type="button"
                  className={css.primaryButton}
                  onClick={() => { void controller.restartJob(current.id) }}
                >
                  {t('detail.restart')}
                </button>
              ) : (
                !running && (
                  <button
                    type="button"
                    className={css.ghostButton}
                    onClick={() => { void controller.archiveJob(current.id) }}
                  >
                    {t('detail.archive')}
                  </button>
                )
              )}
              {!running && !archived && current.status !== 'idle' && (
                <button
                  type="button"
                  className={css.ghostButton}
                  onClick={() => { controller.resetJob(current.id) }}
                >
                  {t('detail.reset')}
                </button>
              )}
              <button
                type="button"
                className={css.dangerButton}
                onClick={() => { setConfirmDelete(true) }}
              >
                {t('detail.delete')}
              </button>
            </>
          )}
          <span className={css.detailMeta}>
            {t('board.created')} {formatTime(current.createdAt)}
          </span>
        </footer>
      </div>

      {confirmDelete && (
        <Confirm
          message={t('delete.confirm', { name: current.title })}
          confirmLabel={t('delete.ok')}
          onCancel={() => { setConfirmDelete(false) }}
          onConfirm={() => {
            setConfirmDelete(false)
            controller.deleteJob(current.id)
            controller.closeJob()
          }}
        />
      )}
    </div>
  )
}
