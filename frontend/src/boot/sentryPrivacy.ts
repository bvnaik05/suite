/** Redact URL capabilities in every JSON envelope item, including nested SDK context.
 * Replay must stay disabled: its compressed recordings are not JSON event payloads.
 */
export function redactTelemetry(value: unknown): void {
  if (!value || typeof value !== 'object') return
  for (const [key, field] of Object.entries(value)) {
    if (typeof field === 'string') Reflect.set(value, key, redactUrlCredentials(field))
    else redactTelemetry(field)
  }
}

function redactUrlCredentials(value: string): string {
  return value
    .replace(/\/(?:drive\/)?l\/[^/?#\s"'<>]+/gi, '/l/[Filtered]')
    .replace(/([?&#])([^=&#?\s"'<>]+)=([^&#\s"'<>]*)/g, (match, separator, key) => {
      let decoded: string
      try {
        decoded = decodeURIComponent(key).toLowerCase()
      } catch {
        // Malformed keys cannot be classified safely; discard their value.
        return `${separator}[Filtered]=[Filtered]`
      }
      return /^(link|token|s|signature|access_token|auth|authorization|password|credential|x-amz-.+|x-goog-.+)$/.test(
        decoded,
      )
        ? `${separator}${key}=[Filtered]`
        : match
    })
}
