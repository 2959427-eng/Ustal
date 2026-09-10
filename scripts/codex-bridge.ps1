<#
.SYNOPSIS
    Claude <-> Codex file-bridge watcher for the USTAL project.

.DESCRIPTION
    Polls .ai-bridge/task.json for a new task_id, validates that the current
    working directory is really the USTAL repo (git toplevel + remote check),
    then launches Codex CLI against that task, writing structured status
    (.ai-bridge/status.json), a heartbeat while it runs, per-task logs
    (.ai-bridge/logs/<task_id>.log), and a result summary
    (.ai-bridge/result.md).

    This is the MANUAL TEST VERSION (per spec item 17): run it yourself in a
    foreground PowerShell window, watch it, Ctrl+C to stop. It is NOT
    installed as a Windows service and does not start on its own.

    It never pushes to git and never touches Timeweb/production
    infrastructure itself - it only launches Codex with a text prompt; any
    git/infra actions are whatever Codex itself decides to do, still bound by
    AGENTS.md rules in the repo.

    The task prompt is delivered to Codex over stdin, not as a command-line
    argument (fixed 2026-09-08) - `codex exec` is invoked bare (no prompt in
    its argument list) and the prompt text is written to its standard input
    and the stream closed, exactly like `codex exec < prompt-file.txt` at a
    shell. This avoids Win32 command-line argument parsing entirely, which
    is what corrupted earlier long prompts containing quotes/em-dashes.

.NOTES
    Author: Claude (Cowork) - written via the file-bridge, NOT executed or
    tested here (no shell access to this machine from that session). Codex
    should be the one to actually run and validate this script, since Codex
    already has real shell access to this repo per AGENTS.md.

    $CodexCommand points at the real codex.exe path (confirmed working on
    this machine, see comment at its definition below - it is versioned and
    will need re-resolving after a Codex CLI update). $CodexArgsTemplate is
    just the subcommand ("exec") - the prompt is never part of it, see
    stdin note above. If `codex exec` on this machine turns out NOT to read
    stdin by default, check the exact error in the per-task log - do not
    guess additional flags speculatively.
#>

# ============================================================================
# CONFIG - adjust these two if needed, everything else should just work
# ============================================================================

# Repo root this watcher is scoped to. Codex is ALWAYS launched with this as
# its working directory (spec item 5).
$RepoRoot = "C:\Users\User\Desktop\ustal-foundation"

# Expected git remote substring - used to refuse to run in the wrong repo
# (spec item 4). Adjust if the remote URL differs from what's expected.
$ExpectedRemoteMatch = "2959427-eng/Ustal"

# How Codex CLI is actually invoked in non-interactive/scriptable mode.
# CONFIRMED on the real machine (2026-09-08, bridge test) - plain "codex"
# is not directly executable via Start-Process on this machine ("not a
# valid Win32 application"), so this points at the actual codex.exe. This
# path is versioned (contains a build hash) and WILL break on the next
# Codex CLI update - if the watcher later fails to launch Codex, re-resolve
# the real path (e.g. `Get-Command codex.exe` in a normal shell where the
# codex alias/PATH entry works) and update this line.
$CodexCommand = "C:\Users\User\AppData\Local\OpenAI\Codex\bin\8e5b6932251c2c1c\codex.exe"
# 2026-09-08 fix: the prompt is NO LONGER embedded in this argument string.
# Long prompts containing embedded double quotes, em-dashes and other
# special characters broke .NET's Win32 command-line argument parsing when
# passed as part of a single -Arguments string (Process.ExitCode -f-style
# interpolation confirmed to corrupt/split arguments -> Codex received a
# mangled prompt and failed with "error: unexpected argument '-' found").
# .NET Framework 4.x (what Windows PowerShell 5.1's ProcessStartInfo uses)
# has no array-based ArgumentList to sidestep this safely, so instead the
# prompt is now piped to Codex over stdin (see the launch section below) -
# $CodexArgsTemplate holds ONLY the subcommand, nothing prompt-related.
$CodexArgsTemplate = "exec"

# Bump this string any time this script's logic changes in a way that
# matters for an already-running watcher instance. Root cause of the
# 2026-09-08 round-2 bug: PowerShell parses the WHOLE script body into
# memory once, at the moment you launch it (`.\codex-bridge.ps1`) - editing
# the .ps1 file on disk afterwards does NOT affect a watcher that is already
# running, since it keeps executing the old in-memory script text. The
# stdin-based prompt delivery fix was correct on disk, but a watcher window
# that had been started BEFORE that fix was still passing the full prompt
# as a command-line argument to codex.exe, purely because it had not been
# restarted. If codex-bridge ever behaves like an older version despite the
# file on disk looking correct, this is almost always why - stop the
# watcher (Ctrl+C in its PowerShell window) and start it again with
# `.\scripts\codex-bridge.ps1` so it re-reads the current file. The version
# string below is printed at startup precisely so this is easy to confirm
# at a glance instead of having to re-diagnose it from scratch.
$ScriptVersion = "2026-09-08-r2-stdin-only-args"

# Poll interval for detecting a new task.json (seconds).
$PollIntervalSeconds = 5

# Heartbeat interval while Codex is running (seconds) - spec item 14 asks
# for 10-30s; 15s is the middle of that range.
$HeartbeatIntervalSeconds = 15

# ============================================================================
# Paths (derived, no need to touch)
# ============================================================================

$BridgeDir      = Join-Path $RepoRoot ".ai-bridge"
$TaskFile       = Join-Path $BridgeDir "task.json"
$StatusFile     = Join-Path $BridgeDir "status.json"
$ResultFile     = Join-Path $BridgeDir "result.md"
$LogsDir        = Join-Path $BridgeDir "logs"
$ProcessedFile  = Join-Path $BridgeDir "processed_tasks.json"

# ============================================================================
# Helpers
# ============================================================================

function Get-Utc {
    (Get-Date).ToUniversalTime().ToString("yyyy-MM-ddTHH:mm:ssZ")
}

function Write-StatusJson {
    param([hashtable]$Status)
    # Always write the full object - status.json is a snapshot, not a log.
    $Status | ConvertTo-Json -Depth 5 | Set-Content -Path $StatusFile -Encoding UTF8
}

function Get-ProcessedTaskIds {
    if (Test-Path $ProcessedFile) {
        try {
            $raw = Get-Content $ProcessedFile -Raw -Encoding UTF8 | ConvertFrom-Json
            return @($raw)
        } catch {
            Write-Warning "processed_tasks.json unreadable, treating as empty: $_"
            return @()
        }
    }
    return @()
}

function Add-ProcessedTaskId {
    param([string]$TaskId)
    $ids = Get-ProcessedTaskIds
    $ids = @($ids) + $TaskId | Select-Object -Unique
    $ids | ConvertTo-Json | Set-Content -Path $ProcessedFile -Encoding UTF8
}

function Test-UstalRepo {
    <#
    Spec item 3-4: verify this is really the USTAL repo before launching
    Codex. Returns $true/$false; on failure the caller writes status=error
    and does NOT launch Codex.
    #>
    param([string]$Path)

    Push-Location $Path
    try {
        $toplevel = (git rev-parse --show-toplevel 2>$null)
        if ($LASTEXITCODE -ne 0 -or -not $toplevel) {
            Write-Warning "git rev-parse --show-toplevel failed in $Path"
            return $false
        }

        $remotes = (git remote -v 2>$null)
        if ($LASTEXITCODE -ne 0 -or -not ($remotes -match [regex]::Escape($ExpectedRemoteMatch))) {
            Write-Warning "git remote does not look like USTAL (expected to contain '$ExpectedRemoteMatch'):`n$remotes"
            return $false
        }

        $branch = (git branch --show-current 2>$null)
        if ($LASTEXITCODE -ne 0) {
            Write-Warning "git branch --show-current failed in $Path"
            return $false
        }

        Write-Host "Repo check OK - toplevel=$toplevel branch=$branch"
        return $true
    } finally {
        Pop-Location
    }
}

function Append-ResultMd {
    param(
        [string]$TaskId,
        [string]$State,
        [Nullable[int]]$ExitCode,
        [string]$StartedAt,
        [string]$FinishedAt,
        [string]$LogPath,
        [string]$PromptSummary
    )
    # New entries on top, like AI_HANDOFF.md's own convention in this repo -
    # keeps result.md skimmable without scrolling through history.
    $entry = @"
## $TaskId - $State ($(Get-Utc))

- prompt: $PromptSummary
- started_at: $StartedAt
- finished_at: $FinishedAt
- exit_code: $ExitCode
- log: $LogPath

---

"@
    $existing = ""
    if (Test-Path $ResultFile) {
        $existing = Get-Content $ResultFile -Raw -Encoding UTF8
    }
    Set-Content -Path $ResultFile -Value ($entry + $existing) -Encoding UTF8
}

# ============================================================================
# Main watcher loop
# ============================================================================

if (-not (Test-Path $BridgeDir))  { New-Item -ItemType Directory -Path $BridgeDir | Out-Null }
if (-not (Test-Path $LogsDir))    { New-Item -ItemType Directory -Path $LogsDir | Out-Null }

Write-Host "=== Claude<->Codex bridge watcher ==="
Write-Host "Script version: $ScriptVersion"
Write-Host "  (this is the version of the SCRIPT TEXT this running instance"
Write-Host "   loaded at startup - editing codex-bridge.ps1 while this window"
Write-Host "   keeps running does NOT change its behavior; stop it with"
Write-Host "   Ctrl+C and re-run .\scripts\codex-bridge.ps1 to pick up edits.)"
Write-Host "Repo:      $RepoRoot"
Write-Host "Watching:  $TaskFile"
Write-Host "Poll every $PollIntervalSeconds s. Ctrl+C to stop."
Write-Host ""

# Initial idle status so status.json always exists and reflects reality even
# before the first task arrives.
Write-StatusJson @{
    task_id     = $null
    state       = "idle"
    cwd         = $RepoRoot
    pid         = $null
    started_at  = $null
    last_update = (Get-Utc)
    finished_at = $null
    exit_code   = $null
    error       = $null
}

$lastSeenTaskId = $null

while ($true) {
    Start-Sleep -Seconds $PollIntervalSeconds

    if (-not (Test-Path $TaskFile)) { continue }

    try {
        # -Encoding UTF8 forces correct reading regardless of whether task.json
        # was saved with or without a BOM (Windows PowerShell 5.1 otherwise
        # falls back to the system codepage for BOM-less files, which garbles
        # Cyrillic prompt text without necessarily throwing an error).
        $task = Get-Content $TaskFile -Raw -Encoding UTF8 | ConvertFrom-Json
    } catch {
        Write-Warning "task.json is not valid JSON, skipping this poll: $_"
        continue
    }

    if (-not $task.task_id) {
        Write-Warning "task.json has no task_id, skipping."
        continue
    }

    # Spec item 2/13: unique task_id, refuse to re-run one already processed.
    if ($task.task_id -eq $lastSeenTaskId) { continue }               # already handled this poll-loop pass
    if ((Get-ProcessedTaskIds) -contains $task.task_id) {
        Write-Host "Task $($task.task_id) already processed - skipping (dedup)."
        $lastSeenTaskId = $task.task_id
        continue
    }

    $lastSeenTaskId = $task.task_id
    $taskId  = $task.task_id
    $prompt  = [string]$task.prompt
    $logPath = Join-Path $LogsDir "$taskId.log"

    Write-Host ""
    Write-Host ">>> New task detected: $taskId"

    # --- Pre-flight repo check (spec item 3-4) ---
    Write-StatusJson @{
        task_id     = $taskId
        state       = "starting"
        cwd         = $RepoRoot
        pid         = $null
        started_at  = (Get-Utc)
        last_update = (Get-Utc)
        finished_at = $null
        exit_code   = $null
        error       = $null
    }

    if (-not (Test-UstalRepo -Path $RepoRoot)) {
        Write-StatusJson @{
            task_id     = $taskId
            state       = "error"
            cwd         = $RepoRoot
            pid         = $null
            started_at  = (Get-Utc)
            last_update = (Get-Utc)
            finished_at = (Get-Utc)
            exit_code   = $null
            error       = "Repo check failed - not USTAL, or git commands failed. Codex was NOT launched."
        }
        Append-ResultMd -TaskId $taskId -State "error" -ExitCode $null `
            -StartedAt (Get-Utc) -FinishedAt (Get-Utc) -LogPath $logPath `
            -PromptSummary "(repo check failed, Codex not launched)"
        Add-ProcessedTaskId -TaskId $taskId
        continue
    }

    # --- Launch Codex (spec item 5-8) ---
    $startedAt = Get-Utc
    $codexArgs = $CodexArgsTemplate

    # 2026-09-08 fix: write the prompt to its own UTF-8 file instead of
    # embedding it in the process's command-line argument string. Long
    # prompts with embedded double quotes / em-dashes / newlines were
    # getting corrupted or split into extra arguments by Win32 command-line
    # parsing when passed as a single -Arguments string, and Codex failed
    # with errors like "error: unexpected argument '-' found". No manual
    # quote-escaping here - the prompt is delivered to Codex over stdin
    # (see below), so it never has to survive command-line parsing at all.
    # The file itself is kept (not deleted) purely for audit/debugging,
    # same as the per-task log.
    $promptFile = Join-Path $BridgeDir "prompt-$taskId.txt"
    $utf8NoBom = New-Object System.Text.UTF8Encoding($false)
    [System.IO.File]::WriteAllText($promptFile, $prompt, $utf8NoBom)

    "=== task_id: $taskId ===" | Out-File -FilePath $logPath -Encoding UTF8
    "=== started: $startedAt ===" | Out-File -FilePath $logPath -Append -Encoding UTF8
    # 2026-09-08 fix (round 2): log Executable and Arguments as their own
    # separate lines, written BEFORE Start(), so a real per-task log always
    # proves exactly what got passed as the process command line - with
    # nothing else appended after "exec". This is intentionally NOT a single
    # interpolated "command: ..." line anymore, so there is no way for the
    # prompt text to end up appended onto the same line as Arguments by a
    # future edit mistake. The prompt itself is never logged here at all -
    # it goes to $promptFile (for audit) and to Codex's stdin only.
    "Executable: $CodexCommand" | Out-File -FilePath $logPath -Append -Encoding UTF8
    "Arguments: $codexArgs" | Out-File -FilePath $logPath -Append -Encoding UTF8
    "(prompt is NOT part of Arguments - piped via stdin from $promptFile)" | Out-File -FilePath $logPath -Append -Encoding UTF8
    "" | Out-File -FilePath $logPath -Append -Encoding UTF8

    # 2026-09-08: Start-Process -PassThru + WaitForExit() proved unreliable
    # for reading ExitCode on this machine - confirmed across three separate
    # bridge tests where Codex genuinely ran and finished, but
    # $proc.ExitCode stayed $null even after WaitForExit(). Per the fix
    # request, switched straight to driving System.Diagnostics.Process
    # directly via ProcessStartInfo instead of Start-Process - this reads
    # ExitCode straight off the OS process handle and does not go through
    # Start-Process's own (apparently unreliable, on this machine) wrapper.
    $stdoutSb = New-Object System.Text.StringBuilder
    $stderrSb = New-Object System.Text.StringBuilder
    $stdoutEvent = $null
    $stderrEvent = $null

    try {
        $psi = New-Object System.Diagnostics.ProcessStartInfo
        $psi.FileName               = $CodexCommand
        $psi.Arguments              = $codexArgs
        $psi.WorkingDirectory       = $RepoRoot
        $psi.UseShellExecute        = $false
        $psi.RedirectStandardOutput = $true
        $psi.RedirectStandardError  = $true
        # 2026-09-08 fix: the prompt goes to Codex over stdin, not as a
        # command-line argument (see comment above the prompt-file write).
        $psi.RedirectStandardInput  = $true
        $psi.CreateNoWindow         = $true
        # Decode the child's stdout/stderr bytes as UTF-8 explicitly, same
        # reasoning as the -Encoding UTF8 reads elsewhere in this script -
        # otherwise .NET falls back to the system console codepage, which
        # is what corrupted Cyrillic output in an earlier bridge test.
        $psi.StandardOutputEncoding = [System.Text.Encoding]::UTF8
        $psi.StandardErrorEncoding  = [System.Text.Encoding]::UTF8

        $proc = New-Object System.Diagnostics.Process
        $proc.StartInfo = $psi
        $proc.EnableRaisingEvents = $true

        # Async line-based readers, required to avoid a classic deadlock
        # where the child blocks writing to a full stdout/stderr pipe while
        # this script is synchronously waiting on the other stream (or on
        # the process itself). Output accumulates in memory and is written
        # to $logPath once the process has fully exited, below.
        $stdoutEvent = Register-ObjectEvent -InputObject $proc -EventName OutputDataReceived -Action {
            if ($null -ne $Event.SourceEventArgs.Data) {
                $Event.MessageData.AppendLine($Event.SourceEventArgs.Data) | Out-Null
            }
        } -MessageData $stdoutSb

        $stderrEvent = Register-ObjectEvent -InputObject $proc -EventName ErrorDataReceived -Action {
            if ($null -ne $Event.SourceEventArgs.Data) {
                $Event.MessageData.AppendLine($Event.SourceEventArgs.Data) | Out-Null
            }
        } -MessageData $stderrSb

        [void]$proc.Start()
        # Capture PID immediately, into a plain int, not a live reference
        # into $proc. 2026-09-08 fix: the previous version read $proc.Id in
        # the final status/result write AFTER $proc.Dispose() below, which
        # silently produced pid=null (Process throws/no-ops on property
        # access once disposed) even though the task otherwise completed
        # correctly (exit_code=0, state=completed). Capturing it here once,
        # right after Start(), removes the ordering dependency entirely.
        $codexPid = $proc.Id
        # 2026-09-08 fix (round 2): PID logged into the per-task log file
        # itself too, not only status.json/Write-Host - spec item 10.
        "PID: $codexPid" | Out-File -FilePath $logPath -Append -Encoding UTF8
        "" | Out-File -FilePath $logPath -Append -Encoding UTF8
        $proc.BeginOutputReadLine()
        $proc.BeginErrorReadLine()

        # Pipe the prompt to Codex over stdin, not as a command-line
        # argument (2026-09-08 fix request). Writing raw UTF-8 bytes
        # directly to the underlying stream - rather than
        # through $proc.StandardInput's StreamWriter, whose encoding is not
        # guaranteed to be UTF-8 on Windows PowerShell 5.1/.NET Framework -
        # guarantees Codex receives exactly the same bytes on the wire that
        # were written to $promptFile above, Cyrillic and all. Closing the
        # stream signals end-of-input, equivalent to `codex exec <
        # prompt-file.txt` at a shell.
        $promptBytes = $utf8NoBom.GetBytes($prompt)
        $proc.StandardInput.BaseStream.Write($promptBytes, 0, $promptBytes.Length)
        $proc.StandardInput.BaseStream.Flush()
        $proc.StandardInput.Close()
    } catch {
        if ($stdoutEvent) { Unregister-Event -SourceIdentifier $stdoutEvent.Name -ErrorAction SilentlyContinue }
        if ($stderrEvent) { Unregister-Event -SourceIdentifier $stderrEvent.Name -ErrorAction SilentlyContinue }
        Write-StatusJson @{
            task_id     = $taskId
            state       = "error"
            cwd         = $RepoRoot
            pid         = $null
            started_at  = $startedAt
            last_update = (Get-Utc)
            finished_at = (Get-Utc)
            exit_code   = $null
            error       = "Failed to launch Codex: $_"
        }
        Append-ResultMd -TaskId $taskId -State "error" -ExitCode $null `
            -StartedAt $startedAt -FinishedAt (Get-Utc) -LogPath $logPath `
            -PromptSummary "(failed to launch Codex - check `$CodexCommand config at top of script)"
        Add-ProcessedTaskId -TaskId $taskId
        continue
    }

    Write-StatusJson @{
        task_id     = $taskId
        state       = "running"
        cwd         = $RepoRoot
        pid         = $codexPid
        started_at  = $startedAt
        last_update = (Get-Utc)
        finished_at = $null
        exit_code   = $null
        error       = $null
    }
    Write-Host "Codex launched - PID $codexPid, logging to $logPath"

    # --- Heartbeat while running (spec item 14) ---
    # WaitForExit(timeoutMs) blocks up to the heartbeat interval and returns
    # $true only once the process has actually exited AND the CLR has fully
    # synchronized its state - this part of the pattern already worked
    # correctly in the previous fix; the unreliable piece was specifically
    # Start-Process's own ExitCode property, now removed entirely.
    while (-not $proc.WaitForExit($HeartbeatIntervalSeconds * 1000)) {
        Write-StatusJson @{
            task_id     = $taskId
            state       = "running"
            cwd         = $RepoRoot
            pid         = $codexPid
            started_at  = $startedAt
            last_update = (Get-Utc)
            finished_at = $null
            exit_code   = $null
            error       = $null
        }
    }
    # Parameterless WaitForExit() blocks until the process has truly exited
    # AND all buffered redirected output has been delivered to the async
    # event handlers above - required before ExitCode/output are safe to
    # read.
    $proc.WaitForExit()

    Unregister-Event -SourceIdentifier $stdoutEvent.Name -ErrorAction SilentlyContinue
    Unregister-Event -SourceIdentifier $stderrEvent.Name -ErrorAction SilentlyContinue

    # --- Completion (spec item 9) ---
    # $proc.ExitCode here comes straight from System.Diagnostics.Process,
    # which always returns a real int once WaitForExit() has returned - no
    # Start-Process wrapper involved, so no more silent nulls.
    $exitCode  = $proc.ExitCode
    $finishedAt = Get-Utc
    $finalState = if ($exitCode -eq 0) { "completed" } else { "failed" }

    "=== stdout ===" | Out-File -FilePath $logPath -Append -Encoding UTF8
    $stdoutSb.ToString() | Out-File -FilePath $logPath -Append -Encoding UTF8
    "=== stderr ===" | Out-File -FilePath $logPath -Append -Encoding UTF8
    $stderrSb.ToString() | Out-File -FilePath $logPath -Append -Encoding UTF8
    "" | Out-File -FilePath $logPath -Append -Encoding UTF8
    "=== finished: $finishedAt (exit $exitCode) ===" | Out-File -FilePath $logPath -Append -Encoding UTF8

    Write-StatusJson @{
        task_id     = $taskId
        state       = $finalState
        cwd         = $RepoRoot
        pid         = $codexPid
        started_at  = $startedAt
        last_update = $finishedAt
        finished_at = $finishedAt
        exit_code   = $exitCode
        error       = $null
    }

    $promptSummary = if ($prompt.Length -gt 140) { $prompt.Substring(0, 140) + "..." } else { $prompt }
    Append-ResultMd -TaskId $taskId -State $finalState -ExitCode $exitCode `
        -StartedAt $startedAt -FinishedAt $finishedAt -LogPath $logPath `
        -PromptSummary $promptSummary

    Add-ProcessedTaskId -TaskId $taskId
    Write-Host "<<< Task $taskId finished: $finalState (exit $exitCode)"

    # Dispose only now, once nothing below needs $proc anymore - keeps the
    # PID-ordering bug above from having any equivalent elsewhere.
    $proc.Dispose()
}
