export interface SkinLibrarySelectionState {
  multiSelect: boolean
  selectedIds: string[]
}

export interface SkinLibrarySelectionControls {
  selectedCount: number
  canApply: boolean
  canDelete: boolean
  showMultiSelection: boolean
}

function uniqueIds(ids: readonly string[]): string[] {
  return [...new Set(ids)]
}

export function createSkinLibrarySelectionState(
  activeEntryId?: string,
): SkinLibrarySelectionState {
  return {
    multiSelect: false,
    selectedIds: activeEntryId ? [activeEntryId] : [],
  }
}

export function selectSkinLibraryCard(
  state: SkinLibrarySelectionState,
  entryId: string,
): SkinLibrarySelectionState {
  if (!state.multiSelect) {
    return { multiSelect: false, selectedIds: [entryId] }
  }
  const selected = new Set(state.selectedIds)
  if (selected.has(entryId)) selected.delete(entryId)
  else selected.add(entryId)
  const selectedIds = [...selected]
  return {
    multiSelect: selectedIds.length > 0,
    selectedIds,
  }
}

export function toggleSkinLibraryCheckbox(
  state: SkinLibrarySelectionState,
  entryId: string,
): SkinLibrarySelectionState {
  if (!state.multiSelect) {
    return {
      multiSelect: true,
      selectedIds: uniqueIds([...state.selectedIds, entryId]),
    }
  }
  return selectSkinLibraryCard(state, entryId)
}

export function toggleAllSkinLibraryEntries(
  state: SkinLibrarySelectionState,
  availableEntryIds: readonly string[],
): SkinLibrarySelectionState {
  const available = uniqueIds(availableEntryIds)
  if (available.length === 0) return createSkinLibrarySelectionState()
  const availableSet = new Set(available)
  const selectedIds = uniqueIds(
    state.selectedIds.filter(entryId => availableSet.has(entryId)),
  )
  const selected = new Set(selectedIds)
  if (available.every(entryId => selected.has(entryId))) {
    return createSkinLibrarySelectionState()
  }
  for (const entryId of available) {
    if (selected.has(entryId)) continue
    selected.add(entryId)
    selectedIds.push(entryId)
  }
  return { multiSelect: true, selectedIds }
}

export function getSkinLibraryAutoApplyEntryId(
  previousState: SkinLibrarySelectionState,
  nextState: SkinLibrarySelectionState,
): string | undefined {
  if (previousState.multiSelect || nextState.selectedIds.length === 0) {
    return undefined
  }
  if (nextState.multiSelect && previousState.selectedIds.length > 0) {
    return undefined
  }
  return nextState.selectedIds[0]
}

export function reconcileSkinLibrarySelection(
  state: SkinLibrarySelectionState,
  availableEntryIds: readonly string[],
): SkinLibrarySelectionState {
  const available = new Set(availableEntryIds)
  const selectedIds = state.selectedIds.filter(entryId => available.has(entryId))
  if (selectedIds.length === 0) return createSkinLibrarySelectionState()
  return {
    multiSelect: state.multiSelect,
    selectedIds: state.multiSelect ? selectedIds : selectedIds.slice(0, 1),
  }
}

export function getSkinLibrarySelectionControls(
  state: SkinLibrarySelectionState,
): SkinLibrarySelectionControls {
  const selectedCount = state.selectedIds.length
  return {
    selectedCount,
    canApply: !state.multiSelect && selectedCount === 1,
    canDelete: selectedCount > 0,
    showMultiSelection: state.multiSelect,
  }
}
