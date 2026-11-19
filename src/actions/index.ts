import type { ActionHandler } from 'deepspace/worker'
import type { Env } from '../../worker'
import { sync } from './sync'

export const actions: Record<string, ActionHandler<Env>> = { sync }
