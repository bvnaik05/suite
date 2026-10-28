import type { App } from 'vue'
import type { Router } from 'vue-router'

import { getSessionUser } from '@/boot/session'

import { redactTelemetry } from './sentryPrivacy'

export async function initSentry(app: App, router: Router): Promise<void> {
  if (!window.sentry_dsn) return

  try {
    const Sentry = await import('@sentry/vue')
    Sentry.init({
      app,
      dsn: window.sentry_dsn,
      environment: window.sentry_environment,
      release: window.sentry_release,
      sampleRate: 1,
      integrations: [
        Sentry.browserTracingIntegration({ router }),
        // Replay retains initial URLs, resource URLs and DOM attributes outside
        // beforeSend. Keep it disabled until those recordings can be scrubbed.
      ],
      tracesSampleRate: 0,
      replaysSessionSampleRate: 0,
      replaysOnErrorSampleRate: 0,
      transport(options) {
        const transport = Sentry.makeFetchTransport(options)
        return {
          ...transport,
          send(envelope) {
            // Runs after SDK processors, for errors, breadcrumbs and traces.
            redactTelemetry(envelope)
            return transport.send(envelope)
          },
        }
      },
      initialScope: {
        user: { id: window.site_name },
        tags: { frappe_user: getSessionUser() ?? 'Guest' },
      },
      beforeSend(event, hint) {
        const original = hint.originalException
        if (original && typeof original === 'object') {
          const error = original as Record<string, unknown>
          const exceptionType = error.exc_type ?? error.excType
          if (exceptionType === 'PermissionError' || exceptionType === 'ValidationError')
            return null
        }

        const stack = original instanceof Error ? original.stack : ''
        return stack?.includes('frappe.throw') ? null : event
      },
    })
  } catch (error) {
    console.warn('Failed to initialize error tracking', error)
  }
}
