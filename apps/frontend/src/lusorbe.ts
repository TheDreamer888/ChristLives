/** Instância única do SDK para toda a app (sessão por cookie httpOnly). */
import { LusorbeClient } from '@lusorbe/sdk'

export const API_BASE: string = import.meta.env['VITE_API_BASE_URL'] ?? 'http://localhost:8000'

export const lusorbe = new LusorbeClient({ baseUrl: API_BASE })
