import type { LocationQuery, LocationQueryRaw, Router } from 'vue-router'

import { isNavigationFailure, NavigationFailureType } from 'vue-router'

import { WINDOW_LABEL } from '@/constants'

export type WindowLabel = typeof WINDOW_LABEL[keyof typeof WINDOW_LABEL]
export type PreferenceDestination = 'preferences' | 'presets' | 'skin-library' | 'pet' | 'general' | 'about'
export interface WindowDestinationRequest {
  label: WindowLabel
  destination?: PreferenceDestination
}
export type ShowWindowRequest = WindowLabel | WindowDestinationRequest

function resolveShowWindowRequest(payload: unknown): WindowDestinationRequest | undefined {
  const request = typeof payload === 'string' ? { label: payload } : payload
  if (!request || typeof request !== 'object' || !('label' in request)) return
  if (request.label !== WINDOW_LABEL.MAIN && request.label !== WINDOW_LABEL.PREFERENCE) return
  const destination = 'destination' in request ? request.destination : undefined
  if (destination !== undefined && destination !== 'preferences'
    && destination !== 'presets' && destination !== 'skin-library'
    && destination !== 'pet' && destination !== 'general' && destination !== 'about') {
    return
  }
  return { label: request.label, destination }
}

export function preferenceQuery(query: LocationQuery, destination: PreferenceDestination): LocationQueryRaw {
  const next = { ...query }
  if (destination === 'skin-library') next.view = 'skin-library'
  else delete next.view
  if (destination === 'presets') next.tab = '0'
  if (destination === 'pet') next.tab = '1'
  if (destination === 'general') next.tab = '6'
  if (destination === 'about') next.tab = '7'
  return next
}

export function createShowWindowRequestHandler(options: {
  label: string
  router: Pick<Router, 'isReady' | 'currentRoute' | 'replace'>
  show: () => Promise<unknown>
}) {
  let queue = Promise.resolve()
  return (payload: unknown) => {
    const request = resolveShowWindowRequest(payload)
    if (!request || request.label !== options.label) return Promise.resolve()
    queue = queue.catch(() => {}).then(async () => {
      if (request.label === WINDOW_LABEL.PREFERENCE) {
        await options.router.isReady()
        // App owns the route before its RouterView mounts, retaining the target
        // while persisted settings and the hidden preference page initialize.
        const failure = await options.router.replace({
          path: '/preference',
          query: preferenceQuery(options.router.currentRoute.value.query, request.destination ?? 'preferences'),
        })
        if (failure && !isNavigationFailure(failure, NavigationFailureType.duplicated)) throw failure
      }
      await options.show()
    })
    return queue
  }
}
