# PSBUniverse Release Manager

Internal Electron desktop tool for promoting source code from **DEV** to **PROD** GitHub organizations using Git bare mirror repositories.

## Overview

Release Manager manages a set of local **bare mirror clones** — one per repository — each configured with two remotes:

- `origin` -> the DEV organization repo (`PSBUniverse-DEV`)
- `prod` -> the PROD organization repo (`PSBUniverse-PROD`)

Because mirrors are bare (no working tree), there's no source code ever checked out on disk, no risk of accidentally editing files, and no way to introduce local changes. Promotion is strictly repository-to-repository.

DEV Repo -> Review -> git fetch origin -> git push prod main -> PROD Repo

## Features

- **Repository Manager** — add, refetch, and delete Git mirror repositories. Refetch clones the mirror if it is missing from disk, then fetches the latest from DEV and PROD. Nothing is cloned automatically at startup; use the header's **Refetch All** button to refetch and clone every saved repository at once.
- **Dashboard** — quick overview of all registered repositories.
- **Promote** — side-by-side DEV vs PROD commit history for a branch, with unpromoted DEV commits flagged as Pending. One-click promote (fetch + push) with a confirmation dialog.
- **Compare** — shows commits present in DEV but not yet in PROD, plus a summary (commit count, changed files, latest commit on each side).
- **History** — browse PROD's commit history for any repository/branch.
- **Revert** — safely revert a specific PROD commit using git revert (creates a new commit, does not rewrite history).
- **Settings** — configure DEV/PROD org names, mirror directory, default branch, log retention, and confirmation prompts.
- **Sync Core** — keeps its own list of project working folders (added with **+ Add Project**, removed with **Remove**), shows whether each is behind core, and runs core's `scripts/sync-repo.ps1` for one project or for all of them. This is the one feature that uses working folders rather than the bare mirrors, and it is independent of the Repositories page.
- **Log Console** — persistent, timestamped log of every Git operation, with daily rotating log files on disk.

## Requirements

- Node.js (project tested with Node 24.x)
- Git installed and available on PATH
- HTTPS access to GitHub, authenticated via Git Credential Manager (or a cached Personal Access Token) — no SSH keys required

## Installation

cd ReleaseManager
npm install

## Running

npm start

## How Promotion Works

1. Repositories are cloned as bare mirrors:
   git clone --mirror https://github.com/PSBUniverse-DEV/<repo>.git

2. A prod remote is added pointing at the PROD org repo.

3. Promoting a branch runs:
   git fetch origin
   git fetch prod
   git push prod <branch>

4. No force pushing. No history rewriting. No local working files.
   
## Project Structure

ReleaseManager/

**repositories.json, settings.json**

├── Config/              

**daily rotating log files**

├── Logs/                

**bare mirror repositories live here**

├── GitHubPromotion/     

**renderer page logic**

├── js/                  

**renderer page HTML fragments**

├── pages/               

**app styling**

├── css/                 

**main-process services (git, repositories, tags, settings, logging)**

├── services/            

**Electron main process**

├── main.js              

**contextBridge API exposed to renderer**

├── preload.js          

**app shell**

└── index.html           

## Notes

- Repositories must be added with matching names/branches on both DEV and PROD orgs.
- The app confirms before any destructive action (promote, revert, remove repository) unless disabled in Settings.
- All Git operations are logged with full stdout/stderr for troubleshooting via the Log Console or the Logs/ directory.
