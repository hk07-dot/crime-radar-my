# Publish Crime Radar MY to GitHub Pages, or publish later changes.
# Double-click publish-to-github.cmd (it runs this script), or run:
#   powershell -ExecutionPolicy Bypass -File publish-to-github.ps1
#
# What it does:
#   1. Installs Git and the GitHub CLI with winget if they're missing.
#   2. Signs you in to GitHub in your browser (first time only).
#   3. Writes the GitHub Actions workflow (.github/workflows/update.yml).
#   4. First time: creates a public repository, turns on GitHub Pages and optional settings.
#   5. Uploads the project, watches the first run, and prints your site's address.
# Running it again publishes your code changes. The collected data on GitHub is kept: it is newer
# than the copy on this computer, so this script takes GitHub's copy of data/ before uploading.

$ErrorActionPreference = 'Stop'
$RepoName = 'crime-radar-my'
Set-Location -LiteralPath $PSScriptRoot

function Say($text) { Write-Host ''; Write-Host "== $text" -ForegroundColor Cyan }
function Fail($text) { Write-Host ''; Write-Host "Stopped: $text" -ForegroundColor Red; Read-Host 'Press Enter to close'; exit 1 }
function Refresh-Path { $env:Path = [Environment]::GetEnvironmentVariable('Path', 'Machine') + ';' + [Environment]::GetEnvironmentVariable('Path', 'User') }
function Have($cmd) { [bool](Get-Command $cmd -ErrorAction SilentlyContinue) }
# Runs a native command; returns $true when it exits with 0. Keeps going on errors so we can decide.
function Try-Run([scriptblock]$block) {
  $old = $ErrorActionPreference; $ErrorActionPreference = 'Continue'
  try { & $block 2>&1 | Out-Host; return ($LASTEXITCODE -eq 0) } finally { $ErrorActionPreference = $old }
}
function Must-Run([scriptblock]$block, $what) { if (-not (Try-Run $block)) { Fail "$what failed. See the message above." } }

if (-not (Test-Path 'package.json') -or -not (Test-Path 'server.js')) { Fail "Put this script in the crime-radar-my folder (next to package.json) and run it from there." }

# ---------- 1. Tools ----------
Say 'Checking for Git and the GitHub CLI'
foreach ($tool in @(@{ cmd = 'git'; id = 'Git.Git'; name = 'Git' }, @{ cmd = 'gh'; id = 'GitHub.cli'; name = 'GitHub CLI' })) {
  if (-not (Have $tool.cmd)) {
    if (-not (Have 'winget')) { Fail "$($tool.name) isn't installed and winget isn't available. Install $($tool.name) yourself, then run this again." }
    Write-Host "Installing $($tool.name)..."
    Must-Run { winget install --id $tool.id -e --source winget --accept-package-agreements --accept-source-agreements } "Installing $($tool.name)"
    Refresh-Path
    if (-not (Have $tool.cmd)) { Fail "$($tool.name) was installed but this window can't see it yet. Close this window and run the script again." }
  }
}
Write-Host 'Git and the GitHub CLI are ready.'

# ---------- 2. Sign in ----------
Say 'Signing in to GitHub'
if (-not (Try-Run { gh auth status })) {
  Write-Host 'Your browser will open. Copy the one-time code shown here, paste it on the GitHub page, and approve.'
  Must-Run { gh auth login --hostname github.com --git-protocol https --web --scopes workflow } 'Signing in'
} else {
  # Uploading a workflow file needs the "workflow" permission; add it if this sign-in doesn't have it.
  $scopes = (& gh auth status 2>&1 | Out-String)
  if ($scopes -notmatch 'workflow') {
    Write-Host 'Adding permission to upload the workflow file (your browser may open).'
    Must-Run { gh auth refresh --hostname github.com --scopes workflow } 'Adding the workflow permission'
  }
}
Must-Run { gh auth setup-git } 'Connecting Git to your GitHub sign-in'
$Owner = (& gh api user --jq .login).Trim()
$UserId = (& gh api user --jq .id).Trim()
if (-not $Owner) { Fail "Couldn't read your GitHub username." }
Write-Host "Signed in as $Owner."

# ---------- 3. Workflow file ----------
Say 'Writing the GitHub Actions workflow'
$workflow = @'
# Collects crime reports every 30 minutes and publishes the map to GitHub Pages.
# Setup (once): Settings -> Pages -> Build and deployment -> Source: "GitHub Actions".
name: Update and publish

on:
  schedule:
    - cron: "7,37 * * * *"   # every 30 minutes (UTC); GitHub may start runs a little late when busy
  workflow_dispatch:          # "Run workflow" button on the Actions tab
  push:
    branches: [main]          # publish straight away when you change the code

permissions:
  contents: write   # save collected data back to the repository
  pages: write      # publish the site
  id-token: write

concurrency:
  group: update-and-publish
  cancel-in-progress: false

jobs:
  update:
    runs-on: ubuntu-latest
    timeout-minutes: 30
    environment:
      name: github-pages
      url: ${{ steps.deploy.outputs.page_url }}
    steps:
      - uses: actions/checkout@v4

      - uses: actions/setup-node@v4
        with:
          node-version: 22

      - name: Collect reports and build the site
        run: node scripts/update.js
        env:
          # Optional, under Settings -> Secrets and variables -> Actions:
          #   variable GEOCODER_UA, e.g. "CrimeRadarMY/0.1 (your-email@example.com)"
          #   secrets BLUESKY_HANDLE and BLUESKY_APP_PASSWORD to include Bluesky posts
          GEOCODER_UA: ${{ vars.GEOCODER_UA }}
          BLUESKY_HANDLE: ${{ secrets.BLUESKY_HANDLE }}
          BLUESKY_APP_PASSWORD: ${{ secrets.BLUESKY_APP_PASSWORD }}
          MAX_PER_RUN: "150"   # keeps each run short; the two-month backfill spreads over several runs

      - name: Save collected data
        run: |
          git config user.name "github-actions[bot]"
          git config user.email "41898282+github-actions[bot]@users.noreply.github.com"
          git add data docs
          if git diff --cached --quiet; then
            echo "No changes to save."
          else
            git commit -m "Update crime data"
            git pull --rebase --autostash || true
            git push
          fi

      - uses: actions/configure-pages@v5

      - uses: actions/upload-pages-artifact@v3
        with:
          path: docs

      - id: deploy
        uses: actions/deploy-pages@v4
'@
New-Item -ItemType Directory -Force -Path '.github\workflows' | Out-Null
[IO.File]::WriteAllText((Join-Path $PSScriptRoot '.github\workflows\update.yml'), $workflow.Replace("`r`n", "`n"), (New-Object Text.UTF8Encoding $false))
# The extra index.html next to package.json isn't used by the app; keep it out of the repository.
$ignore = if (Test-Path '.gitignore') { Get-Content '.gitignore' -Raw } else { '' }
if ($ignore -notmatch '(?m)^/index\.html\s*$') { Add-Content '.gitignore' "`n/index.html" }
Write-Host 'Done.'

# ---------- 4. Repository ----------
$Full = "$Owner/$RepoName"
$exists = Try-Run { gh repo view $Full --json name | Out-Null }
if (-not (Test-Path '.git')) {
  Must-Run { git init -b main } 'Setting up Git in this folder'
}
Must-Run { git config user.name $Owner } 'Setting your Git name'
Must-Run { git config user.email "$UserId+$Owner@users.noreply.github.com" } 'Setting your Git email'
Must-Run { git branch -M main } 'Naming the main branch'

if (-not $exists) {
  Say "Creating the public repository $Full"
  Must-Run { gh repo create $Full --public --description 'Map of crime reports near you in Malaysia' } 'Creating the repository'

  Say 'Optional settings (press Enter to skip each one)'
  $email = Read-Host 'Contact email for the map lookups (recommended by OpenStreetMap)'
  if ($email) { Must-Run { gh variable set GEOCODER_UA --repo $Full --body "CrimeRadarMY/0.1 ($email)" } 'Saving the contact email' }
  $bsky = Read-Host 'Bluesky handle for social posts, e.g. name.bsky.social'
  if ($bsky) {
    $pass = Read-Host 'Bluesky app password (Settings > Privacy and security > App passwords)'
    Must-Run { gh secret set BLUESKY_HANDLE --repo $Full --body $bsky } 'Saving the Bluesky handle'
    if ($pass) { Must-Run { gh secret set BLUESKY_APP_PASSWORD --repo $Full --body $pass } 'Saving the Bluesky app password' }
  }
}

$remote = (& git remote 2>$null) -join ' '
if ($remote -notmatch '\borigin\b') { Must-Run { git remote add origin "https://github.com/$Full.git" } 'Linking this folder to the repository' }

# ---------- 5. Upload ----------
Say 'Uploading the project'
$hasRemoteMain = Try-Run { git fetch origin main }
if ($hasRemoteMain) {
  # GitHub's data is newer than this computer's: take it before uploading code changes.
  Must-Run { git checkout origin/main -- data } "Taking GitHub's copy of the collected data"
  if (-not (Try-Run { git rev-parse --verify HEAD | Out-Null })) { Must-Run { git reset --soft origin/main } 'Matching GitHub history' }
}
Must-Run { git add -A } 'Preparing the files'
$changes = Try-Run { git diff --cached --quiet }
if (-not $changes) {
  Must-Run { git commit -m "Publish Crime Radar MY $(Get-Date -Format 'yyyy-MM-dd HH:mm')" } 'Saving the changes'
} else {
  Write-Host 'No code changes since the last upload.'
}
if ($hasRemoteMain) { Must-Run { git pull --rebase -X theirs origin main } 'Combining with the latest data on GitHub' }
Must-Run { git push -u origin main } 'Uploading'

# Pages is turned on after the first upload: GitHub won't set it up on an empty repository.
# The first run spends several minutes collecting news before it publishes, so this is in time.
Say 'Making sure GitHub Pages is on (published by GitHub Actions)'
if (-not (Try-Run { gh api "repos/$Full/pages" --jq .build_type | Out-Null })) {
  Must-Run { gh api -X POST "repos/$Full/pages" -f build_type=workflow | Out-Null } 'Turning on GitHub Pages'
} else {
  Must-Run { gh api -X PUT "repos/$Full/pages" -f build_type=workflow | Out-Null } 'Setting GitHub Pages to publish from GitHub Actions'
}

# ---------- 6. First run ----------
$site = "https://$Owner.github.io/$RepoName/"
Say 'Waiting for GitHub to collect data and publish the site (usually 3-10 minutes)'
Start-Sleep -Seconds 8
$runId = (& gh run list --repo $Full --workflow update.yml --limit 1 --json databaseId --jq '.[0].databaseId' 2>$null)
if (-not $runId) { Must-Run { gh workflow run update.yml --repo $Full } 'Starting the workflow'; Start-Sleep -Seconds 8
  $runId = (& gh run list --repo $Full --workflow update.yml --limit 1 --json databaseId --jq '.[0].databaseId') }
if ($runId -and (Try-Run { gh run watch $runId.Trim() --repo $Full --exit-status })) {
  Write-Host ''
  Write-Host "Published: $site" -ForegroundColor Green
  Write-Host 'It updates by itself every 30 minutes. Run this script again to publish code changes.'
  Start-Process $site
} else {
  Write-Host ''
  Write-Host "The run didn't finish cleanly. Open https://github.com/$Full/actions, click the failed run, and copy the red step's log." -ForegroundColor Yellow
}
Read-Host 'Press Enter to close'
