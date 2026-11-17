import { create } from 'zustand'

export const useProjectDialog = create<{ open: boolean }>(() => ({ open: false }))

export const openProjects = () => useProjectDialog.setState({ open: true })
export const closeProjects = () => useProjectDialog.setState({ open: false })
