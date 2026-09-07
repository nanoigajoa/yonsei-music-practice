export type ThemePreference = 'system' | 'light' | 'dark'
export const THEME_KEY = 'practice-theme'

// Apply before first paint so a saved dark preference does not flash a white page.
export const THEME_INIT_SCRIPT = `(function(){var p='system';try{var s=localStorage.getItem('practice-theme');if(s==='light'||s==='dark')p=s}catch(e){}var d=p==='dark'||(p==='system'&&matchMedia('(prefers-color-scheme: dark)').matches);document.documentElement.dataset.themePreference=p;document.documentElement.dataset.theme=d?'dark':'light'})()`
