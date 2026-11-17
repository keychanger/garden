# Pane fork failure: "fork failed: Device not configured"

Reference for reading the next occurrence of the intermittent worker-spawn
failure `tmux respawn-pane failed: respawn pane failed: fork failed: Device not
configured`. It lists every source of that errno (ENXIO) found in the code
path, and which field of the failure-time capture
(`src/dashboard/pty-failure-capture.ts`) confirms or rules out each one. If this
doc and the code disagree, fix whichever is wrong.

## What is known

- Five clusters: 2026-09-14, 09-21, 10-04, 10-07, 11-06. Every one failed at the
  `respawn-pane -k` that replaces `newWorker`'s placeholder pane
  (`workers.ts`). The `new-window` that created the placeholder, moments earlier,
  succeeded each time.
- It is not pty exhaustion: 79/511 allocated on 10-04 and 62/511 on 11-06. The
  same placeholder-then-respawn sequence succeeded 5/5 against the same server
  minutes after the 11-06 failure, with about 65 allocated.
- The unified log had no kernel lines in the 30s around either 11-06 failure.
- Closing workers in another project made spawns succeed again.
- On 11-10 and 11-13 the failure came minutes after a reboot, during the
  attach-time resume loop (`create.ts`), and each time the tmux server
  segfaulted. The operator then saw `tmux new-window failed: no server running`.
  The crash is garden's doing, not the fork failure's. A failed `respawn-pane`
  leaves the pane's input context NULL (tmux 3.7c, `spawn_pane` returns on the
  fork-failure branch after `input_free` and before `window_pane_set_event`),
  and the capture's `retry` probe then respawned that same pane: `input_free(NULL)`,
  fault address 0x2e0, in `~/Library/Logs/DiagnosticReports/tmux-*.ips`. The
  probe was removed. **Never issue a second `respawn-pane` against a pane whose
  respawn failed to fork**; `kill-window`/`kill-pane` on it is safe
  (`window_pane_destroy` checks for NULL). Reproduced on a throwaway server
  started under a low `ulimit -n`: any fork errno poisons the pane, not only
  ENXIO. So `tmux()` (`tmux.ts`) kills the pane of any `respawn-pane` that
  fails to fork before rethrowing, which covers every caller: bounce, the loop
  respawn, and the passive panes `garden redraw` respawns. A loop worker whose
  respawn fails is put back on its merged session and marked `exited`; it
  is resumed the next time the dashboard is created (attaching to a running
  dashboard does not resume it).
- On 11-17, four minutes after a reboot, the attach-time resume loop resumed
  nine workers and then failed all eleven remaining respawns (15/511
  allocated; the throwaway-server probe failed too). The kill-pane guard held
  and the server survived. Six minutes later a throwaway probe passed and all
  eleven relaunched cleanly. Because the condition is machine-wide and clears
  on its own, a resume that fails to fork now leaves the worker `exited` with
  a `resumeRetry`. The watchdog relaunches it in a fresh window (never the
  poisoned pane) with backoff from one minute to ten, and alerts after an
  hour. `garden bounce` relaunches a paneless worker on demand.

## The code path

Sources read on 2026-11-06: xnu `main` (`bsd/kern/tty_ptmx.c`, `tty_dev.c`,
`kern_exit.c`, `bsd/vfs/vfs_subr.c`, `vfs_vnops.c`, `bsd/miscfs/devfs/devfs_tree.c`,
`specfs/spec_vnops.c`, `deadfs/dead_vnops.c`), Apple Libc `util/pty.c` and
`stdlib/grantpt.c`, and tmux `master` `spawn.c`. The shipping macOS build
(Darwin 25.6) and tmux 3.7c may differ in detail.

1. tmux `spawn_pane`, on a respawn, closes the pane's old pty master, then calls
   `fdforkpty()` and reports a `-1` return as `fork failed: <strerror(errno)>`.
   On macOS `fdforkpty` is libc `forkpty()`.
2. `forkpty()` calls `openpty()`, then `fork()`. On a `fork()` failure it closes
   both fds and restores errno.
3. `openpty()` runs, in order: `posix_openpt()` (an `open("/dev/ptmx")`),
   `grantpt()` (`ioctl TIOCPTYGRANT`), `unlockpt()` (`TIOCPTYUNLK`), `ptsname_r()`
   (`TIOCPTYGNAME`, then `stat()` of the name), and `open()` of the replica
   `/dev/ttysNNN` by name. On any failure it closes the master and restores
   errno.

`fork()` returns only EAGAIN or ENOMEM, so the ENXIO comes from one of the
`openpty()` steps, inside the tmux server process.

The kernel's pty entry points (`ptcopen`, `ptsopen`, `ptyioctl`) look up their
slot through `pty_get_ioctl`, which prints `pty_get_ioctl: driver->open
returned NULL` on every NULL result before the caller returns ENXIO. So a
failed slot lookup or allocation always prints a kernel line, whatever its
cause. This relies on kernel `printf` reaching the unified log; no test has
deliberately triggered one to confirm it.

## Candidates

| # | ENXIO source | Prints a kernel line | Confirmed by | Ruled out by |
|---|---|---|---|---|
| 1 | `ptmx_get_ioctl` at the `ptmx_max` limit | yes, two | `cause` at N/N, `kernelLog` | `cause` below the limit (true on 10-04 and 11-06) |
| 2 | `ptmx_get_ioctl` minor out of range | yes, two | `kernelLog` | `kernelLog: no kernel lines` |
| 3 | `ttymalloc` or slot-vector allocation failing in `ptmx_get_ioctl` | yes, the wrapper line | `kernelLog` | `kernelLog: no kernel lines` |
| 4 | slot lookup missing in `ptcopen`, `ptsopen`, or the grant/unlock/name ioctls (slot freed between steps) | yes, the wrapper line | `kernelLog` | `kernelLog: no kernel lines` |
| 5 | `ptyioctl` slot found with no tty | no | — | unreachable by inspection: the tty is allocated with the slot and freed only with it |
| 6 | the replica `open()` reaching a vnode revoked after lookup (`dead_open` returns ENXIO) | no | `freshOpenpty: ok`, `throwawayTmux: …ok`, with `ttysWithTwoSessions` non-empty | `freshOpenpty` failing with ENXIO (a persistent state, not a per-open race) |
| 7 | `spec_open` on a `nodev` mount or an out-of-range major | no | — | static conditions; a failure that clears without a reboot rules them out |
| 8 | sandbox or other MAC policy denying the open | Sandbox logs a `deny` kernel line | `kernelLog`; `freshOpenpty` from the same caller | errno: Sandbox returns EPERM |
| 9 | devfs clone failure, or two opens racing for one minor | — | — | errno: clone failure is ENOMEM; the race returns `EREDRIVEOPEN`, which `vn_open` retries |
| 10 | replica node missing (`devfs_make_node` failed) | yes | — | errno: `ptsname_r`'s `stat()` then fails with ENOENT |
| 11 | process limits, or fd limits in the tmux server | — | — | errno: those are EAGAIN and EMFILE; `processes`, `openFiles`, `tmuxServerFds`, and `tmuxServerNofile` record them anyway |

Candidate 6 is the only silent, per-attempt ENXIO found. What can revoke a
replica vnode is `revoke(2)` or a controlling process's exit: `proc_exit` calls
`VNOP_REVOKE(ttyvp, REVOKEALL)`, and `vn_revoke` reclaims every vnode with the
same device number, without checking that it still belongs to that session. A
session leader still referencing an old pty whose minor has since been reused
would therefore revoke the new pane's replica when it exits. The source does
not establish whether xnu frees a pty slot while a session still holds the
controlling-tty reference. `ttysWithTwoSessions` reports two session leaders
naming the same tty, which is that state. `ps` names a reused minor the same way
as its new owner, so `cttyWithoutNode` cannot see it after reuse. The respawned
placeholder's own exit is not a candidate: its slot is freed inside its own
revoke, after the alias pass has finished.

## Reading the capture

The `tmux pane creation failed; rolled back registry entry` entry carries:

| Field | What it records |
|---|---|
| `cause` | the pty count against `kern.tty.ptmx_max`, with the top holders |
| `freshOpenpty` | `script -q /dev/null true` from the spawning process: a separate process's `openpty()` |
| `throwawayTmux` | `new-session` then `respawn-pane -k` on a new tmux server (its socket in a fresh `~/.garden/control/pty-probe-*` directory), which is then killed |
| `tmuxServer`, `tmuxServerFds`, `tmuxServerNofile` | pid, uptime, version, window and pane counts; open fds and `/dev/ptmx` fds; the soft and hard NOFILE limit, read by a `run-shell` job the server forks (tmux has no rlimit code, so the job inherits the server's limit) |
| `processes`, `openFiles` | the user's and all processes against `kern.maxprocperuid` / `kern.maxproc`; `kern.num_files` against `kern.maxfiles` |
| `ptmxHolders` | `/dev/ptmx` holders totalled by command |
| `cttyWithoutNode`, `ttysWithTwoSessions` | controlling ttys with no `/dev` node; ttys with more than one session leader |

There is no re-attempt against the failed pane: that crashes the tmux server
(see "What is known"). A sibling entry, `kernel log
around pane fork failure`, follows about 6s later with the kernel lines from
30s before to 5s after the failure.

| `freshOpenpty` | `throwawayTmux` | Reading |
|---|---|---|
| ENXIO | fails | machine-wide kernel state: candidates 1–4 (check `kernelLog`) |
| ok | fails | something a fresh tmux server's fork trips on but a bare `openpty()` does not; compare `tmuxServer*` |
| ok | ok | the garden server's state or a per-attempt race: candidate 6 (check `ttysWithTwoSessions` and the `tmuxServer*` fields) |

A probe that reads `denied: … Operation not permitted` ran inside an agent
sandbox, which denies ptys and tmux sockets. It gives no answer either way.
