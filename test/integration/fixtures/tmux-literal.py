"""Drives tmux-literal.real.test.ts.

Attaches a real client to an isolated tmux server, opens each case's
display-menu or command-prompt on that client, and types the keys an operator
would press. The test asserts on what the cases' commands wrote, and on the
marker files an expanded `#(...)` would have created.
"""
import fcntl
import json
import os
import pty
import select
import signal
import struct
import subprocess
import sys
import termios
import time

config = json.loads(sys.argv[1])
socket = config["socket"]
env = dict(os.environ, TERM="xterm-256color")
env.pop("TMUX", None)


def tmux(*args):
    return subprocess.check_output(
        ["tmux", "-S", socket, *args], env=env, stderr=subprocess.STDOUT
    ).decode()


def drain(fd, duration):
    end = time.monotonic() + duration
    while time.monotonic() < end:
        if select.select([fd], [], [], max(0, end - time.monotonic()))[0]:
            try:
                os.read(fd, 65536)
            except OSError:
                return


pid = None
try:
    tmux("-f", "/dev/null", "new-session", "-d", "-s", "probe", "/bin/cat")
    pid, fd = pty.fork()
    if pid == 0:
        fcntl.ioctl(0, termios.TIOCSWINSZ, struct.pack("HHHH", 40, 160, 0, 0))
        os.execvpe("tmux", ["tmux", "-S", socket, "attach-session", "-t", "probe"], env)
    drain(fd, 0.5)
    client = tmux("list-clients", "-F", "#{client_name}").strip()
    assert client, "test terminal did not attach"
    for case in config["cases"]:
        argv = list(case["argv"])
        # display-menu and display-message name the client with -c, command-prompt with -t.
        argv[1:1] = ["-t" if argv[0] == "command-prompt" else "-c", client]
        if "capture" in case:
            with open(case["capture"], "w") as out:
                out.write(tmux(*argv))
            continue
        # display-menu blocks until the menu closes, so it runs in the background.
        proc = subprocess.Popen(["tmux", "-S", socket, *argv], env=env,
                                stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        drain(fd, 0.6)
        for keys in case["keys"]:
            os.write(fd, keys.encode())
            drain(fd, 0.6)
        try:
            proc.wait(timeout=5)
        except subprocess.TimeoutExpired:
            proc.kill()
            raise AssertionError(f"{argv[0]} did not close: {case['keys']!r}")
        # Commands the selection ran (run-shell, popups) finish asynchronously.
        drain(fd, 0.8)
finally:
    subprocess.run(["tmux", "-S", socket, "kill-server"], env=env, capture_output=True)
    if pid:
        try:
            os.kill(pid, signal.SIGTERM)
        except ProcessLookupError:
            pass
