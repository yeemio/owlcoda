import type { ModelStatus } from '../api/types'
import { availabilityShortTag, availabilityTone } from '../lib/availability'
import { StatusIcon } from './StatusIcon'

interface Props {
  statuses: ModelStatus[]
  selectedId: string | null
  onSelect: (id: string) => void
}

export function ModelList({ statuses, selectedId, onSelect }: Props) {
  if (statuses.length === 0) {
    return <div className="empty">No models to show.</div>
  }
  return (
    <div className="model-list" role="list" data-testid="model-list">
      {statuses.map(s => {
        const tone = availabilityTone(s.availability)
        return (
          <button
            type="button"
            key={s.id}
            role="listitem"
            className={`model-row${selectedId === s.id ? ' active' : ''}`}
            onClick={() => onSelect(s.id)}
            data-testid={`model-row-${s.id}`}
            data-status={s.availability.kind}
          >
            <span className="icon"><StatusIcon availability={s.availability} /></span>
            <span className="main">
              <span className="label-line">
                {s.isDefault && <span className="default-star" aria-label="default">★</span>}
                <span className="name">{s.label}</span>
              </span>
              <span className="id-line">{s.id}</span>
            </span>
            <span className="side">
              <span className="provider">{s.providerKind}</span>
              <span className={`status tone-${tone}`}>{availabilityShortTag(s.availability)}</span>
            </span>
          </button>
        )
      })}
    </div>
  )
}
