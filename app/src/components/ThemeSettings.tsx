'use client'

import { useEffect, useSyncExternalStore } from 'react'
import { THEME_KEY, type ThemePreference } from '@/lib/theme'

function preference(): ThemePreference {
  const value = document.documentElement.dataset.themePreference
  return value === 'dark' || value === 'light' ? value : 'system'
}

function apply(value: ThemePreference) {
  const dark = value === 'dark' || (value === 'system' && window.matchMedia('(prefers-color-scheme: dark)').matches)
  document.documentElement.dataset.themePreference = value
  document.documentElement.dataset.theme = dark ? 'dark' : 'light'
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', dark ? '#101827' : '#2563eb')
  window.dispatchEvent(new Event('practice-theme-change'))
}

function subscribe(listener: () => void) {
  window.addEventListener('practice-theme-change', listener)
  return () => window.removeEventListener('practice-theme-change', listener)
}

export function ThemeController() {
  useEffect(() => {
    const media = window.matchMedia('(prefers-color-scheme: dark)')
    const update = () => apply(preference())
    const storage = (event: StorageEvent) => {
      if (event.key === THEME_KEY || event.key === null) apply(event.newValue === 'dark' || event.newValue === 'light' ? event.newValue : 'system')
    }
    update()
    media.addEventListener('change', update)
    window.addEventListener('storage', storage)
    return () => { media.removeEventListener('change', update); window.removeEventListener('storage', storage) }
  }, [])
  return null
}

export function ThemeSettings() {
  const selected = useSyncExternalStore(subscribe, preference, () => 'system' as const)
  function select(value: ThemePreference) {
    try { localStorage.setItem(THEME_KEY, value) } catch { /* Keep the preference for this page session. */ }
    apply(value)
  }
  return <fieldset className="mt-5 border-t border-gray-100 pt-4">
    <legend className="sr-only">화면 모드</legend>
    <p className="text-xs font-semibold text-gray-500 px-1 mb-2" aria-hidden="true">화면 모드</p>
    <div className="grid grid-cols-3 gap-1 rounded-xl bg-gray-100 p-1">
      {([['system', '시스템 설정'], ['light', '라이트'], ['dark', '다크']] as const).map(([value, label]) => <label key={value} className={`cursor-pointer rounded-lg px-1 py-2.5 text-center text-xs font-semibold has-focus-visible:ring-2 has-focus-visible:ring-blue-500 ${selected === value ? 'bg-white text-rb-700 shadow-sm' : 'text-gray-600'}`}>
        <input type="radio" name="theme" value={value} checked={selected === value} onChange={() => select(value)} className="sr-only" />{label}
      </label>)}
    </div>
  </fieldset>
}
