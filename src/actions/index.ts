import type { ActionHandler } from 'deepspace/worker'
import type { Env } from '../../worker'
import { clearDemoData, deleteMyData, sync } from './sync'

export const actions: Record<string, ActionHandler<Env>> = { sync, deleteMyData, clearDemoData }
