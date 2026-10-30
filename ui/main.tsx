import { StrictMode, useEffect, useRef, useState, type ReactNode } from 'react'
import { createRoot } from 'react-dom/client'
import { startLive, useTracker } from './client'
import { isTypingTarget, keyAction, type KeyState } from './keys'
import { href, navigate, parseRoute, trackHistory, useHash, type Route } from './router'
import { isSidebarShortcut, TOGGLE_EVENT, useSidebar } from './sidebarState'
import { Home } from './views/Home'
import { IssuePage } from './views/IssuePage'
import { SearchResults } from './views/IssueList'
import { ViewScreen } from './views/ViewScreen'
import { DEFAULT_DISPLAY, type ViewState } from './viewModel'
import { NewIssueDialog } from './views/NewIssue'
import { Palette, type PaletteMode } from './views/Palette'
import { ProjectPage } from './views/ProjectPage'
import { Sidebar } from './views/Sidebar'
import { applyCachedTheme, useThemeEffect } from './theme'

function Placeholder({ title, note }: { title: string; note: string }) {
  return (
    <section className="page">
      <header className="page-head"><h1>{title}</h1></header>
      <p className="muted placeholder">{note}</p>
    </section>
  )
}

/** `#/issues`: open issues, grouped by status, most urgent first. */
const ALL_ISSUES: ViewState = { filter: {}, display: DEFAULT_DISPLAY }

/** The page for a (non-modal) route.  */
function Page({ route }: { route: Route }): ReactNode {
  const state = useTracker()
  switch (route.name) {
    case 'home': return <Home />
    case 'issue': return <IssuePage key={route.id} id={route.id} />
    case 'issues': return <ViewScreen key="issues" title="All issues" defaults={ALL_ISSUES} query={route.query} routeFor={(query) => ({ name: 'issues', query })} />
    case 'view': {
      const v = state.views.find((x) => x.slug === route.slug)
      if (!v) return <Placeholder title={route.slug} note={state.ready ? `View "${route.slug}" not found.` : 'Loading…'} />
      return <ViewScreen key={`view:${v.slug}`} title={v.name} saved={v} query={route.query} routeFor={(query) => ({ name: 'view', slug: v.slug, query })} />
    }
    case 'project': return <ProjectPage slug={route.slug} query={route.query} routeQuery={(query) => ({ name: 'project', slug: route.slug, query })} />
    case 'search': return <SearchResults q={route.q} />
    case 'new': return null
    case 'notFound': return <Placeholder title="Not found" note={`Nothing at ${route.path}.`} />
  }
}

/** Applies the chosen theme; its own component so a snapshot re-renders only this. */
function ThemeSync() {
  useThemeEffect(useTracker().themes)
  return null
}

function App() {
  const route = parseRoute(useHash())
  // `#/new` is a dialog over whatever page was showing.
  const background = useRef<Route>({ name: 'home' })
  if (route.name !== 'new') background.current = route
  const [palette, setPalette] = useState<PaletteMode | null>(null)
  const sidebar = useSidebar()
  const { toggle: toggleSidebar } = sidebar

  useEffect(() => {
    let keys: KeyState = { pendingG: null }
    const onKey = (e: KeyboardEvent) => {
      if (isSidebarShortcut(e)) {
        // Handled here, so the app's View ▸ Toggle Sidebar doesn't also act on it. A held key toggles once.
        e.preventDefault()
        if (!e.repeat) toggleSidebar()
        return
      }
      if ((e.metaKey || e.ctrlKey) && !e.altKey && e.key.toLowerCase() === 'k') {
        e.preventDefault()
        setPalette((p) => (p ? null : 'root'))
        return
      }
      if (e.metaKey || e.ctrlKey || e.altKey || e.defaultPrevented || isTypingTarget(e.target)) return
      if (document.querySelector('.overlay')) return // a dialog or the palette owns the keyboard
      const r = keyAction(keys, e.key, performance.now())
      keys = r.next
      if (!r.action) return
      e.preventDefault()
      if (r.action === 'new') navigate({ name: 'new' })
      else if (r.action === 'search') setPalette('root')
      else navigate({ name: r.action })
    }
    // The app's View ▸ Toggle Sidebar, when chosen from the menu.
    const onMenu = () => toggleSidebar()
    addEventListener('keydown', onKey)
    addEventListener(TOGGLE_EVENT, onMenu)
    return () => { removeEventListener('keydown', onKey); removeEventListener(TOGGLE_EVENT, onMenu) }
  }, [toggleSidebar])

  const closeNew = () => navigate(background.current.name === 'new' ? { name: 'home' } : background.current)
  return (
    <div className={`app${sidebar.collapsed ? ' collapsed' : ''}`}>
      <ThemeSync />
      <Sidebar route={background.current} onSearch={() => setPalette('root')} collapsed={sidebar.collapsed} onToggle={toggleSidebar} />
      <main className="main">
        <Page route={background.current} />
      </main>
      {route.name === 'new' && <NewIssueDialog key={route.parent ?? ''} parent={route.parent} onClose={closeNew} />}
      {palette && <Palette mode={palette} onClose={() => setPalette(null)} />}
    </div>
  )
}

applyCachedTheme()
startLive()
if (!location.hash) history.replaceState(history.state, '', href({ name: 'home' }))
trackHistory()
createRoot(document.getElementById('root')!).render(<StrictMode><App /></StrictMode>)
