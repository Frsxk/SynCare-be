import { expect, test } from 'bun:test'
import { readGuidance,type EmergencyGuidance } from '../src/modules/alerts/guidance.ts'

test('guidance_missing_not_invented: no config has no119fallback; exact approved metadata and information-only contact retained', () => {
  expect(() => readGuidance(undefined)).toThrow('emergency_guidance_unavailable')
  expect(() => readGuidance({ content: 'incomplete', contacts: ['119'] })).toThrow()
  const approved:EmergencyGuidance = { content: 'Panduan sintetis uji', contacts: [{ label: 'Darurat medis', number: '119', action: 'information_only' }],
    region: 'Indonesia', verifiedAt: '2026-10-25T12:00:00Z', source: 'https://www.kemkes.go.id/id/akses-darurat-medis-119-kini-bisa-melalui-satusehat-mobile', version: 1 }
  expect(readGuidance(approved)).toEqual(approved)
  expect(() => readGuidance({ ...approved, contacts: [{ label: 'Call', number: '119', action: 'call' }] })).toThrow()
  expect(() => readGuidance({ ...approved, source: 'javascript:invalid' })).toThrow()
})
