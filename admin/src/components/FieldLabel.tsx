import { useI18n, type TranslationKey } from '../i18n'

const FIELD_LABELS = {
  id:                   { nameKey: 'fieldId',            code: 'id' },
  label:                { nameKey: 'fieldLabel',         code: 'label' },
  endpoint:             { nameKey: 'fieldEndpoint',      code: 'endpoint' },
  backendModel:         { nameKey: 'fieldBackendModel',  code: 'backendModel' },
  aliases:              { nameKey: 'fieldAliases',       code: 'aliases' },
  role:                 { nameKey: 'fieldRole',          code: 'role' },
  contextWindow:        { nameKey: 'fieldContextWindow', code: 'contextWindow' },
  timeoutMs:            { nameKey: 'fieldTimeoutMs',     code: 'timeoutMs' },
  apiKey:               { nameKey: 'fieldApiKey',        code: undefined },
  apiKeyEnv:            { nameKey: 'fieldApiKeyEnv',     code: 'apiKeyEnv' },
  headers:              { nameKey: 'fieldHeaders',       code: 'headers' },
  routerUrl:            { nameKey: 'fieldRouterUrl',     code: 'routerUrl' },
  localRuntimeProtocol: { nameKey: 'fieldProtocol',      code: 'localRuntimeProtocol' },
} as const satisfies Record<string, { nameKey: TranslationKey; code: string | undefined }>

export type FieldName = keyof typeof FIELD_LABELS

export function FieldLabel({ field }: { field: FieldName }) {
  const { t } = useI18n()
  const { nameKey, code } = FIELD_LABELS[field]
  return (
    <span className="field-label">
      {t(nameKey)}
      {code && <small className="field-label-code">{code}</small>}
    </span>
  )
}
