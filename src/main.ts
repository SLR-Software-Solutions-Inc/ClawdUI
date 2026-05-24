import * as Sentry from '@sentry/browser'
import { mount } from 'svelte'
import './app.css'
import 'highlight.js/styles/atom-one-dark.css'
import App from './App.svelte'

// GlitchTip / Sentry-compatible crash reporting.
// DSN is injected at build time via VITE_GLITCHTIP_DSN (see .env.template +
// Forgejo Actions secret GLITCHTIP_DSN piped through the workflow).
// Frontend is never shipped a real DSN unless the build supplies one — local
// dev builds with the REPLACE_ME placeholder no-op the SDK.
const dsn = import.meta.env.VITE_GLITCHTIP_DSN as string | undefined
if (dsn && !dsn.includes('REPLACE_ME')) {
  Sentry.init({
    dsn,
    tracesSampleRate: 0, // errors only — no perf traces
    sendDefaultPii: false,
    release: import.meta.env.VITE_APP_VERSION as string | undefined,
    environment: import.meta.env.MODE,
    beforeSend(event) {
      // Strip anything PII-ish that the default integrations may have grabbed.
      if (event.user) {
        delete event.user.email
        delete event.user.ip_address
      }
      if (event.request?.cookies) delete event.request.cookies
      return event
    },
  })
}

const app = mount(App, {
  target: document.getElementById('app')!,
})

export default app
