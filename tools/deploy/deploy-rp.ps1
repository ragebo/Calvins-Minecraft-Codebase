# Deploys the resource pack (BountySys_RP) from the repo to the game and re-pins the worlds. See docs/DEPLOY.md for the whole procedure.
#
#   deploy-rp.ps1 -From 1,0,28 -To 1,0,29 -DryRun   (-From is what the pins read now: read them, do not assume)
#
#   deploy-rp.ps1 -DryRun     checks everything and lists what would change; writes NOTHING
#   deploy-rp.ps1             backup, copy, delete the files the repo no longer has, re-pin, verify
#   deploy-rp.ps1 -Force      skips the "a world is open" guard (do not, unless the game is closed)
#
# The repo's RP manifest is bumped by hand and committed beforehand; this script only copies it.
# The game's sounds\ folder (the music, which is not in the repo) is never read for copying, deleted or
# changed, and a hash of it before and after proves that.
param(
    [switch]$DryRun,
    [switch]$Force,
    [Parameter(Mandatory)] [int[]]$From,
    [Parameter(Mandatory)] [int[]]$To
)

$ErrorActionPreference = 'Stop'

$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$repoRp = Join-Path $repoRoot 'BountySys_RP'
$mojang = Join-Path $env:APPDATA 'Minecraft Bedrock\Users\Shared\games\com.mojang'
$gameRp = Join-Path $mojang 'development_resource_packs\BountySys_RP'

# THIS MACHINE: see deploy.ps1.
$worlds = Join-Path $env:APPDATA 'Minecraft Bedrock\Users\9123740906447652967\games\com.mojang\minecraftWorlds'
$pinned = @('1CbLDrRsOsM=', 'iR2Sirl-Uuk=', 'knjYoJNIWvQ=', 'rD4+xNXIUpM=')
$packId = 'd834fa56-3296-4625-97d6-f50876e2f561'
$pinName = 'world_resource_packs.json'
$backup = Join-Path $PSScriptRoot 'backup-rp-before-deploy'

$fromDots = ($From -join '.'); $toDots = ($To -join '.')
$problems = New-Object System.Collections.Generic.List[string]
function Note($text) { Write-Output $text }
function Problem($text) { $problems.Add($text); Write-Output "  PROBLEM: $text" }

function Read-Utf8($path) {
    $bytes = [IO.File]::ReadAllBytes($path)
    $bom = ($bytes.Length -ge 3 -and $bytes[0] -eq 0xEF -and $bytes[1] -eq 0xBB -and $bytes[2] -eq 0xBF)
    $skip = if ($bom) { 3 } else { 0 }
    return @{ Text = [Text.Encoding]::UTF8.GetString($bytes, $skip, $bytes.Length - $skip); Bom = $bom }
}
function Write-Utf8($path, $text, $bom) {
    $bytes = (New-Object Text.UTF8Encoding($false)).GetBytes($text)
    if ($bom) { $bytes = [byte[]](0xEF, 0xBB, 0xBF) + $bytes }
    [IO.File]::WriteAllBytes($path, $bytes)
}

# Every file under a pack folder except sounds\, keyed by its path inside the pack.
function Get-Hashes($root) {
    $map = @{}
    Get-ChildItem -LiteralPath $root -Recurse -File | Where-Object { $_.FullName.Substring($root.Length + 1) -notlike 'sounds\*' } | ForEach-Object {
        $map[$_.FullName.Substring($root.Length + 1)] = (Get-FileHash -LiteralPath $_.FullName -Algorithm SHA256).Hash
    }
    return $map
}
function Get-SoundsHash($root) {
    $dir = Join-Path $root 'sounds'
    if (-not (Test-Path -LiteralPath $dir)) { return 'none' }
    $all = Get-ChildItem -LiteralPath $dir -Recurse -File | Sort-Object FullName | ForEach-Object { "$($_.FullName.Substring($dir.Length)):$((Get-FileHash -LiteralPath $_.FullName -Algorithm SHA256).Hash)" }
    return ($all -join '|')
}

Note "=== resource pack deploy $fromDots -> $toDots $(if ($DryRun) { '(DRY RUN: nothing is written)' } else { '(REAL RUN)' }) ==="

# ---------------------------------------------------------------- 1. is a world open?
Note "`n[1] Is a world open right now?"
$open = @()
foreach ($name in $pinned) {
    $db = Join-Path (Join-Path $worlds $name) 'db'
    $state = 'closed'
    foreach ($file in @(Get-ChildItem -LiteralPath $db -File | Where-Object { $_.Name -like 'MANIFEST-*' })) {
        try { $stream = [IO.File]::Open($file.FullName, 'Open', 'ReadWrite', 'None'); $stream.Close() }
        catch [System.IO.IOException] { $state = 'OPEN' }
    }
    Note ("    {0,-14} {1}" -f $name, $(if ($state -eq 'OPEN') { 'OPEN in a running game (database held exclusively)' } else { 'closed' }))
    if ($state -eq 'OPEN') { $open += $name }
}
if ($open.Count -gt 0) {
    if ($Force) { Note "    a world is open ($($open -join ', ')), continuing because of -Force" }
    else { Problem "a world is open ($($open -join ', ')). Leave the world (the main menu is enough), then run again." }
}

# ---------------------------------------------------------------- 2. the manifests
Note "`n[2] Manifests"
$repoManifest = (Read-Utf8 (Join-Path $repoRp 'manifest.json')).Text | ConvertFrom-Json
$gameManifest = (Read-Utf8 (Join-Path $gameRp 'manifest.json')).Text | ConvertFrom-Json
$repoVersion = ($repoManifest.header.version -join '.')
Note "    repo manifest header $repoVersion, modules $(($repoManifest.modules | ForEach-Object { $_.version -join '.' }) -join ' / ')"
Note "    game manifest header $($gameManifest.header.version -join '.')"
if ($repoManifest.header.uuid -ne $packId) { Problem "the repo manifest uuid $($repoManifest.header.uuid) is not the pack id this script pins" }
if ($repoVersion -ne $toDots) { Problem "the repo manifest is at $repoVersion but this deploy is meant to reach ${toDots}; bump and commit it first" }
foreach ($m in $repoManifest.modules) { if (($m.version -join '.') -ne $toDots) { Problem "a module in the repo manifest is at $($m.version -join '.'), not $toDots" } }

# ---------------------------------------------------------------- 3. the world pins
Note "`n[3] World pins"
# A pin is set to the new version whatever it says now: the game rewrites these files whenever it loads a
# world, and once wrote an older version back (it had scanned the pack before this deploy).
$pinAny = '("pack_id"\s*:\s*"' + [regex]::Escape($packId) + '"\s*,\s*"version"\s*:\s*\[\s*)([\d,\s]+?)(\s*\])'
$pinNew = '("pack_id"\s*:\s*"' + [regex]::Escape($packId) + '"\s*,\s*"version"\s*:\s*\[\s*)' + (($To | ForEach-Object { [string]$_ }) -join ',\s*') + '(\s*\])'
foreach ($name in $pinned) {
    $text = (Read-Utf8 (Join-Path (Join-Path $worlds $name) $pinName)).Text
    $found = [regex]::Matches($text, $pinAny)
    if ($found.Count -eq 1) { Note ("    {0,-14} now at {1}" -f $name, ($found[0].Groups[2].Value -replace '\s', '')) }
    else { Problem "$pinName for $name holds $($found.Count) entries for the pack, not exactly one" }
}
$running = @(Get-Process | Where-Object { $_.ProcessName -match 'Minecraft' })
if ($running.Count -gt 0) {
    if ($Force) { Note "`n    Minecraft is running, continuing because of -Force: it will not load the new pack until it is relaunched." }
    else { Problem "Minecraft is running. It read the resource pack when it launched, so a pack changed now is not loaded, and the next world load writes the old version back into the world's pin. Quit it fully (not just the world), then run again." }
}
else { Note "`n    Minecraft is not running: the next launch will read the new pack." }

# ---------------------------------------------------------------- 4. what differs now
Note "`n[4] Files that differ between the repo and the game (sounds\ is left out on purpose)"
$repoHashes = Get-Hashes $repoRp
$gameHashes = Get-Hashes $gameRp
$changed = @($repoHashes.Keys | Where-Object { $gameHashes.ContainsKey($_) -and $gameHashes[$_] -ne $repoHashes[$_] } | Sort-Object)
$added = @($repoHashes.Keys | Where-Object { -not $gameHashes.ContainsKey($_) } | Sort-Object)
$removed = @($gameHashes.Keys | Where-Object { -not $repoHashes.ContainsKey($_) } | Sort-Object)
Note "    changed: $($changed.Count)   new: $($added.Count)   only in the game (will be deleted): $($removed.Count)"
$changed | ForEach-Object { Note "      changed  $_" }
$added | ForEach-Object { Note "      new      $_" }
$removed | ForEach-Object { Note "      DELETE   $_" }
$soundsBefore = Get-SoundsHash $gameRp
Note "    sounds\ files in the game: $((Get-ChildItem -LiteralPath (Join-Path $gameRp 'sounds') -Recurse -File -ErrorAction SilentlyContinue | Measure-Object).Count) (not touched)"

if ($problems.Count -gt 0) { Note "`n=== STOPPING: $($problems.Count) problem(s) above. Nothing was written. ==="; exit 1 }
if ($DryRun) { Note "`n=== dry run finished: every check passed, nothing was written ==="; exit 0 }

# ---------------------------------------------------------------- 5. backup, then write
Note "`n[5] Backup to $backup"
if (Test-Path -LiteralPath $backup) { Remove-Item -LiteralPath $backup -Recurse -Force }
New-Item -ItemType Directory -Path $backup | Out-Null
foreach ($rel in $gameHashes.Keys) {
    $dest = Join-Path (Join-Path $backup 'pack') $rel
    New-Item -ItemType Directory -Path (Split-Path $dest) -Force | Out-Null
    Copy-Item -LiteralPath (Join-Path $gameRp $rel) -Destination $dest
}
foreach ($name in $pinned) {
    $dest = Join-Path (Join-Path $backup 'pins') $name
    New-Item -ItemType Directory -Path $dest -Force | Out-Null
    Copy-Item -LiteralPath (Join-Path (Join-Path $worlds $name) $pinName) -Destination $dest
}
Note "    backed up $($gameHashes.Count) pack files and the 4 pin files"

Note "`n[6] Copy to the game folder"
foreach ($rel in @($changed + $added)) {
    $dest = Join-Path $gameRp $rel
    New-Item -ItemType Directory -Path (Split-Path $dest) -Force | Out-Null
    Copy-Item -LiteralPath (Join-Path $repoRp $rel) -Destination $dest -Force
}
foreach ($rel in $removed) {
    Remove-Item -LiteralPath (Join-Path $gameRp $rel) -Force
    # An emptied folder goes too (attachables\ once its one file is gone), but never sounds\.
    $dir = Split-Path (Join-Path $gameRp $rel)
    while ($dir.Length -gt $gameRp.Length -and -not (Get-ChildItem -LiteralPath $dir -Force)) {
        Remove-Item -LiteralPath $dir -Force
        $dir = Split-Path $dir
    }
}
Note "    copied $($changed.Count + $added.Count) file(s), deleted $($removed.Count)"

Note "`n[7] Re-pin the worlds"
foreach ($name in $pinned) {
    $pin = Join-Path (Join-Path $worlds $name) $pinName
    $file = Read-Utf8 $pin
    if ([regex]::Matches($file.Text, $pinNew).Count -eq 1) {
        Note "    $name  already at $toDots"
    } elseif ([regex]::Matches($file.Text, $pinAny).Count -eq 1) {
        Write-Utf8 $pin ([regex]::Replace($file.Text, $pinAny, ('${1}' + ($To -join ', ') + '${3}'))) $file.Bom
        Note "    $name  -> $toDots"
    } else { throw "$pinName for $name changed while the deploy was running" }
}

# ---------------------------------------------------------------- 8. verify
Note "`n[8] Verify"
$repoHashes = Get-Hashes $repoRp
$gameHashes = Get-Hashes $gameRp
$bad = @($repoHashes.Keys | Where-Object { -not $gameHashes.ContainsKey($_) -or $gameHashes[$_] -ne $repoHashes[$_] })
$extra = @($gameHashes.Keys | Where-Object { -not $repoHashes.ContainsKey($_) })
if ($bad.Count -eq 0 -and $extra.Count -eq 0) { Note "    all $($repoHashes.Count) files match the repo byte for byte, nothing extra" }
else { $bad + $extra | ForEach-Object { Problem "mismatch: $_" } }
if ((Get-SoundsHash $gameRp) -eq $soundsBefore) { Note "    sounds\ is byte for byte what it was before" } else { Problem "sounds\ changed" }
$deployed = (Get-Content -LiteralPath (Join-Path $gameRp 'manifest.json') -Raw | ConvertFrom-Json)
Note "    game manifest header $($deployed.header.version -join '.'), modules $(($deployed.modules | ForEach-Object { $_.version -join '.' }) -join ' / ')"
foreach ($name in $pinned) {
    $text = (Read-Utf8 (Join-Path (Join-Path $worlds $name) $pinName)).Text
    $ok = [regex]::Matches($text, $pinNew).Count -eq 1
    Note ("    pin {0,-14} {1}" -f $name, $(if ($ok) { "at $toDots" } else { 'NOT at the new version' }))
    if (-not $ok) { Problem "pin for $name is not at $toDots" }
}

if ($problems.Count -gt 0) { Note "`n=== FINISHED WITH $($problems.Count) PROBLEM(S) ==="; exit 1 }
Note "`n=== deployed $toDots. Rollback copy is in $backup ==="
