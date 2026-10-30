/** Settings from the environment: AITT_<NAME>. */
export type AittVar = 'HOME' | 'PORT' | 'MCP_TIMEOUT_MS' | 'PARENT_LIFELINE' | 'WORKSPACE'

export function aittEnv(name: AittVar, env: Record<string, string | undefined> = process.env): string | undefined {
  return env[`AITT_${name}`] || undefined
}

/** The data folder for a new install when nothing else says where it is. */
export const DEFAULT_HOME_DIR = 'AITaskTracking'
