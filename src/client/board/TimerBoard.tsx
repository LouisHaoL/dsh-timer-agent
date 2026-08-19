/**
 * Board view: the job list that replaces the middle column while active.
 * Cards open the job detail (never execute directly); the header offers
 * filter, new-job, and a back-to-chat escape.
 */
import { useEffect, useState } from 'react'
import { selectedJobOf, type ControllerSnapshot } from '../../core/controller.ts'
import type { JobRecord, JobStatus } from '../../core/jobs.ts'
import type { TargetGroup, ModelOptions } from '../target-options.ts'
import type { BoardControllerFace } from '../controller-face.ts'
import { t, type TimerAgentKey } from '../locales.ts'
import css from '../board.module.css'
import { NewJobModal } from './NewJobModal.tsx'
import { JobDetail } from './JobDetail.tsx'

/** Status → locale key. */
export const STATUS_KEY: Record<JobStatus, TimerAgentKey> = {
  idle: 'detail.result.cancelled',
  running: 'detail.result.running',
  done: 'detail.result.succeeded',
  failed: 'detail.result.failed',
  archived: 'detail.status.archived',
}

/** Status → display label key (shared with JobDetail). */
export const STATUS_LABEL_KEY: Record<JobStatus, TimerAgentKey> = {
  idle: 'detail.status.idle',
  running: 'detail.result.running',
  done: 'detail.result.succeeded',
  failed: 'detail.result.failed',
  archived: 'detail.status.archived',
}

/** Case-insensitive title/description/prompt match. */
function matchesFilter(job: JobRecord, filter: string): boolean {
  if (filter.trim() === '') return true
  const needle = filter.trim().toLowerCase()
  return job.title.toLowerCase().includes(needle)
    || job.description.toLowerCase().includes(needle)
    || job.prompt.toLowerCase().includes(needle)
}

/** Board component; subscribes to the controller snapshot. */
export function TimerBoard({ controller, targetOptions, modelOptions }: { controller: BoardControllerFace; targetOptions: () => Promise<TargetGroup[]>; modelOptions: () => Promise<ModelOptions> }) {
  const [snapshot, setSnapshot] = useState(controller.getSnapshot())
  useEffect(
    () => controller.subscribe(() => setSnapshot(controller.getSnapshot())),
    [controller],
  )
  const [filter, setFilter] = useState('')
  const [showNew, setShowNew] = useState(false)
  const selected = selectedJobOf(snapshot)
  const visible = snapshot.jobs.filter(job => matchesFilter(job, filter))

  return (
    <div className={css.board} data-dsh-timeragent-board="">
      <header className={css.boardHeader}>
        <h2 className={css.boardTitle}>{t('board.title')}</h2>
        <span className={css.boardHint}>{t('board.hint')}</span>
        <input
          className={css.search}
          type="search"
          placeholder={t('board.search')}
          value={filter}
          onChange={event => { setFilter(event.target.value) }}
          aria-label={t('board.search')}
        />
        <button
          type="button"
          className={css.primaryButton}
          onClick={() => { setShowNew(true) }}
        >
          + {t('board.new')}
        </button>
        <button
          type="button"
          className={css.ghostButton}
          onClick={() => { controller.closeBoard() }}
        >
          {t('board.close')}
        </button>
      </header>

      <div className={css.list}>
        {visible.map(job => (
          <button
            key={job.id}
            type="button"
            className={css.rowCard}
            data-status={job.status}
            onClick={() => { controller.openJob(job.id) }}
            title={job.description !== '' ? job.description : job.title}
          >
            <span className={css.rowTitle}>{job.title}</span>
            {job.description !== '' && <span className={css.rowExcerpt}>{job.description}</span>}
            <span className={css.rowMeta}>
              <span className={css.statusBadge} data-status={job.status}>
                <span className={css.statusDot} aria-hidden="true" />
                {t(STATUS_LABEL_KEY[job.status])}
              </span>
              {job.schedule?.enabled === true && (
                <span
                  title={job.schedule.nextRunAt !== undefined
                    ? `${t('card.scheduled')} · ${new Date(job.schedule.nextRunAt).toLocaleString()}`
                    : t('card.scheduled')}
                >
                  ⏰ {t('card.scheduled')}
                  {job.schedule.nextRunAt !== undefined && ` · ${new Date(job.schedule.nextRunAt).toLocaleString()}`}
                </span>
              )}
              <span>{t('board.updated')} {formatTime(job.updatedAt)}</span>
              {job.executions.length > 0 && (
                <span>{job.executions.length} {t('board.runs')}</span>
              )}
              {job.status === 'running' && <span className={css.cardSpinner} aria-hidden="true" />}
            </span>
          </button>
        ))}
        {visible.length === 0 && <div className={css.listEmpty}>{t('board.empty')}</div>}
      </div>

      {selected !== undefined && (
        <JobDetail controller={controller} job={selected} />
      )}
      {showNew && (
        <NewJobModal
          controller={controller}
          targetOptions={targetOptions}
          modelOptions={modelOptions}
          onClose={() => { setShowNew(false) }}
        />
      )}
    </div>
  )
}

/** Compact relative/absolute time label. */
export function formatTime(ms: number): string {
  const date = new Date(ms)
  const now = Date.now()
  const minutes = Math.floor((now - ms) / 60000)
  if (minutes < 1) return t('time.justNow')
  if (minutes < 60) return `${minutes}m`
  if (minutes < 60 * 24) return `${Math.floor(minutes / 60)}h`
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
}
