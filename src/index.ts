/** Entrypoint: starts the HTTP listener; tests import app.ts without binding a port. */
import { createApp } from './app.ts'
import { loadConfig } from './config.ts'

const config = loadConfig()
const app = createApp({ config })

// Bun's listen() takes (port, callback); use the object form to bind the host.
app.listen({ port: config.port, hostname: config.host })

console.log(`SynCare console listening on http://${config.host}:${config.port}`)
console.log(`  Langflow:   ${config.langflowBaseUrl}`)
console.log(`  Review DB:  ${config.reviewDbPath}`)
console.log(`  Read-only:  ${config.readOnly ? 'ON' : 'off'}`)