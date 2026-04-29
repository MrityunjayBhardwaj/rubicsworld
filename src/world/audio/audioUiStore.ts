// Tiny zustand store shared by AudioPanel and SoundVisualizer. Keeps the
// "show sound debug" toggle reactive without coupling the panel to the
// visualiser's mount.

import { create } from 'zustand'

interface AudioUiState {
  showVisualizer: boolean
  setShowVisualizer: (v: boolean) => void
}

export const useAudioUi = create<AudioUiState>(set => ({
  showVisualizer: false,
  setShowVisualizer: (v) => set({ showVisualizer: v }),
}))
