# Deploys the built behavior pack from the repo to the game and moves the version pins of the worlds. See docs/DEPLOY.md for the whole procedure.
#
#   deploy.ps1 -From 0,2,9 -To 0,2,10 -DryRun     (-From is what the pins read now: read them, do not assume)
#
#   deploy.ps1 -DryRun     checks everything and lists what would change; writes NOTHING
#   deploy.ps1             does it: backup, bump the repo manifest, copy, re-pin the worlds, verify
#   deploy.ps1 -Force      skips the "a world looks open" guard (do not, unless the game is closed)
#
# Recipe (from the project notes): scripts mirrored with /MIR, items/entities/loot_tables/dialogue with /E,
# the manifest copied, every world that pins the pack moved to the new version. The resource pack and
# its sounds/ folder are never touched.
param(
    [switch]$DryRun,
    [switch]$Force,
    [Parameter(Mandatory)] [int[]]$From,
    [Parameter(Mandatory)] [int[]]$To
)

$ErrorActionPreference = 'Stop'

$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$repoBp = Join-Path $repoRoot 'your_pack_name_BP'
$mojang = Join-Path $env:APPDATA 'Minecraft Bedrock\Users\Shared\games\com.mojang'
$gameBp = Join-Path $mojang 'development_behavior_packs\your_pack_name_BP'

# THIS MACHINE: the Xbox user folder that holds the worlds, and the folder names of the worlds that use the pack. Change both on another machine
# (list the worlds with their names, and read each world's world_behavior_packs.json to see that it holds the pack's id below).
$worlds = Join-Path $env:APPDATA 'Minecraft Bedrock\Users\9123740906447652967\games\com.mojang\minecraftWorlds'
$pinned = @('1CbLDrRsOsM=', 'iR2Sirl-Uuk=', 'knjYoJNIWvQ=', 'rD4+xNXIUpM=')
$packId = 'b8f707c3-9ce5-470d-8cad-081de86c10ac'
$backup = Join-Path $PSScriptRoot 'backup-before-deploy'
# Every top-level folder of the pack that is deployed. `dialogue` (NPC dialogue scenes) was added with the NPC shops: before that
# nothing here knew it, and a pack folder the deploy does not copy fails SILENTLY (the game just lacks the scenes), so step 0
# below stops the run for any top-level folder that is not in this list.
$folders = @('scripts', 'items', 'entities', 'loot_tables', 'dialogue')

$fromText = ($From -join ', ')      # the manifest spells versions as [0, 1, 4]
$toText = ($To -join ', ')
$fromDots = ($From -join '.')
$toDots = ($To -join '.')

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

Note "=== deploy $fromDots -> $toDots $(if ($DryRun) { '(DRY RUN: nothing is written)' } else { '(REAL RUN)' }) ==="

# ---------------------------------------------------------------- 0. does the pack have a folder this script would skip?
Note "`n[0] Top-level folders of the pack"
$topLevel = @(Get-ChildItem -LiteralPath $repoBp -Directory | ForEach-Object { $_.Name })
foreach ($dir in $topLevel) {
    $isDeployed = $folders -contains $dir
    Note ("    {0,-14} {1}" -f $dir, $(if ($isDeployed) { 'deployed' } else { 'NOT COPIED by this script' }))
    if (-not $isDeployed) { Problem "the pack has a top-level folder '$dir' that this script does not copy (add it to `$folders): the game would silently lack it" }
}

# ---------------------------------------------------------------- 1. is a world open?
Note "`n[1] Is a world open right now?"
# A world that is loaded keeps its database MANIFEST open exclusively; a closed one can be opened.
# (Write times are no good for this: an open world can go many minutes without a write.)
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

# ---------------------------------------------------------------- 2. the manifest bump
Note "`n[2] Manifest: $repoBp\manifest.json"
$manifestPath = Join-Path $repoBp 'manifest.json'
$manifest = Read-Utf8 $manifestPath
$fromPattern = [regex]::Escape("[$fromText]")
$hits = [regex]::Matches($manifest.Text, $fromPattern).Count
$already = [regex]::Matches($manifest.Text, [regex]::Escape("[$toText]")).Count
Note "    occurrences of [$fromText]: $hits   of [$toText]: $already"
if ($hits -eq 3) { Note "    will bump header, data module and script module" }
elseif ($hits -eq 0 -and $already -eq 3) { Note "    already bumped in the repo, will not change it again" }
else { Problem "expected exactly 3 versions to bump, found $hits (and $already already at the new version)" }

# ---------------------------------------------------------------- 3. the world pins
Note "`n[3] World pins"
$pinPattern = '("pack_id"\s*:\s*"' + [regex]::Escape($packId) + '"\s*,\s*"version"\s*:\s*\[\s*)' + (($From | ForEach-Object { [string]$_ }) -join ',\s*') + '(\s*\])'
$pinPatternNew = '("pack_id"\s*:\s*"' + [regex]::Escape($packId) + '"\s*,\s*"version"\s*:\s*\[\s*)' + (($To | ForEach-Object { [string]$_ }) -join ',\s*') + '(\s*\])'
foreach ($name in $pinned) {
    $pin = Join-Path (Join-Path $worlds $name) 'world_behavior_packs.json'
    $text = (Read-Utf8 $pin).Text
    $old = [regex]::Matches($text, $pinPattern).Count
    $new = [regex]::Matches($text, $pinPatternNew).Count
    Note ("    {0,-14} at {1}: {2}   at {3}: {4}" -f $name, $fromDots, $old, $toDots, $new)
    if (-not (($old -eq 1 -and $new -eq 0) -or ($old -eq 0 -and $new -eq 1))) { Problem "pin file for $name does not hold exactly one entry for the pack" }
}

# ---------------------------------------------------------------- 4. what differs now
Note "`n[4] Files that differ between the repo build and the game folder (before this run)"
function Get-Hashes($root) {
    $map = @{}
    foreach ($f in $folders) {
        $dir = Join-Path $root $f
        if (Test-Path -LiteralPath $dir) {
            Get-ChildItem -LiteralPath $dir -Recurse -File | ForEach-Object { $map[$_.FullName.Substring($root.Length + 1)] = (Get-FileHash -LiteralPath $_.FullName -Algorithm SHA256).Hash }
        }
    }
    $map['manifest.json'] = (Get-FileHash -LiteralPath (Join-Path $root 'manifest.json') -Algorithm SHA256).Hash
    return $map
}
$repoHashes = Get-Hashes $repoBp
$gameHashes = Get-Hashes $gameBp
$changed = @($repoHashes.Keys | Where-Object { $gameHashes.ContainsKey($_) -and $gameHashes[$_] -ne $repoHashes[$_] } | Sort-Object)
$added = @($repoHashes.Keys | Where-Object { -not $gameHashes.ContainsKey($_) } | Sort-Object)
# Only scripts is mirrored, so only there is a file that exists in the game folder alone something to remove.
$removed = @($gameHashes.Keys | Where-Object { -not $repoHashes.ContainsKey($_) -and $_ -like 'scripts\*' } | Sort-Object)
Note "    changed: $($changed.Count)   new: $($added.Count)   to remove from game scripts: $($removed.Count)"
if ($removed.Count -gt 0) { $removed | ForEach-Object { Note "      remove  $_" } }
foreach ($top in ($folders | Where-Object { $_ -ne 'scripts' })) {
    $n = @($changed + $added | Where-Object { $_ -like "$top\*" }).Count
    Note "    $top differs in $n file(s)"
}

if ($problems.Count -gt 0) {
    Note "`n=== STOPPING: $($problems.Count) problem(s) above. Nothing was written. ==="
    exit 1
}
if ($DryRun) {
    Note "`n=== dry run finished: every check passed, nothing was written ==="
    exit 0
}

# ---------------------------------------------------------------- 5. backup, then write
Note "`n[5] Backup to $backup"
if (Test-Path -LiteralPath $backup) { Remove-Item -LiteralPath $backup -Recurse -Force }
New-Item -ItemType Directory -Path $backup | Out-Null
Copy-Item -LiteralPath (Join-Path $gameBp 'manifest.json') -Destination (Join-Path $backup 'manifest.json')
# A folder the game does not have yet (the first deploy of `dialogue`) has nothing to back up.
foreach ($f in $folders) { if (Test-Path -LiteralPath (Join-Path $gameBp $f)) { Copy-Item -LiteralPath (Join-Path $gameBp $f) -Destination (Join-Path $backup $f) -Recurse } }
foreach ($name in $pinned) {
    $dest = Join-Path (Join-Path $backup 'pins') $name
    New-Item -ItemType Directory -Path $dest -Force | Out-Null
    Copy-Item -LiteralPath (Join-Path (Join-Path $worlds $name) 'world_behavior_packs.json') -Destination $dest
}
Note "    backed up the game's manifest, scripts, items, entities, loot_tables, dialogue (where it exists) and the 4 pin files"

Note "`n[6] Bump the repo manifest"
if ($hits -eq 3) {
    Write-Utf8 $manifestPath ($manifest.Text.Replace("[$fromText]", "[$toText]")) $manifest.Bom
    Note "    $manifestPath is now $toDots"
}

Note "`n[7] Copy to the game folder"
robocopy (Join-Path $repoBp 'scripts') (Join-Path $gameBp 'scripts') /MIR /NJH /NJS /NP /NDL | Out-Null
if ($LASTEXITCODE -ge 8) { throw "robocopy scripts failed with exit code $LASTEXITCODE" }
foreach ($f in ($folders | Where-Object { $_ -ne 'scripts' })) {
    robocopy (Join-Path $repoBp $f) (Join-Path $gameBp $f) /E /NJH /NJS /NP /NDL | Out-Null
    if ($LASTEXITCODE -ge 8) { throw "robocopy $f failed with exit code $LASTEXITCODE" }
}
Copy-Item -LiteralPath $manifestPath -Destination (Join-Path $gameBp 'manifest.json') -Force
Note "    scripts mirrored, items/entities/loot_tables/dialogue merged, manifest copied"

Note "`n[8] Re-pin the worlds"
foreach ($name in $pinned) {
    $pin = Join-Path (Join-Path $worlds $name) 'world_behavior_packs.json'
    $file = Read-Utf8 $pin
    if ([regex]::Matches($file.Text, $pinPattern).Count -eq 1) {
        Write-Utf8 $pin ([regex]::Replace($file.Text, $pinPattern, ('${1}' + $toText + '${2}'))) $file.Bom
        Note "    $name  -> $toDots"
    } else { Note "    $name  already at $toDots" }
}

# ---------------------------------------------------------------- 9. verify
Note "`n[9] Verify"
$repoHashes = Get-Hashes $repoBp
$gameHashes = Get-Hashes $gameBp
$bad = @($repoHashes.Keys | Where-Object { -not $gameHashes.ContainsKey($_) -or $gameHashes[$_] -ne $repoHashes[$_] })
$extra = @($gameHashes.Keys | Where-Object { -not $repoHashes.ContainsKey($_) -and $_ -like 'scripts\*' })
if ($bad.Count -eq 0 -and $extra.Count -eq 0) { Note "    all $($repoHashes.Count) files match the repo build byte for byte, no stray script files" }
else { $bad + $extra | ForEach-Object { Problem "mismatch: $_" } }
$deployed = (Get-Content -LiteralPath (Join-Path $gameBp 'manifest.json') -Raw | ConvertFrom-Json)
Note "    game manifest header $($deployed.header.version -join '.'), modules $(($deployed.modules | ForEach-Object { $_.version -join '.' }) -join ' / ')"
foreach ($name in $pinned) {
    $text = (Read-Utf8 (Join-Path (Join-Path $worlds $name) 'world_behavior_packs.json')).Text
    $ok = [regex]::Matches($text, $pinPatternNew).Count -eq 1
    Note ("    pin {0,-14} {1}" -f $name, $(if ($ok) { "at $toDots" } else { 'NOT at the new version' }))
    if (-not $ok) { Problem "pin for $name is not at $toDots" }
}

if ($problems.Count -gt 0) { Note "`n=== FINISHED WITH $($problems.Count) PROBLEM(S) ==="; exit 1 }
Note "`n=== deployed $toDots. Rollback copy is in $backup ==="
# A successful run must say so with its exit code: without this the last robocopy's code (1 means "files were copied") leaks out
# as the script's, and a good deploy looks like a failure.
exit 0
