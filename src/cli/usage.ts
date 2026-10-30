/** The `aitt` help texts that live outside their commands' modules. Importable without running the CLI (the docs
 * reference generator reads them); src/cli.ts prints them. */

export const USAGE = `Usage: aitt <command>   (AI Task Tracking)
  serve            run the HTTP server on the data folder (AITT_HOME, default ~/AITaskTracking)
  mcp              stdio MCP proxy
  setup            first-run setup: data folder, first project, backup, Claude Code (setup --help)
  open <ID|slug>   show an issue or project in the app (browser if the app isn't installed): aitt open ATT-1
  docs             open the user docs the engine serves (http://127.0.0.1:<port>/docs/) in the browser
  guidance         print the agent instructions for other tools (--cursor: as a .cursor/rules/*.mdc file)
  uninstall        remove the app, its login item, link, skill and MCP entries; keeps the data (--yes: don't ask)
  bench <n>        time open/snapshot/search on n synthetic issues`

export const GUIDANCE_USAGE = 'usage: aitt guidance [--cursor]'
export const BENCH_USAGE = 'usage: aitt bench <n>'
export const DOCS_USAGE = 'usage: aitt docs'
