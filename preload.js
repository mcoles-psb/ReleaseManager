const { contextBridge, ipcRenderer } = require('electron');

/**
 * Exposes a safe API to the renderer process via contextBridge.
 * All Git operations go through IPC to the main process.
 * No direct Node.js access is exposed to the renderer.
 */
contextBridge.exposeInMainWorld('api', {
    // Repository Operations
    getRepositories: () => {
        console.log('[preload] getRepositories invoked');
        return ipcRenderer.invoke('repositories:list');
    },
    addRepository: (repoName, devRepoUrl, prodRepoUrl) => {
        console.log('[preload] addRepository invoked:', { repoName, devRepoUrl, prodRepoUrl });
        return ipcRenderer.invoke('repositories:add', { repoName, devRepoUrl, prodRepoUrl });
    },
    deleteRepository: (repoName) => {
        return ipcRenderer.invoke('repositories:delete', { repoName });
    },
    // Refetch clones the mirror first if it is missing from disk, then
    // fetches the latest from both DEV (origin) and PROD (prod).
    refetchRepository: (repoName) => {
        return ipcRenderer.invoke('repositories:refetch', { repoName });
    },
    // Refetches every saved repository (backs the header "Refetch All" button).
    refetchAllRepositories: () => {
        return ipcRenderer.invoke('repositories:refetchAll');
    },
    scanRepositories: () => {
        console.log('[preload] scanRepositories invoked');
        return ipcRenderer.invoke('repositories:scan');
    },

    // Branch Operations
    getBranches: (repoName) => ipcRenderer.invoke('branches:list', { repoName }),

    // Promote Operations
    promoteBranch: (repoName, branch) => ipcRenderer.invoke('promote:branch', { repoName, branch }),
    promoteBranches: (repoName, branches) => ipcRenderer.invoke('promote:branches', { repoName, branches }),

    // Revert Operations
    revertCommit: (repoName, branch, commitHash) => ipcRenderer.invoke('revert:commit', { repoName, branch, commitHash }),

    // History Operations
    getHistory: (repoName, branch, maxCount) => ipcRenderer.invoke('history:get', { repoName, branch, maxCount }),
    getDevHistory: (repoName, branch, maxCount) => ipcRenderer.invoke('history:getDev', { repoName, branch, maxCount }),

    // Compare Operations
    getCompare: (repoName, branch) => ipcRenderer.invoke('compare:get', { repoName, branch }),

    // Tag Operations
    getTags: (repoName) => ipcRenderer.invoke('tags:list', { repoName }),
    createTag: (repoName, tagName, commitHash) => ipcRenderer.invoke('tags:create', { repoName, tagName, commitHash }),
    pushTag: (repoName, tagName) => ipcRenderer.invoke('tags:push', { repoName, tagName }),

    // Core Sync Operations
    getCoreSyncStatus: () => ipcRenderer.invoke('coreSync:status'),
    runCoreSync: (repoName) => ipcRenderer.invoke('coreSync:run', { repoName }),
    // Opens a folder picker in the main process; the renderer never sends a path.
    addCoreSyncProject: () => ipcRenderer.invoke('coreSync:addProject'),
    removeCoreSyncProject: (name) => ipcRenderer.invoke('coreSync:removeProject', { name }),

    // Settings Operations
    getSettings: () => ipcRenderer.invoke('settings:get'),
    saveSettings: (settings) => ipcRenderer.invoke('settings:save', { settings }),

    // Log Operations
    getLogs: (maxLines) => ipcRenderer.invoke('logs:get', { maxLines }),
    clearLogs: () => ipcRenderer.invoke('logs:clear'),

    // App Operations
    openPath: (target) => ipcRenderer.invoke('app:openPath', { target }),
    confirm: (title, message, detail) => ipcRenderer.invoke('dialog:confirm', { title, message, detail }),
    writeToClipboard: (text) => ipcRenderer.invoke('clipboard:writeText', { text })
});
